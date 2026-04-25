import { create } from 'zustand';
import { api } from '../lib/api';
import { PITCH_MIN, PITCH_MAX } from '../lib/constants';
import { audioBufferCache, cacheBuffer, clearAudioCaches } from '../lib/audio';
import { getCtx, getMaster, getAnalyser as getAnalyserNode, safeStop } from './audio/graph';
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

export function getAnalyser(): AnalyserNode | null {
  return getAnalyserNode();
}

// Offsets to apply when a track first lands in the store via
// loadTrack / loadTrackFromBuffer. Used by the duplicate flow so the new clip
// arrives at the intended position instead of defaulting to 0 and overlapping
// the original before the async seeder catches up.
export const pendingTrackOffsets = new Map<string, number>();

interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  projectBpm: number;
  canUndo: boolean;
  canRedo: boolean;
  bufferVersion: number;
  loadedTracks: Map<string, LoadedTrack>;
  soloActive: boolean;
  soloPlayingTrackId: string | null;
  soloCurrentTime: number;
  soloDuration: number;
  loadError: string | null;
  // Currently-selected clip id. Drives the selected ring on LaneClip and is
  // what Ctrl+C reads when the user copies. Cleared on Escape or when the
  // user clicks empty arrangement space.
  selectedTrackId: string | null;
  setSelectedTrackId: (id: string | null) => void;
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
      const trackEnd = t.startOffset + t.buffer.duration;
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

      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.playbackRate.value = 1;
      source.loop = false;

      const gain = ctx.createGain();
      gain.gain.value = track.muted ? 0 : track.volume;
      source.connect(gain);
      gain.connect(getMaster());

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
    canUndo: false,
    canRedo: false,
    bufferVersion: 0,
    loadedTracks: new Map(),
    soloActive: false,
    soloPlayingTrackId: null,
    soloCurrentTime: 0,
    soloDuration: 0,
    loadError: null,
    selectedTrackId: null,
    setSelectedTrackId: (id) => set({ selectedTrackId: id }),
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

        // Time-stretch to match the project's BPM when we have analysis.
        // Keep the pristine buffer in `originalBuffer` so BPM changes can
        // re-stretch from the source (stretching a stretched buffer degrades
        // quality fast).
        const projBpm = s.projectBpm;
        const playBuffer = detectedBpm
          ? stretchForProject(buffer, detectedBpm, projBpm, { character, beats })
          : buffer;

        m.set(trackId, {
          id: trackId, buffer: playBuffer, source: null, gainNode: null,
          volume: existing?.volume ?? 1, muted: existing?.muted ?? false,
          soloed: existing?.soloed ?? false, bpm: trackBpm || existing?.bpm || 0,
          pitch: existing?.pitch ?? 0,
          trimStart: existing?.trimStart ?? 0,
          trimEnd: existing?.trimEnd ?? 0,
          startOffset: existing?.startOffset ?? pending ?? 0,
          originalBuffer: buffer,
          detectedBpm,
          firstBeatOffset,
          beats,
          character,
        });
        return { loadedTracks: m };
      });
      recalcDuration();
    },

    setProjectBpm: (bpm) => {
      const { projectBpm: prev } = get();
      set({ projectBpm: bpm });
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
        if (!track.originalBuffer || !track.detectedBpm) return;
        const nextBuffer = stretchForProject(
          track.originalBuffer, track.detectedBpm, projectBpm,
          { character: track.character, beats: track.beats },
        );
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
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.bpm = bpm;
      set({ loadedTracks: new Map(loadedTracks) });
      restartIfPlaying();
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
      pausedAt = 0;
      startAllSources(0);
      set({ isPlaying: true, currentTime: 0 });
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
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      track.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, semitones));
      set({ loadedTracks: new Map(loadedTracks) });
      restartIfPlaying();
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
      get().loadedTracks.forEach((track, id) => {
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
          parentTrackId: parentId,
          parentFileId: parentId ? serverTrackFileIds.get(parentId) : undefined,
        });
      });
      return { clips };
    },

    applyArrangementClips: (clips) => {
      const { loadedTracks } = get();
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
