import { create } from 'zustand';
import { api } from '../lib/api';
import { PITCH_MIN, PITCH_MAX } from '../lib/constants';
import { audioBufferCache, cacheBuffer, clearAudioCaches } from '../lib/audio';
import { getCtx, getMaster, getMasterFader, getAnalyser as getAnalyserNode, safeStop } from './audio/graph';
import { save as saveArrangement, load as loadArrangement } from './audio/arrangement';
import { cloneBuffer, loopBufferToLength, splitBufferAt } from './audio/bufferOps';
import type { LoadedTrack, UndoSnapshot } from './audio/types';
import { adaptiveStretch, type SampleCharacter } from '../lib/stretch';

/**
 * Pick the playable buffer for a sample with a detected BPM at a given
 * project BPM. Passes through (cheap, no DSP) when the two tempos agree or
 * when we lack the data to stretch. Cap at 2x either direction — WSOLA
 * artifacts stack past that and the result sounds worse than unstretched.
 * Character + beats metadata route us into transient-preserving stretch
 * for percussive samples and larger-frame WSOLA for tonal ones.
 */
function stretchForProject(
  originalBuffer: AudioBuffer,
  detectedBpm: number | undefined,
  projectBpm: number,
  meta: { character?: SampleCharacter; beats?: number[] } = {},
): AudioBuffer {
  if (!detectedBpm || detectedBpm <= 0 || projectBpm <= 0) return originalBuffer;
  const factor = detectedBpm / projectBpm;
  if (factor < 0.5 || factor > 2) return originalBuffer;
  if (Math.abs(factor - 1) < 0.005) return originalBuffer;
  try {
    return adaptiveStretch(originalBuffer, factor, getCtx(), meta);
  } catch {
    return originalBuffer;
  }
}

/**
 * Pitch-preserving playback build. Combines warp stretch + pitch
 * compensation into ONE pass over the original buffer:
 *   warpFactor  = sourceBpm / projectBpm (or 1 if warp off / no data)
 *   pitchFactor = 2^(semitones / 12)
 *   stretchFactor = warpFactor * pitchFactor
 *
 * The buffer ends up `pitchFactor` longer than the warped length; at
 * playback time the source is run at `playbackRate = pitchFactor` so the
 * resample shifts the pitch but the OUTPUT duration is just the warped
 * length again — i.e. pitching down doesn't slow the clip down. Falls
 * back to the original buffer when the combined factor is too extreme
 * for WSOLA to handle gracefully.
 */
interface PlayBufferResult { buffer: AudioBuffer; playbackRate: number }

/**
 * The clip's effective duration in PROJECT TIME, accounting for the
 * pitch-compensation pre-stretch + matching playbackRate. This is what
 * every visual / timing calculation should use — not buffer.duration —
 * so pitching a clip doesn't change its visual width on the timeline.
 */
export function getEffectiveDuration(track: { buffer?: AudioBuffer; pitch?: number }): number {
  if (!track.buffer) return 0;
  const playbackRate = Math.pow(2, (track.pitch || 0) / 12);
  return track.buffer.duration / Math.max(0.0001, playbackRate);
}

// Memoise stretched buffers per (originalBuffer, factor, character, beats).
// Two clips that share the same source file and the same effective stretch
// factor end up pointing at the SAME AudioBuffer — identical waveforms,
// no per-clip variance, and one stretch pass instead of N. WeakMap keyed
// on the original buffer means cache entries drop the moment the buffer
// itself is GC'd.
const stretchCache = new WeakMap<AudioBuffer, Map<string, AudioBuffer>>();
function cachedAdaptiveStretch(
  original: AudioBuffer,
  factor: number,
  meta: { character?: SampleCharacter; beats?: number[] },
): AudioBuffer {
  const key = `${factor.toFixed(6)}|${meta.character || ''}|${(meta.beats?.length ?? 0)}`;
  let inner = stretchCache.get(original);
  if (!inner) { inner = new Map(); stretchCache.set(original, inner); }
  const hit = inner.get(key);
  if (hit) return hit;
  const result = adaptiveStretch(original, factor, getCtx(), meta);
  inner.set(key, result);
  return result;
}
function composePlayBuffer(
  track: { originalBuffer?: AudioBuffer; bpm?: number; detectedBpm?: number; warp?: boolean; pitch?: number; character?: SampleCharacter; beats?: number[]; buffer: AudioBuffer },
  projectBpm: number,
): PlayBufferResult {
  const pitchFactor = Math.pow(2, (track.pitch || 0) / 12);
  if (!track.originalBuffer) return { buffer: track.buffer, playbackRate: pitchFactor };
  const sourceBpm = (track.bpm && track.bpm > 0) ? track.bpm : track.detectedBpm;
  const warpActive = track.warp !== false && !!sourceBpm && sourceBpm > 0 && projectBpm > 0;
  const warpFactor = warpActive ? (sourceBpm! / projectBpm) : 1;
  const stretchFactor = warpFactor * pitchFactor;
  // Only run WSOLA if the stretch is meaningful — anything inside ±2% is
  // imperceptible in tempo terms and not worth the spectral artefacts a
  // time-stretch always introduces. Same bail-out at extreme ratios where
  // WSOLA breaks down (use the source as-is plus playbackRate).
  if (Math.abs(stretchFactor - 1) < 0.02 || stretchFactor < 0.4 || stretchFactor > 2.5) {
    return { buffer: track.originalBuffer, playbackRate: pitchFactor };
  }
  try {
    const buffer = cachedAdaptiveStretch(track.originalBuffer, stretchFactor, {
      character: track.character, beats: track.beats,
    });
    return { buffer, playbackRate: pitchFactor };
  } catch {
    return { buffer: track.originalBuffer, playbackRate: pitchFactor };
  }
}

export function getAnalyser(): AnalyserNode | null {
  return getAnalyserNode();
}

// Offsets to apply when a track first lands in the store via
// loadTrack / loadTrackFromBuffer. Used by the duplicate flow so the new clip
// arrives at the intended position instead of defaulting to 0 and overlapping
// the original before the async seeder catches up.
export const pendingTrackOffsets = new Map<string, number>();

// Pending per-clip state for tracks that are about to land in the store
// via loadTrackFromBuffer. Used by Duplicate / Ctrl+V paste so the new
// clip inherits its source's volume / pitch / mute / warp / BPM override
// / trim / pan instead of resetting to defaults.
export interface PendingTrackProps {
  volume?: number;
  muted?: boolean;
  soloed?: boolean;
  pitch?: number;
  bpm?: number;
  warp?: boolean;
  trimStart?: number;
  trimEnd?: number;
}
export const pendingTrackProps = new Map<string, PendingTrackProps>();

interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  projectBpm: number;
  // Master fader gain (0..1.5). Applied to the masterGain node in graph.ts
  // and persisted globally so the user's mix level survives across
  // projects and sessions.
  masterVolume: number;
  setMasterVolume: (v: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  bufferVersion: number;
  loadedTracks: Map<string, LoadedTrack>;
  soloActive: boolean;
  soloPlayingTrackId: string | null;
  soloCurrentTime: number;
  soloDuration: number;
  loadError: string | null;
  // Currently-selected clip ids. Drives the green ring on every selected
  // LaneClip and is the working set for Ctrl+C / Ctrl+V / Ctrl+X / Delete.
  // A single click replaces the set, Shift/Ctrl+click adds-or-toggles, and
  // marquee drag in empty arrangement space replaces with intersected clips.
  selectedTrackIds: Set<string>;
  setSelectedTrackIds: (ids: Iterable<string>) => void;
  toggleTrackSelection: (id: string) => void;
  addTrackToSelection: (id: string) => void;
  clearSelection: () => void;
  // Live group drag — while a clip in a multi-selection is being dragged,
  // every LaneClip in `groupDragIds` renders its position as
  //   displayOffset = track.startOffset + groupDragDelta
  // so the whole group visually moves as one. On pointerup the initiator
  // commits the real offsets and these fields reset to empty/0.
  groupDragIds: Set<string>;
  groupDragDelta: number;
  setGroupDrag: (ids: Iterable<string>, delta: number) => void;
  endGroupDrag: () => void;
  // Lane order — array of lane keys (fileId per the lanes-grouping rule).
  // Lives in the arrangement blob so every collaborator sees the same
  // vertical arrangement; persisted to server alongside clip positions.
  laneOrder: string[];
  setLaneOrder: (order: string[]) => void;
  // Grid snap subdivision — fraction of a bar. 1 = whole bar, 0.25 = quarter
  // note, 0.125 = eighth note, 0.0625 = sixteenth note. Drives every snap-
  // to-grid call across the arrangement (clip drag, paste, duplicate, trim).
  gridDivision: number;
  setGridDivision: (divisionOfBar: number) => void;

  loadTrack: (trackId: string, fileId: string, projectId: string, trackBpm?: number) => Promise<void>;
  loadTrackFromBuffer: (
    trackId: string,
    buffer: AudioBuffer,
    trackBpm?: number,
    detectedBpm?: number,
    firstBeatOffset?: number,
    beats?: number[],
    character?: SampleCharacter,
  ) => void;
  unloadTrack: (trackId: string) => void;
  setProjectBpm: (bpm: number) => void;
  restretchAllTracks: () => void;
  setTrackBpm: (trackId: string, bpm: number) => void;
  setTrackWarp: (trackId: string, warp: boolean) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (time: number) => void;
  playSoloTrack: (trackId: string) => void;
  stopSoloTrack: () => void;
  setTrackVolume: (trackId: string, volume: number) => void;
  setTrackMuted: (trackId: string, muted: boolean) => void;
  removeTrack: (trackId: string) => void;
  loopTrackToFill: (trackId: string, fileId?: string) => void;
  undo: () => void;
  redo: () => void;
  setTrackSoloed: (trackId: string, soloed: boolean) => void;
  setTrackPitch: (trackId: string, semitones: number) => void;
  setTrackTrim: (trackId: string, trimStart: number, trimEnd: number) => void;
  setTrackWarpMarkers: (trackId: string, markers: number[]) => void;
  setTrackOffset: (trackId: string, offset: number) => void;
  duplicateTrack: (trackId: string) => string | null;
  splitTrack: (trackId: string, atTime: number) => string | null;
  saveArrangementState: (projectId: string, serverTrackFileIds: Map<string, string>) => void;
  restoreArrangementState: (projectId: string, serverTrackFileIds: Map<string, string>) => void;
  // Build the current arrangement as a serialisable blob without persisting.
  // Used by TransportBar to sync to the server.
  buildArrangementState: (serverTrackFileIds: Map<string, string>) => { clips: any[] };
  // Apply a server-provided arrangement blob. Mirrors restoreArrangementState
  // but takes the clips directly instead of reading localStorage.
  applyArrangementClips: (clips: any[]) => void;
  cleanup: () => void;
}

let startedAt = 0;
let pausedAt = 0;
let rafId: number | null = null;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
const undoStack: UndoSnapshot[] = [];
const redoStack: UndoSnapshot[] = [];
let soloSource: AudioBufferSourceNode | null = null;
let soloGain: GainNode | null = null;
let soloStartedAt = 0;
let soloRafId: number | null = null;

export const useAudioStore = create<AudioState>((set, get) => {

  function recalcDuration() {
    const { loadedTracks } = get();
    let maxDur = 0;
    loadedTracks.forEach((t) => {
      const trackEnd = t.startOffset + getEffectiveDuration(t);
      if (trackEnd > maxDur) maxDur = trackEnd;
    });
    set({ duration: maxDur });
  }

  function updatePosition() {
    const ctx = getCtx();
    if (!get().isPlaying) return;
    const elapsed = ctx.currentTime - startedAt;
    const dur = get().duration;
    if (dur > 0 && elapsed >= dur) {
      // Loop: restart sources from bar 1 and keep the RAF running so the
      // playhead wraps back to 0 instead of freezing at the end.
      set({ currentTime: 0 });
      startAllSources(0);
    } else {
      set({ currentTime: elapsed });
    }
    rafId = requestAnimationFrame(updatePosition);
  }

  function startAllSources(offset: number) {
    const ctx = getCtx();
    const { loadedTracks } = get();

    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }

    loadedTracks.forEach((track) => {
      safeStop(track.source);
      // Disconnect any prior analyser so the OLD node doesn't keep showing
      // a frozen reading after we restart playback.
      if (track.analyser) { try { track.analyser.disconnect(); } catch { /* ignore */ } }

      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      // Pitch is applied via playbackRate (resample) BUT the buffer was
      // pre-stretched by the same factor in composePlayBuffer, so the
      // OUTPUT duration is preserved — pitching down doesn't slow the
      // clip down anymore.
      source.playbackRate.value = Math.pow(2, (track.pitch || 0) / 12);
      source.loop = false;

      const gain = ctx.createGain();
      gain.gain.value = track.muted ? 0 : track.volume;
      // Audio path is short and direct: source → gain → mixer bus. No
      // node sits between the gain stage and the bus that could colour
      // the signal.
      source.connect(gain);
      gain.connect(getMaster());
      // Meter tap — branches off the gain in PARALLEL so it does not sit
      // in the audio path. AnalyserNode is spec'd as transparent but
      // every node in series adds a render-quantum of latency and a
      // numerical pass; keeping the path clean was the cleanest fix for
      // the "filtered" sound.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      gain.connect(analyser);
      track.analyser = analyser;

      const trimStart = track.trimStart;
      const trimEnd = track.trimEnd > 0 ? track.trimEnd : track.buffer.duration;
      const trimDuration = trimEnd - trimStart;
      const trackStartsAt = track.startOffset;
      const projectTime = offset;

      track.source = source;
      track.gainNode = gain;

      if (projectTime >= trackStartsAt) {
        const elapsed = projectTime - trackStartsAt;
        if (elapsed >= trimDuration) return;
        source.start(0, trimStart + elapsed, trimDuration - elapsed);
      } else {
        const delay = trackStartsAt - projectTime;
        source.start(ctx.currentTime + delay, trimStart, trimDuration);
      }
    });

    startedAt = ctx.currentTime - offset;
    updateSoloState();
  }

  function stopAllSources() {
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    const { loadedTracks } = get();
    loadedTracks.forEach((track) => {
      if (track.source) {
        safeStop(track.source);
        track.source = null;
        track.gainNode = null;
      }
      if (track.analyser) { try { track.analyser.disconnect(); } catch { /* ignore */ } track.analyser = null; }
    });
  }

  function updateSoloState() {
    const { loadedTracks } = get();
    const anySoloed = Array.from(loadedTracks.values()).some((t) => t.soloed);
    set({ soloActive: anySoloed });

    loadedTracks.forEach((track) => {
      if (track.gainNode) {
        if (track.muted) {
          track.gainNode.gain.value = 0;
        } else if (anySoloed) {
          track.gainNode.gain.value = track.soloed ? track.volume : 0;
        } else {
          track.gainNode.gain.value = track.volume;
        }
      }
    });
  }

  function restartIfPlaying() {
    const wasPlaying = get().isPlaying;
    if (wasPlaying) {
      const ctx = getCtx();
      const currentOffset = ctx.currentTime - startedAt;
      stopAllSources();
      if (rafId) cancelAnimationFrame(rafId);
      startAllSources(currentOffset);
      set({ isPlaying: true });
      rafId = requestAnimationFrame(updatePosition);
    }
    recalcDuration();
  }

  function stopSolo() {
    safeStop(soloSource);
    soloSource = null;
    if (soloGain) { soloGain.disconnect(); soloGain = null; }
    if (soloRafId) { cancelAnimationFrame(soloRafId); soloRafId = null; }
  }

  return {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    projectBpm: 0,
    masterVolume: (() => {
      try {
        const raw = window.localStorage?.getItem('ghost_master_volume');
        const v = raw ? parseFloat(raw) : NaN;
        return isFinite(v) && v >= 0 && v <= 1.5 ? v : 1;
      } catch { return 1; }
    })(),
    setMasterVolume: (v) => {
      const clamped = Math.max(0, Math.min(1.5, v));
      const fader = getMasterFader();
      // Smooth the gain change so the slider doesn't zipper. 30 ms ramp
      // is below the perception threshold but still removes the artifact.
      try {
        fader.gain.cancelScheduledValues(getCtx().currentTime);
        fader.gain.linearRampToValueAtTime(clamped, getCtx().currentTime + 0.03);
      } catch { fader.gain.value = clamped; }
      try { window.localStorage?.setItem('ghost_master_volume', String(clamped)); } catch {}
      set({ masterVolume: clamped });
    },
    canUndo: false,
    canRedo: false,
    bufferVersion: 0,
    loadedTracks: new Map(),
    soloActive: false,
    soloPlayingTrackId: null,
    soloCurrentTime: 0,
    soloDuration: 0,
    loadError: null,
    selectedTrackIds: new Set<string>(),
    setSelectedTrackIds: (ids) => set({ selectedTrackIds: new Set(ids) }),
    toggleTrackSelection: (id) => set((s) => {
      const next = new Set(s.selectedTrackIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { selectedTrackIds: next };
    }),
    addTrackToSelection: (id) => set((s) => {
      if (s.selectedTrackIds.has(id)) return {};
      const next = new Set(s.selectedTrackIds);
      next.add(id);
      return { selectedTrackIds: next };
    }),
    clearSelection: () => set({ selectedTrackIds: new Set() }),
    groupDragIds: new Set<string>(),
    groupDragDelta: 0,
    setGroupDrag: (ids, delta) => set({ groupDragIds: new Set(ids), groupDragDelta: delta }),
    endGroupDrag: () => set({ groupDragIds: new Set(), groupDragDelta: 0 }),
    laneOrder: [],
    setLaneOrder: (order) => set({ laneOrder: [...order] }),
    gridDivision: (() => {
      const raw = typeof window !== 'undefined' ? window.localStorage?.getItem('ghost_grid_division') : null;
      const n = raw ? parseFloat(raw) : NaN;
      const allowed = [1, 0.5, 0.25, 0.125, 0.0625];
      return allowed.includes(n) ? n : 1;
    })(),
    setGridDivision: (divisionOfBar) => {
      try { window.localStorage?.setItem('ghost_grid_division', String(divisionOfBar)); } catch {}
      set({ gridDivision: divisionOfBar });
    },

    loadTrack: async (trackId, fileId, projectId, trackBpm = 0) => {
      if (audioBufferCache.has(fileId)) {
        const cachedBuf = audioBufferCache.get(fileId)!;
        set((s) => {
          const m = new Map(s.loadedTracks);
          const existing = m.get(trackId);
          const pending = pendingTrackOffsets.get(trackId);
          if (pending !== undefined) pendingTrackOffsets.delete(trackId);
          m.set(trackId, {
            id: trackId, buffer: cachedBuf, source: null, gainNode: null,
            volume: existing?.volume ?? 1, muted: existing?.muted ?? false,
            soloed: existing?.soloed ?? false, bpm: trackBpm || existing?.bpm || 0, pitch: existing?.pitch ?? 0,
            trimStart: existing?.trimStart ?? 0, trimEnd: existing?.trimEnd ?? 0,
            startOffset: existing?.startOffset ?? pending ?? 0,
          });
          return { loadedTracks: m };
        });
        recalcDuration();
        return;
      }

      try {
        const arrayBuffer = await api.downloadFile(projectId, fileId);
        const tempCtx = new AudioContext();
        const buffer = await tempCtx.decodeAudioData(arrayBuffer);
        await tempCtx.close();
        cacheBuffer(fileId, buffer);

        set((s) => {
          const m = new Map(s.loadedTracks);
          const pending = pendingTrackOffsets.get(trackId);
          if (pending !== undefined) pendingTrackOffsets.delete(trackId);
          m.set(trackId, {
            id: trackId, buffer, source: null, gainNode: null,
            volume: 1, muted: false, soloed: false, bpm: trackBpm, pitch: 0,
            trimStart: 0, trimEnd: 0, startOffset: pending ?? 0,
          });
          return { loadedTracks: m };
        });
        recalcDuration();
      } catch (err: any) {
        console.error('[AudioStore] Failed to load track:', trackId, 'fileId:', fileId, err);
        set({ loadError: `Track ${trackId}: ${err?.message || err}` });
      }
    },

    loadTrackFromBuffer: (trackId, buffer, trackBpm = 0, detectedBpm, firstBeatOffset, beats, character) => {
      set((s) => {
        const m = new Map(s.loadedTracks);
        const existing = m.get(trackId);
        // If we're about to overwrite a still-playing source, stop it first
        // and disconnect its gain — otherwise it plays on as an orphan even
        // after the visible clip is gone.
        if (existing?.source) safeStop(existing.source);
        if (existing?.gainNode) { try { existing.gainNode.disconnect(); } catch { /* ignore */ } }
        const pending = pendingTrackOffsets.get(trackId);
        if (pending !== undefined) pendingTrackOffsets.delete(trackId);
        // Pending per-clip props from a Duplicate / Ctrl+V paste — apply
        // here so the newly-loaded track starts with the source clip's
        // volume / pitch / mute / warp / BPM override.
        const pendingProps = pendingTrackProps.get(trackId);
        if (pendingProps) pendingTrackProps.delete(trackId);

        // Time-stretch to match the project's BPM when we have analysis
        // and warp is on. Source BPM = the user's manual override
        // (existing.bpm) if set, else the file's detectedBpm. Keeping
        // originalBuffer pristine so every stretch starts from the source
        // (stretching a stretched buffer degrades quality fast).
        const projBpm = s.projectBpm;
        const initialWarp = existing ? existing.warp : pendingProps?.warp;
        const warp = initialWarp !== false;
        const initialBpm = existing?.bpm || pendingProps?.bpm || 0;
        const initialPitch = existing?.pitch ?? pendingProps?.pitch ?? 0;
        // composePlayBuffer combines warp + pitch into one stretch pass so
        // pitch shifts preserve time at playback (paired with playbackRate
        // in startAllSources).
        const { buffer: playBuffer } = composePlayBuffer({
          originalBuffer: buffer, buffer,
          bpm: initialBpm, detectedBpm, warp, pitch: initialPitch,
          character, beats,
        }, projBpm);

        m.set(trackId, {
          id: trackId, buffer: playBuffer, source: null, gainNode: null,
          volume: existing?.volume ?? pendingProps?.volume ?? 1,
          muted: existing?.muted ?? pendingProps?.muted ?? false,
          soloed: existing?.soloed ?? pendingProps?.soloed ?? false,
          bpm: trackBpm || existing?.bpm || pendingProps?.bpm || 0,
          pitch: existing?.pitch ?? pendingProps?.pitch ?? 0,
          trimStart: existing?.trimStart ?? pendingProps?.trimStart ?? 0,
          trimEnd: existing?.trimEnd ?? pendingProps?.trimEnd ?? 0,
          startOffset: existing?.startOffset ?? pending ?? 0,
          originalBuffer: buffer,
          detectedBpm,
          firstBeatOffset,
          beats,
          character,
          warp,
        });
        return { loadedTracks: m };
      });
      recalcDuration();
    },

    setProjectBpm: (bpm) => {
      const { projectBpm: prev } = get();
      const ratio = (prev > 0 && bpm > 0) ? prev / bpm : 1;
      set({ projectBpm: bpm });
      // BAR-LOCK every clip's timeline position so a tempo change feels
      // like the project changed speed instead of like every clip slid
      // around. startOffset (seconds) is multiplied by oldBpm/newBpm so a
      // clip that sat on bar 9 stays on bar 9 after the BPM change. Same
      // for trimStart/trimEnd of warped tracks: their playback buffer is
      // about to be re-stretched to the new tempo, so the trim positions
      // (in buffer seconds) need to scale to keep pointing at the same
      // musical positions in the source.
      if (Math.abs(ratio - 1) > 1e-6) {
        const { loadedTracks } = get();
        const m = new Map(loadedTracks);
        m.forEach((t, id) => {
          const next = { ...t, startOffset: t.startOffset * ratio };
          if (t.warp !== false) {
            next.trimStart = t.trimStart * ratio;
            next.trimEnd = t.trimEnd * ratio;
          }
          m.set(id, next);
        });
        set({ loadedTracks: m });
        // Drum rack lives in a sibling store. Dispatch instead of import
        // to avoid the audioStore → drumRackStore circular dep.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('ghost-bpm-rescale', { detail: { ratio } }));
        }
      }
      // Re-stretch every loaded track from its original buffer so samples
      // stay locked to the new grid. Skip when the change is negligible.
      if (prev > 0 && Math.abs(prev - bpm) > 0.1) {
        get().restretchAllTracks();
      }
      restartIfPlaying();
    },

    restretchAllTracks: () => {
      const { loadedTracks, projectBpm } = get();
      if (projectBpm <= 0) return;
      const m = new Map(loadedTracks);
      let changed = false;
      m.forEach((track, id) => {
        if (!track.originalBuffer) return;
        const { buffer: nextBuffer } = composePlayBuffer(track, projectBpm);
        if (nextBuffer !== track.buffer) {
          // Stop + disconnect the previous source before we drop the
          // reference — restartIfPlaying below will spin up fresh sources
          // from the new buffer.
          if (track.source) safeStop(track.source);
          if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
          m.set(id, { ...track, buffer: nextBuffer, source: null, gainNode: null });
          changed = true;
        }
      });
      if (changed) set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
    },

    setTrackBpm: (trackId, bpm) => {
      const { loadedTracks, projectBpm } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const m = new Map(loadedTracks);
      // Re-stretch through composePlayBuffer so warp + pitch combine
      // into one pass. Skipped when warp is off — store the override
      // but don't touch the buffer. Stop the existing source first so
      // it doesn't keep playing the old (wrongly-stretched) buffer.
      if (track.warp !== false && track.originalBuffer && projectBpm > 0 && bpm > 0) {
        if (track.source) safeStop(track.source);
        if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
        const oldLen = track.buffer.duration;
        const { buffer: nextBuffer } = composePlayBuffer({ ...track, bpm }, projectBpm);
        // Same trim-rescale story as setTrackPitch — buffer length changes
        // when the warp factor moves, so trim has to follow it.
        const ratio = oldLen > 0 ? nextBuffer.duration / oldLen : 1;
        m.set(trackId, { ...track, bpm, buffer: nextBuffer, trimStart: track.trimStart * ratio, trimEnd: track.trimEnd * ratio, source: null, gainNode: null });
        set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      } else {
        m.set(trackId, { ...track, bpm });
        set({ loadedTracks: m });
      }
      restartIfPlaying();
      // Persist via arrangement save so the override travels with the project.
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    setTrackWarp: (trackId, warp) => {
      const { loadedTracks, projectBpm } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const m = new Map(loadedTracks);
      // Switching warp regenerates the playback buffer through
      // composePlayBuffer so warp + pitch always end up combined into
      // one stretch.
      if (track.source) safeStop(track.source);
      if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
      const oldLen = track.buffer.duration;
      const { buffer: nextBuffer } = composePlayBuffer({ ...track, warp }, projectBpm);
      // Toggling warp can flip the buffer length dramatically (warp on +
      // big BPM mismatch = much longer/shorter buffer). Trim has to scale
      // by the same ratio.
      const ratio = oldLen > 0 ? nextBuffer.duration / oldLen : 1;
      m.set(trackId, { ...track, warp, buffer: nextBuffer, trimStart: track.trimStart * ratio, trimEnd: track.trimEnd * ratio, source: null, gainNode: null });
      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      restartIfPlaying();
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    unloadTrack: (trackId) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (track?.source) safeStop(track.source);
      loadedTracks.delete(trackId);
      set({ loadedTracks: new Map(loadedTracks) });
      recalcDuration();
    },

    play: () => {
      if (get().isPlaying) return;
      const ctx = getCtx();
      if (ctx.state === 'suspended') ctx.resume();
      // Resume from wherever the playhead is — either the last paused
      // position, or the currentTime set by a seek (timeline click). Falls
      // back to 0 only if neither is set.
      const resumeAt = Math.max(0, pausedAt || get().currentTime || 0);
      pausedAt = resumeAt;
      startAllSources(resumeAt);
      set({ isPlaying: true, currentTime: resumeAt });
      rafId = requestAnimationFrame(updatePosition);
    },

    pause: () => {
      if (!get().isPlaying) return;
      const ctx = getCtx();
      pausedAt = ctx.currentTime - startedAt;
      stopAllSources();
      if (rafId) cancelAnimationFrame(rafId);
      set({ isPlaying: false, currentTime: pausedAt });
    },

    stop: () => {
      stopAllSources();
      if (rafId) cancelAnimationFrame(rafId);
      pausedAt = 0;
      startedAt = 0;
      set({ isPlaying: false, currentTime: 0 });
    },

    seekTo: (time) => {
      const wasPlaying = get().isPlaying;
      stopAllSources();
      if (rafId) cancelAnimationFrame(rafId);
      pausedAt = time;
      set({ currentTime: time });
      if (wasPlaying) {
        startAllSources(time);
        set({ isPlaying: true });
        rafId = requestAnimationFrame(updatePosition);
      }
    },

    setTrackVolume: (trackId, volume) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.volume = volume;
      if (track.gainNode && !track.muted) track.gainNode.gain.value = volume;
      set({ loadedTracks: new Map(loadedTracks) });
    },

    setTrackMuted: (trackId, muted) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.muted = muted;
      loadedTracks.forEach((t, id) => {
        if (id !== trackId && (id.startsWith(trackId + '_dup_') || id.startsWith(trackId + '_split_'))) {
          t.muted = muted;
        }
      });
      set({ loadedTracks: new Map(loadedTracks) });
      updateSoloState();
    },

    removeTrack: (trackId) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      if (track.source) safeStop(track.source);
      if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
      loadedTracks.delete(trackId);
      // If that was the last track, fully stop the project — kill any
      // leftover module-level sources (solo) and cancel the RAF loop.
      // Defensive: protects against any orphan AudioBufferSourceNode that
      // was created in a brief race window before the delete fired.
      if (loadedTracks.size === 0) {
        stopAllSources();
        stopSolo();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        set({ loadedTracks: new Map(loadedTracks), isPlaying: false, currentTime: 0 });
      } else {
        set({ loadedTracks: new Map(loadedTracks) });
      }
      recalcDuration();
    },

    loopTrackToFill: (trackId, fileId) => {
      const { loadedTracks, duration } = get();
      const track = loadedTracks.get(trackId);
      if (!track || !track.buffer || track.buffer.duration >= duration) return;

      undoStack.push({ trackId, buffer: track.buffer, fileId });
      redoStack.length = 0;
      set({ canUndo: true, canRedo: false });

      track.buffer = loopBufferToLength(track.buffer, duration);
      set({ loadedTracks: new Map(loadedTracks), bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
    },

    undo: () => {
      if (undoStack.length === 0) return;
      const snapshot = undoStack.pop()!;
      const { loadedTracks } = get();
      const track = loadedTracks.get(snapshot.trackId);
      if (!track) return;
      redoStack.push({ trackId: snapshot.trackId, buffer: track.buffer, fileId: snapshot.fileId });
      track.buffer = snapshot.buffer;
      set({ loadedTracks: new Map(loadedTracks), canUndo: undoStack.length > 0, canRedo: true, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
    },

    redo: () => {
      if (redoStack.length === 0) return;
      const snapshot = redoStack.pop()!;
      const { loadedTracks } = get();
      const track = loadedTracks.get(snapshot.trackId);
      if (!track) return;
      undoStack.push({ trackId: snapshot.trackId, buffer: track.buffer, fileId: snapshot.fileId });
      track.buffer = snapshot.buffer;
      set({ loadedTracks: new Map(loadedTracks), canUndo: true, canRedo: redoStack.length > 0, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
    },

    setTrackSoloed: (trackId, soloed) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.soloed = soloed;
      set({ loadedTracks: new Map(loadedTracks) });
      updateSoloState();
    },

    setTrackPitch: (trackId, semitones) => {
      const { loadedTracks, projectBpm } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, semitones));
      const m = new Map(loadedTracks);
      // Rebuild the play buffer so the pitch shift preserves time. The
      // pitch field is read by composePlayBuffer and combined with the
      // current warp factor; the resulting buffer is `pitchFactor` longer
      // than the warped length and gets played at `playbackRate=pitchFactor`.
      if (track.source) safeStop(track.source);
      if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
      const oldLen = track.buffer.duration;
      const next = composePlayBuffer({ ...track, pitch }, projectBpm);
      // Scale trim by the buffer-length change. trimStart / trimEnd live in
      // BUFFER seconds, so when the pre-stretch length changes (e.g. +12
      // semitones doubles the buffer), the trim points have to scale by
      // the same ratio or they'd point to the wrong musical position in
      // the new buffer — and the visual clip width would shrink/grow with
      // pitch instead of holding steady.
      const ratio = oldLen > 0 ? next.buffer.duration / oldLen : 1;
      const trimStart = track.trimStart * ratio;
      const trimEnd = track.trimEnd * ratio; // 0 means "use full" — stays 0
      m.set(trackId, { ...track, pitch, buffer: next.buffer, trimStart, trimEnd, source: null, gainNode: null });
      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      restartIfPlaying();
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    playSoloTrack: (trackId) => {
      stopSolo();
      if (get().isPlaying) get().pause();

      const track = get().loadedTracks.get(trackId);
      if (!track) return;

      const ctx = getCtx();
      if (ctx.state === 'suspended') ctx.resume();

      soloSource = ctx.createBufferSource();
      soloSource.buffer = track.buffer;
      soloSource.playbackRate.value = Math.pow(2, (track.pitch || 0) / 12);
      soloSource.loop = false;

      soloGain = ctx.createGain();
      soloGain.gain.value = track.volume;
      soloSource.connect(soloGain);
      soloGain.connect(getMaster());

      soloSource.onended = () => {
        if (soloRafId) { cancelAnimationFrame(soloRafId); soloRafId = null; }
        set({ soloPlayingTrackId: null, soloCurrentTime: 0, soloDuration: 0 });
        soloSource = null;
        soloGain?.disconnect();
        soloGain = null;
      };

      soloStartedAt = ctx.currentTime;
      const dur = track.buffer.duration;
      soloSource.start(0);
      set({ soloPlayingTrackId: trackId, soloCurrentTime: 0, soloDuration: dur });

      const updateSoloPos = () => {
        if (!get().soloPlayingTrackId) return;
        const elapsed = ctx.currentTime - soloStartedAt;
        set({ soloCurrentTime: Math.min(elapsed, dur) });
        soloRafId = requestAnimationFrame(updateSoloPos);
      };
      soloRafId = requestAnimationFrame(updateSoloPos);
    },

    stopSoloTrack: () => {
      stopSolo();
      set({ soloPlayingTrackId: null, soloCurrentTime: 0, soloDuration: 0 });
    },

    setTrackOffset: (trackId, offset) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.startOffset = Math.max(0, offset);
      set({ loadedTracks: new Map(loadedTracks) });
      recalcDuration();
      restartIfPlaying();
    },

    setTrackTrim: (trackId, trimStart, trimEnd) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.trimStart = trimStart;
      track.trimEnd = trimEnd;
      set({ loadedTracks: new Map(loadedTracks) });
      recalcDuration();
      restartIfPlaying();
    },

    setTrackWarpMarkers: (trackId, markers) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      // Sort + dedupe so segment math is stable downstream once we hook
      // markers into the stretch engine.
      const sorted = Array.from(new Set(markers))
        .filter((m) => Number.isFinite(m) && m >= 0)
        .sort((a, b) => a - b);
      track.warpMarkers = sorted;
      set({ loadedTracks: new Map(loadedTracks) });
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    duplicateTrack: (trackId) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return null;

      const newBuf = cloneBuffer(track.buffer);
      const clipEnd = track.trimEnd > 0 ? track.trimEnd : track.buffer.duration;
      const clipDuration = clipEnd - track.trimStart;
      const newOffset = track.startOffset + clipDuration;

      const newId = trackId + '_dup_' + Date.now();
      const m = new Map(loadedTracks);
      m.set(newId, {
        id: newId, buffer: newBuf, source: null, gainNode: null,
        volume: track.volume, muted: track.muted, soloed: track.soloed,
        bpm: track.bpm, pitch: track.pitch,
        trimStart: track.trimStart, trimEnd: track.trimEnd, startOffset: newOffset,
      });

      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
      restartIfPlaying();
      return newId;
    },

    splitTrack: (trackId, atTime) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return null;

      const split = splitBufferAt(track.buffer, atTime);
      if (!split) return null;
      const [first, second] = split;

      track.buffer = first;
      track.trimStart = 0;
      track.trimEnd = 0;

      const newId = trackId + '_split_' + Date.now();
      const m = new Map(loadedTracks);
      m.set(newId, {
        id: newId, buffer: second, source: null, gainNode: null,
        volume: track.volume, muted: track.muted, soloed: track.soloed,
        bpm: track.bpm, pitch: track.pitch,
        trimStart: 0, trimEnd: 0, startOffset: track.startOffset + atTime,
      });

      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
      restartIfPlaying();
      return newId;
    },

    saveArrangementState: (projectId, serverTrackFileIds) => {
      saveArrangement(projectId, get().loadedTracks, serverTrackFileIds);
    },

    buildArrangementState: (serverTrackFileIds) => {
      const clips: any[] = [];
      const seen = new Set<string>();
      get().loadedTracks.forEach((track, id) => {
        seen.add(id);
        const isChild = id.includes('_split_') || id.includes('_dup_');
        const parentId = isChild ? id.split(/_split_|_dup_/)[0] : undefined;
        clips.push({
          trackId: id,
          trimStart: track.trimStart,
          trimEnd: track.trimEnd,
          startOffset: track.startOffset,
          volume: track.volume,
          muted: track.muted,
          soloed: track.soloed,
          pitch: track.pitch,
          bpm: track.bpm || undefined,
          warp: track.warp,
          warpMarkers: track.warpMarkers && track.warpMarkers.length ? track.warpMarkers : undefined,
          parentTrackId: parentId,
          parentFileId: parentId ? serverTrackFileIds.get(parentId) : undefined,
        });
      });
      // Include pending duplicates / pastes that haven't loaded into the
      // audio store yet. Without this, an auto-save firing right after a
      // Duplicate would persist the arrangement WITHOUT the new clip's
      // mix state — and the user's BPM override / warp choice would be
      // gone after a refresh.
      pendingTrackOffsets.forEach((startOffset, trackId) => {
        if (seen.has(trackId)) return;
        const props = pendingTrackProps.get(trackId);
        clips.push({
          trackId,
          trimStart: props?.trimStart ?? 0,
          trimEnd: props?.trimEnd ?? 0,
          startOffset,
          volume: props?.volume ?? 1,
          muted: props?.muted ?? false,
          soloed: props?.soloed ?? false,
          pitch: props?.pitch ?? 0,
          bpm: props?.bpm,
          warp: props?.warp,
        });
      });
      // Carry the user's vertical lane order so every collaborator's
      // arrangement view reads the same top-to-bottom layout.
      return { clips, laneOrder: get().laneOrder };
    },

    applyArrangementClips: (clips) => {
      const { loadedTracks, projectBpm } = get();
      const m = new Map(loadedTracks);
      for (const clip of clips) {
        const existing = m.get(clip.trackId);
        if (existing) {
          existing.trimStart = clip.trimStart;
          existing.trimEnd = clip.trimEnd;
          existing.startOffset = clip.startOffset;
          existing.volume = clip.volume;
          existing.muted = clip.muted;
          existing.soloed = clip.soloed;
          existing.pitch = clip.pitch;
          existing.warpMarkers = (clip as any).warpMarkers;
          // Warp / BPM override / pitch can all change in a remote update.
          // Detect any of them shifting and rebuild the playback buffer
          // through composePlayBuffer so the combined warp + pitch stretch
          // is always consistent.
          const incomingWarp = clip.warp !== false;
          const warpChanged = incomingWarp !== (existing.warp !== false);
          const bpmChanged = !!clip.bpm && clip.bpm > 0 && clip.bpm !== existing.bpm;
          const pitchChanged = (clip.pitch ?? 0) !== (existing.pitch ?? 0);
          if (warpChanged) existing.warp = incomingWarp;
          if (bpmChanged) existing.bpm = clip.bpm;
          if ((warpChanged || bpmChanged || pitchChanged) && existing.originalBuffer) {
            if (existing.source) safeStop(existing.source);
            if (existing.gainNode) { try { existing.gainNode.disconnect(); } catch { /* ignore */ } }
            const { buffer: nextBuffer } = composePlayBuffer(existing, projectBpm);
            existing.buffer = nextBuffer;
            existing.source = null;
            existing.gainNode = null;
          }
        } else if (clip.parentTrackId) {
          const parentTrack = m.get(clip.parentTrackId);
          if (parentTrack) {
            m.set(clip.trackId, {
              id: clip.trackId,
              buffer: cloneBuffer(parentTrack.buffer),
              source: null, gainNode: null,
              volume: clip.volume, muted: clip.muted, soloed: clip.soloed,
              bpm: parentTrack.bpm, pitch: clip.pitch,
              trimStart: clip.trimStart, trimEnd: clip.trimEnd,
              startOffset: clip.startOffset,
            });
          }
        }
      }
      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
    },

    restoreArrangementState: (projectId, _serverTrackFileIds) => {
      const saved = loadArrangement(projectId);
      if (!saved) return;

      const { loadedTracks } = get();
      const m = new Map(loadedTracks);

      for (const clip of saved.clips) {
        const existing = m.get(clip.trackId);
        if (existing) {
          existing.trimStart = clip.trimStart;
          existing.trimEnd = clip.trimEnd;
          existing.startOffset = clip.startOffset;
          existing.volume = clip.volume;
          existing.muted = clip.muted;
          existing.soloed = clip.soloed;
          existing.pitch = clip.pitch;
        } else if (clip.parentTrackId && clip.parentFileId) {
          const parentTrack = m.get(clip.parentTrackId);
          if (parentTrack) {
            m.set(clip.trackId, {
              id: clip.trackId,
              buffer: cloneBuffer(parentTrack.buffer),
              source: null, gainNode: null,
              volume: clip.volume, muted: clip.muted, soloed: clip.soloed,
              bpm: parentTrack.bpm, pitch: clip.pitch,
              trimStart: clip.trimStart, trimEnd: clip.trimEnd,
              startOffset: clip.startOffset,
            });
          }
        }
      }

      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      recalcDuration();
    },

    cleanup: () => {
      stopAllSources();
      stopSolo();
      if (rafId) cancelAnimationFrame(rafId);
      pausedAt = 0;
      startedAt = 0;
      undoStack.length = 0;
      redoStack.length = 0;
      clearAudioCaches();
      set({
        isPlaying: false, currentTime: 0, loadedTracks: new Map(), duration: 0,
        projectBpm: 0, soloPlayingTrackId: null, soloCurrentTime: 0, soloDuration: 0,
        canUndo: false, canRedo: false,
      });
    },
  };
});
