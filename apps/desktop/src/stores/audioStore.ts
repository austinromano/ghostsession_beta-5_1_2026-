import { create } from 'zustand';
import { api } from '../lib/api';
import { PITCH_MIN, PITCH_MAX } from '../lib/constants';
import { audioBufferCache, cacheBuffer, clearAudioCaches } from '../lib/audio';
import {
  getCtx, getMaster, getMasterFader, getAnalyser as getAnalyserNode, safeStop,
  ensureWarpedPlaybackWorklet, createWarpedPlaybackNode, ensureTrackCompressorWorklet,
  setBusEqBand, setBusCompParam, setBusReverbWet, setBusReverbDecay,
  getBusEqBand, getBusCompParam, getBusReverbWet, getBusReverbDecay,
  getFxBusInput, wireDrumBusOutput,
  type WarpedParams,
} from './audio/graph';
import { save as saveArrangement, load as loadArrangement } from './audio/arrangement';
import { cloneBuffer, loopBufferToLength, splitBufferAt } from './audio/bufferOps';
import type { LoadedTrack, UndoSnapshot, WarpMarker, BusFxState } from './audio/types';
import { buildTrackEqChain, removeTrackEq, disposeAllTrackEq } from './audio/trackEq';
import { buildTrackCompChain, removeTrackComp, disposeAllTrackComp } from './audio/trackComp';
import { buildTrackReverbChain, removeTrackReverb, disposeAllTrackReverb } from './audio/trackReverb';
import { useEffectsStore, DRUM_RACK_FX_KEY, type EqParams, type CompParams, type ReverbParams } from './effectsStore';
import { useProjectStore } from './projectStore';
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
// Slice a portion of an AudioBuffer into a fresh AudioBuffer. Used by
// the piecewise warp stretcher to break the source into per-segment
// chunks before stretching each at its own factor.
function sliceAudioBuffer(src: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const ctx = getCtx();
  const startSample = Math.max(0, Math.floor(startSec * src.sampleRate));
  const endSample = Math.min(src.length, Math.ceil(endSec * src.sampleRate));
  const length = Math.max(1, endSample - startSample);
  const out = ctx.createBuffer(src.numberOfChannels, length, src.sampleRate);
  for (let ch = 0; ch < src.numberOfChannels; ch++) {
    const srcCh = src.getChannelData(ch);
    const dstCh = out.getChannelData(ch);
    for (let i = 0; i < length; i++) dstCh[i] = srcCh[startSample + i];
  }
  return out;
}

// Concatenate AudioBuffers head-to-tail. Output sample rate / channel
// count matches the first input.
function concatAudioBuffers(parts: AudioBuffer[]): AudioBuffer {
  const ctx = getCtx();
  if (parts.length === 0) return ctx.createBuffer(2, 1, ctx.sampleRate);
  const sampleRate = parts[0].sampleRate;
  const channels = parts[0].numberOfChannels;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = ctx.createBuffer(channels, total, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const dst = out.getChannelData(ch);
    let pos = 0;
    for (const p of parts) {
      const src = p.getChannelData(Math.min(ch, p.numberOfChannels - 1));
      dst.set(src, pos);
      pos += p.length;
    }
  }
  return out;
}

// Piecewise WSOLA stretch driven by warp markers. Each adjacent pair
// of (sourceSec, bufferSec) anchors defines a segment; the source slice
// for that segment is stretched to fit its target buffer length, then
// every segment is concatenated. Implicit anchors (0, 0) and
// (sourceLen, sourceLen * baseStretch) bracket the user's markers so
// the head and tail of the buffer always render.
function stretchWithMarkers(
  original: AudioBuffer,
  markers: WarpMarker[],
  baseStretch: number,
  meta: { character?: SampleCharacter; beats?: number[] },
): AudioBuffer {
  const sorted = markers.slice().sort((a, b) => a.sourceSec - b.sourceSec);
  const points: WarpMarker[] = [
    { sourceSec: 0, bufferSec: 0 },
    ...sorted,
    { sourceSec: original.duration, bufferSec: original.duration * baseStretch },
  ];
  const segments: AudioBuffer[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const sourceLen = b.sourceSec - a.sourceSec;
    const bufferLen = b.bufferSec - a.bufferSec;
    if (sourceLen <= 0 || bufferLen <= 0) continue;
    const factor = bufferLen / sourceLen;
    const slice = sliceAudioBuffer(original, a.sourceSec, b.sourceSec);
    if (Math.abs(factor - 1) < 0.005) {
      segments.push(slice);
    } else {
      try {
        segments.push(adaptiveStretch(slice, factor, getCtx(), meta));
      } catch {
        segments.push(slice);
      }
    }
  }
  return concatAudioBuffers(segments);
}

// Scale every marker's bufferSec by the same ratio that the global
// stretch factor changed by — keeps markers locked to their musical
// positions through tempo / pitch / warp changes.
function rescaleWarpMarkers(markers: WarpMarker[] | undefined, ratio: number): WarpMarker[] | undefined {
  if (!markers || markers.length === 0) return markers;
  if (Math.abs(ratio - 1) < 1e-6) return markers;
  return markers.map((m) => ({ sourceSec: m.sourceSec, bufferSec: m.bufferSec * ratio }));
}

function composePlayBuffer(
  track: { originalBuffer?: AudioBuffer; bpm?: number; detectedBpm?: number; warp?: boolean; pitch?: number; character?: SampleCharacter; beats?: number[]; buffer: AudioBuffer; warpMarkers?: WarpMarker[] },
  projectBpm: number,
): PlayBufferResult {
  const pitchFactor = Math.pow(2, (track.pitch || 0) / 12);
  if (!track.originalBuffer) return { buffer: track.buffer, playbackRate: pitchFactor };
  const sourceBpm = (track.bpm && track.bpm > 0) ? track.bpm : track.detectedBpm;
  const warpActive = track.warp !== false && !!sourceBpm && sourceBpm > 0 && projectBpm > 0;
  const warpFactor = warpActive ? (sourceBpm! / projectBpm) : 1;
  const baseStretch = warpFactor * pitchFactor;
  // Piecewise warp path — user has placed at least one warp marker.
  // Each segment between markers gets its own stretch factor based on
  // its target buffer length, so dragging a marker re-positions audio
  // independently of every other marker.
  if (track.warpMarkers && track.warpMarkers.length > 0) {
    try {
      const buffer = stretchWithMarkers(track.originalBuffer, track.warpMarkers, baseStretch, {
        character: track.character, beats: track.beats,
      });
      return { buffer, playbackRate: pitchFactor };
    } catch {
      // fall through to global stretch on failure
    }
  }
  // Global stretch (the original path) — only run WSOLA if the stretch
  // is meaningful. Anything inside ±2% is imperceptible and not worth
  // the spectral artefacts a time-stretch always introduces. Same
  // bail-out at extreme ratios where WSOLA breaks down (use the source
  // as-is plus playbackRate).
  if (Math.abs(baseStretch - 1) < 0.02 || baseStretch < 0.4 || baseStretch > 2.5) {
    return { buffer: track.originalBuffer, playbackRate: pitchFactor };
  }
  try {
    const buffer = cachedAdaptiveStretch(track.originalBuffer, baseStretch, {
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

// AudioContext-time anchor for the start of the current project play.
// `projectTime = ctx.currentTime - getStartedAt()`. Schedulers (drum rack,
// MIDI step sequencer) need this to convert ctx-time → project-time without
// the ~16ms staleness of the RAF-driven `currentTime` field.
export function getStartedAt(): number {
  return startedAt;
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
  setTrackPan: (trackId: string, pan: number) => void;
  setTrackBusSend: (trackId: string, send: number) => void;
  // FX bus state mirrors graph nodes so React rerenders track changes.
  // The graph nodes remain the source of truth; setBusFx* actions write
  // both the graph node and this mirror.
  busFx: BusFxState;
  selectedBusId: string | null;
  setSelectedBusId: (id: string | null) => void;
  setBusEq: (band: 'low' | 'mid' | 'high', dB: number) => void;
  setBusComp: (field: 'threshold' | 'ratio' | 'makeup', v: number) => void;
  setBusReverbWet: (level: number) => void;
  setBusReverbDecay: (seconds: number) => void;
  setTrackMuted: (trackId: string, muted: boolean) => void;
  removeTrack: (trackId: string) => void;
  loopTrackToFill: (trackId: string, fileId?: string) => void;
  undo: () => void;
  redo: () => void;
  setTrackSoloed: (trackId: string, soloed: boolean) => void;
  setTrackPitch: (trackId: string, semitones: number) => void;
  setTrackTrim: (trackId: string, trimStart: number, trimEnd: number) => void;
  setTrackWarpMarkers: (trackId: string, markers: WarpMarker[]) => void;
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
// Per-track debounce timers for setTrackPitch's heavy WSOLA rebuild.
// Rapid slider movement coalesces into ONE WSOLA pass once the user
// stops moving — see setTrackPitch for rationale.
const pitchCommitTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Pitch the track's CURRENT buffer + warp markers were built/rescaled
// for. Phase 1 of setTrackPitch updates `track.pitch` instantly (so
// the live source's playbackRate can ramp) but the buffer/markers
// stay at their last-committed scale — this map records that pitch
// so phase 2 knows the correct old-factor when rescaling markers.
const trackCommittedPitch = new Map<string, number>();
let rafId: number | null = null;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
const undoStack: UndoSnapshot[] = [];
const redoStack: UndoSnapshot[] = [];
let soloSource: AudioBufferSourceNode | null = null;
let soloGain: GainNode | null = null;
let soloStartedAt = 0;
let soloRafId: number | null = null;

// Kick off WarpedPlayback worklet registration as soon as the audio
// store loads. addModule is async; firing it from module init lets
// the fetch + parse complete in the background while the user is
// browsing projects so the worklet is ready by the time they hit play.
// If it fails, the worklet path bails per-track to BufferSource.
ensureWarpedPlaybackWorklet().catch((err) => {
  if (typeof console !== 'undefined') console.warn('[audioStore] WarpedPlayback worklet not registered:', err);
});
ensureTrackCompressorWorklet().catch((err) => {
  if (typeof console !== 'undefined') console.warn('[audioStore] TrackCompressor worklet not registered:', err);
});

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

  // Worklet eligibility — every condition listed:
  //   1. Track has at least one user-placed warp marker
  //   2. Pitch is 0 (worklet's linear stretch couples pitch + speed; the
  //      existing pre-stretch path keeps pitch time-preserving, so we
  //      only switch to worklet when pitch wouldn't change anything)
  //   3. Warp is on (worklet's marker math assumes the stretch model)
  //   4. originalBuffer is loaded (worklet plays from the unstretched
  //      source, not the pre-stretched buffer)
  // Everything else falls back to the BufferSource path unchanged.
  function shouldUseWorkletForTrack(track: LoadedTrack): boolean {
    return !!track.warpMarkers
      && track.warpMarkers.length > 0
      && (track.pitch || 0) === 0
      && track.warp !== false
      && !!track.originalBuffer;
  }

  function workletParamsFromTrack(track: LoadedTrack, projectBpm: number): WarpedParams {
    const sourceBpm = (track.bpm && track.bpm > 0) ? track.bpm : track.detectedBpm;
    const warpActive = track.warp !== false && !!sourceBpm && sourceBpm > 0 && projectBpm > 0;
    const warpFactor = warpActive ? (sourceBpm! / projectBpm) : 1;
    const pitchFactor = Math.pow(2, (track.pitch || 0) / 12);
    return {
      markers: track.warpMarkers || [],
      // Worklet's outputToSource uses baseStretch as the warp-only
      // factor — pitch is layered on as a separate ctx-time multiplier.
      baseStretch: warpFactor,
      pitchFactor,
      // trim values come from the audio store in pre-stretched-buffer
      // seconds; worklet output time matches that timeline 1:1 when
      // pitch is 0 (the only case we use the worklet for right now).
      trimStart: track.trimStart,
      trimEnd: track.trimEnd,
      // Volume is owned by the downstream gainNode (same node both
      // paths feed into). Worklet's internal volume is a passthrough
      // unity multiplier so setTrackVolume / setTrackMuted keep working
      // without re-posting params to the worklet.
      volume: 1,
    };
  }

  function disposeWorkletController(track: LoadedTrack) {
    if (track.workletController) {
      try { track.workletController.dispose(); } catch { /* ignore */ }
      track.workletController = null;
    }
  }

  function startAllSources(offset: number) {
    const ctx = getCtx();
    const { loadedTracks, projectBpm } = get();

    // Walk the clip's lane chain and splice DSP nodes between
    // `inputNode` and the master mixer. Returns the final output node
    // so the caller can attach the bus-send tap to POST-FX signal.
    // The chain is keyed by lane (fileId for normal tracks, trackId
    // fallback) so every clip in a lane shares one chain.
    const projTracks = (useProjectStore.getState().currentProject?.tracks ?? []) as Array<{ id: string; fileId?: string | null }>;
    const buildLaneChainFor = (trackId: string, inputNode: AudioNode): AudioNode => {
      const projTrack = projTracks.find((p) => p.id === trackId);
      const laneKey = (projTrack?.fileId && projTrack.fileId.length > 0) ? projTrack.fileId : trackId;
      // Wipe any previous DSP registered for this clip so we don't
      // leak nodes when the chain shape changes between starts.
      removeTrackEq(trackId);
      removeTrackComp(trackId);
      removeTrackReverb(trackId);
      const chain = useEffectsStore.getState().getChain(laneKey);
      let cursor: AudioNode = inputNode;
      for (const fx of chain) {
        try {
          if (fx.kind === 'eq' && fx.params && 'bands' in fx.params) {
            const eq = buildTrackEqChain(ctx, trackId, laneKey, (fx.params as EqParams).bands as any, fx.bypassed);
            cursor.connect(eq.input);
            cursor = eq.output;
          } else if (fx.kind === 'comp' && fx.params && 'threshold' in fx.params) {
            const comp = buildTrackCompChain(ctx, trackId, laneKey, fx.params as CompParams, fx.bypassed);
            cursor.connect(comp.input);
            cursor = comp.output;
          } else if (fx.kind === 'reverb' && fx.params && 'mix' in fx.params) {
            const rev = buildTrackReverbChain(ctx, trackId, laneKey, fx.params as ReverbParams, fx.bypassed);
            cursor.connect(rev.input);
            cursor = rev.output;
          }
        } catch (err) {
          if (typeof console !== 'undefined') console.warn('[audioStore] FX build failed for', fx.kind, err);
        }
      }
      return cursor;
    };

    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }

    loadedTracks.forEach((track) => {
      safeStop(track.source);
      disposeWorkletController(track);
      // Disconnect any prior analyser so the OLD node doesn't keep showing
      // a frozen reading after we restart playback.
      if (track.analyser) { try { track.analyser.disconnect(); } catch { /* ignore */ } }
      // Disconnect prior bus-send so it doesn't keep an orphan edge into
      // the shared FX bus after the upstream pan is discarded.
      if (track.busSendNode) { try { track.busSendNode.disconnect(); } catch { /* ignore */ } track.busSendNode = null; }

      // Worklet path — tracks with warp markers play through the
      // streaming worklet so marker drags update audio in real time
      // without a buffer rebuild.
      if (shouldUseWorkletForTrack(track)) {
        try {
          const controller = createWarpedPlaybackNode(track.originalBuffer!);
          const gain = ctx.createGain();
          gain.gain.value = track.muted ? 0 : track.volume;
          const pan = ctx.createStereoPanner();
          pan.pan.value = Math.max(-1, Math.min(1, track.pan || 0));
          // Per-track audio path: source → gain → pan → mixerBus (DRY).
          // Per-track sendNode taps post-pan into the FX bus in parallel
          // (WET) so the user controls how much of each track gets
          // processed by the bus's EQ → Comp → Reverb chain.
          controller.node.connect(gain);
          gain.connect(pan);
          // Walk the lane's effect chain (EQ, Comp, ...) and splice
          // each layer's DSP between pan and master. The send tap
          // pulls POST-FX so the bus receives the processed signal.
          const postFx = buildLaneChainFor(track.id, pan);
          postFx.connect(getMaster());
          const send = ctx.createGain();
          send.gain.value = Math.max(0, Math.min(1, track.busSend ?? 0));
          postFx.connect(send);
          send.connect(getFxBusInput());
          track.busSendNode = send;
          // Parallel meter tap — branches off gain so the meter reads
          // the lane's pre-pan sound. Doesn't sit in the audio path.
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.6;
          gain.connect(analyser);
          track.analyser = analyser;
          track.workletController = controller;
          track.gainNode = gain;
          track.panNode = pan;
          controller.setParams(workletParamsFromTrack(track, projectBpm));
          // Same start-time math as the BufferSource branch — `offset`
          // is the project-time at which playback resumes; clips that
          // start later schedule via startCtxTime.
          const projectTime = offset;
          const trackStartsAt = track.startOffset;
          if (projectTime >= trackStartsAt) {
            controller.play(ctx.currentTime, projectTime - trackStartsAt);
          } else {
            controller.play(ctx.currentTime + (trackStartsAt - projectTime), 0);
          }
          return; // worklet path taken — skip the BufferSource branch
        } catch (err) {
          // Worklet failed to construct (probably not registered yet);
          // fall through to BufferSource on this track's playback.
          if (typeof console !== 'undefined') console.warn('[audioStore] worklet path failed, falling back', err);
        }
      }

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
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, track.pan || 0));
      // Per-track path: source → gain → pan → [eq?] → mixerBus (DRY).
      // The sendNode taps post-EQ into the FX bus in parallel — track
      // is dry by default, user opts in by raising the send knob.
      source.connect(gain);
      gain.connect(pan);
      const postFx = buildLaneChainFor(track.id, pan);
      postFx.connect(getMaster());
      const send = ctx.createGain();
      send.gain.value = Math.max(0, Math.min(1, track.busSend ?? 0));
      postFx.connect(send);
      send.connect(getFxBusInput());
      track.busSendNode = send;
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
      // trim values + buffer position are BUFFER seconds; project time is
      // PROJECT seconds. When pitch ≠ 0 the buffer was pre-stretched by
      // pitchFactor and plays back at pitchFactor, so 1 project-sec = pitchFactor
      // buffer-secs. Mid-clip restarts have to convert via this rate or the
      // source skips the wrong amount of buffer and drifts off the grid.
      const playbackRate = source.playbackRate.value;

      track.source = source;
      track.gainNode = gain;
      track.panNode = pan;

      if (projectTime >= trackStartsAt) {
        const elapsed = projectTime - trackStartsAt;
        const bufElapsed = elapsed * playbackRate;
        if (bufElapsed >= trimDuration) return;
        source.start(0, trimStart + bufElapsed, trimDuration - bufElapsed);
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
      // Tear down the worklet too — same lifecycle as the BufferSource
      // path: worklet is recreated per-play, not persistent.
      disposeWorkletController(track);
      if (track.analyser) { try { track.analyser.disconnect(); } catch { /* ignore */ } track.analyser = null; }
      if (track.busSendNode) { try { track.busSendNode.disconnect(); } catch { /* ignore */ } track.busSendNode = null; }
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
    // FX bus state — initialised from the same localStorage values
    // graph.ts seeded the actual nodes with, so the React store and the
    // audio nodes start in sync. setBusEq / setBusComp / setBusReverbWet /
    // setBusReverbDecay actions keep both sides aligned thereafter.
    busFx: {
      eq: {
        low: getBusEqBand('low'),
        mid: getBusEqBand('mid'),
        high: getBusEqBand('high'),
      },
      comp: {
        threshold: getBusCompParam('threshold'),
        ratio: getBusCompParam('ratio'),
        makeup: getBusCompParam('makeup'),
      },
      reverbWet: getBusReverbWet(),
      reverbDecay: getBusReverbDecay(),
    },
    selectedBusId: null,
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
    setSelectedTrackIds: (ids) => {
      const next = new Set(ids);
      // Selecting a clip switches the editor panel out of bus-FX mode
      // so the per-clip controls reappear.
      set((s) => next.size > 0 ? { selectedTrackIds: next, selectedBusId: null } : { selectedTrackIds: next });
    },
    toggleTrackSelection: (id) => set((s) => {
      const next = new Set(s.selectedTrackIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { selectedTrackIds: next, selectedBusId: null };
    }),
    addTrackToSelection: (id) => set((s) => {
      if (s.selectedTrackIds.has(id)) return {};
      const next = new Set(s.selectedTrackIds);
      next.add(id);
      return { selectedTrackIds: next, selectedBusId: null };
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
            next.warpMarkers = rescaleWarpMarkers(t.warpMarkers, ratio);
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
        // warpFactor change ratio = old / new source BPM (warpFactor = sourceBpm / projectBpm).
        const oldSrcBpm = (track.bpm && track.bpm > 0) ? track.bpm : (track.detectedBpm || bpm);
        const markerRatio = oldSrcBpm > 0 ? bpm / oldSrcBpm : 1;
        const scaledMarkers = rescaleWarpMarkers(track.warpMarkers, markerRatio);
        const { buffer: nextBuffer } = composePlayBuffer({ ...track, bpm, warpMarkers: scaledMarkers }, projectBpm);
        const ratio = oldLen > 0 ? nextBuffer.duration / oldLen : 1;
        m.set(trackId, { ...track, bpm, buffer: nextBuffer, trimStart: track.trimStart * ratio, trimEnd: track.trimEnd * ratio, warpMarkers: scaledMarkers, source: null, gainNode: null });
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
      // warpFactor flips between (sourceBpm/projectBpm) and 1 when warp toggles.
      const sourceBpm = (track.bpm && track.bpm > 0) ? track.bpm : track.detectedBpm;
      const oldWarpFactor = (track.warp !== false && sourceBpm && sourceBpm > 0 && projectBpm > 0) ? (sourceBpm / projectBpm) : 1;
      const newWarpFactor = (warp !== false && sourceBpm && sourceBpm > 0 && projectBpm > 0) ? (sourceBpm / projectBpm) : 1;
      const markerRatio = newWarpFactor / oldWarpFactor;
      const scaledMarkers = rescaleWarpMarkers(track.warpMarkers, markerRatio);
      const { buffer: nextBuffer } = composePlayBuffer({ ...track, warp, warpMarkers: scaledMarkers }, projectBpm);
      const ratio = oldLen > 0 ? nextBuffer.duration / oldLen : 1;
      m.set(trackId, { ...track, warp, buffer: nextBuffer, trimStart: track.trimStart * ratio, trimEnd: track.trimEnd * ratio, warpMarkers: scaledMarkers, source: null, gainNode: null });
      set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
      restartIfPlaying();
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    unloadTrack: (trackId) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (track?.source) safeStop(track.source);
      const pendingTimer = pitchCommitTimers.get(trackId);
      if (pendingTimer) { clearTimeout(pendingTimer); pitchCommitTimers.delete(trackId); }
      trackCommittedPitch.delete(trackId);
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

    setSelectedBusId: (id) => set({ selectedBusId: id }),

    setBusEq: (band, dB) => {
      setBusEqBand(band, dB);
      set((s) => ({
        busFx: {
          ...s.busFx,
          eq: { ...s.busFx.eq, [band]: getBusEqBand(band) },
        },
      }));
    },

    setBusComp: (field, v) => {
      setBusCompParam(field, v);
      set((s) => ({
        busFx: {
          ...s.busFx,
          comp: { ...s.busFx.comp, [field]: getBusCompParam(field) },
        },
      }));
    },

    setBusReverbWet: (level) => {
      setBusReverbWet(level);
      set((s) => ({ busFx: { ...s.busFx, reverbWet: getBusReverbWet() } }));
    },

    setBusReverbDecay: (seconds) => {
      setBusReverbDecay(seconds);
      set((s) => ({ busFx: { ...s.busFx, reverbDecay: getBusReverbDecay() } }));
    },

    setTrackPan: (trackId, pan) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const clamped = Math.max(-1, Math.min(1, pan));
      track.pan = clamped;
      // Smooth ramp over 30 ms so a slider drag doesn't zipper.
      if (track.panNode) {
        try {
          const ctx = getCtx();
          track.panNode.pan.cancelScheduledValues(ctx.currentTime);
          track.panNode.pan.linearRampToValueAtTime(clamped, ctx.currentTime + 0.03);
        } catch { track.panNode.pan.value = clamped; }
      }
      set({ loadedTracks: new Map(loadedTracks) });
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
    },

    setTrackBusSend: (trackId, send) => {
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const clamped = Math.max(0, Math.min(1, send));
      track.busSend = clamped;
      if (track.busSendNode) {
        try {
          const ctx = getCtx();
          track.busSendNode.gain.cancelScheduledValues(ctx.currentTime);
          track.busSendNode.gain.linearRampToValueAtTime(clamped, ctx.currentTime + 0.03);
        } catch { track.busSendNode.gain.value = clamped; }
      }
      set({ loadedTracks: new Map(loadedTracks) });
      window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
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
      // Two-phase commit: a slider drag fires this many times per
      // second, so doing the WSOLA rebuild every time freezes the UI
      // and starves the audio thread (silence on the pitched track
      // for the duration of every stretch pass — accumulating into
      // an off-grid drift the user reported as "warp breaks").
      //
      //   Phase 1 (instant): write the new pitch to the store and
      //     ramp the live source's playbackRate to the new factor.
      //     Audio responds immediately; pitch is briefly *coupled to
      //     speed* during the drag (vinyl-style), which is fine.
      //
      //   Phase 2 (debounced): rebuild the play buffer via
      //     composePlayBuffer and restart so duration is preserved
      //     against the grid. Cancelled and rescheduled on every
      //     subsequent pitch change, so a fast drag pays for ONE
      //     stretch pass when the user releases — not one per tick.
      const { loadedTracks } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, semitones));

      // Phase 1 — instant. Update the store with just the new `pitch`
      // value (preserving the existing buffer / trim / warpMarkers so
      // the source keeps playing) and ramp the live playbackRate.
      {
        const m = new Map(loadedTracks);
        m.set(trackId, { ...track, pitch });
        set({ loadedTracks: m });
        if (track.source) {
          try {
            const ctx = getCtx();
            const t = ctx.currentTime;
            const newRate = Math.pow(2, pitch / 12);
            track.source.playbackRate.cancelScheduledValues(t);
            track.source.playbackRate.linearRampToValueAtTime(newRate, t + 0.04);
          } catch { /* ignore — source may have just ended */ }
        }
      }

      // Phase 2 — debounced commit. Rebuilds the buffer + restarts so
      // the duration stays grid-locked. 120 ms is short enough that
      // a quick release feels responsive, long enough that a typical
      // slider drag (continuous events at 16 ms cadence) collapses
      // into a single stretch pass.
      const prev = pitchCommitTimers.get(trackId);
      if (prev) clearTimeout(prev);
      pitchCommitTimers.set(trackId, setTimeout(() => {
        pitchCommitTimers.delete(trackId);
        const cur = get().loadedTracks.get(trackId);
        if (!cur || cur.pitch !== pitch) return;
        const m = new Map(get().loadedTracks);
        if (cur.source) safeStop(cur.source);
        if (cur.gainNode) { try { cur.gainNode.disconnect(); } catch { /* ignore */ } }
        const oldLen = cur.buffer.duration;
        // Marker rescale is relative to the LAST-COMMITTED pitch (the
        // pitch the buffer/markers currently belong to), not to
        // cur.pitch (which phase 1 has already advanced). Default to
        // 0 for the first commit before this map has an entry.
        const lastCommitted = trackCommittedPitch.get(trackId) ?? 0;
        const oldPitchFactor = Math.pow(2, lastCommitted / 12);
        const newPitchFactor = Math.pow(2, pitch / 12);
        const markerRatio = newPitchFactor / oldPitchFactor;
        const scaledMarkers = rescaleWarpMarkers(cur.warpMarkers, markerRatio);
        const next = composePlayBuffer({ ...cur, pitch, warpMarkers: scaledMarkers }, get().projectBpm);
        const ratio = oldLen > 0 ? next.buffer.duration / oldLen : 1;
        const trimStart = cur.trimStart * ratio;
        const trimEnd = cur.trimEnd * ratio;
        m.set(trackId, { ...cur, pitch, buffer: next.buffer, trimStart, trimEnd, warpMarkers: scaledMarkers, source: null, gainNode: null });
        set({ loadedTracks: m, bufferVersion: get().bufferVersion + 1 });
        trackCommittedPitch.set(trackId, pitch);
        restartIfPlaying();
        window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
      }, 120));
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
      const { loadedTracks, projectBpm } = get();
      const track = loadedTracks.get(trackId);
      if (!track) return;
      const sorted = markers
        .filter((m) => m && Number.isFinite(m.sourceSec) && Number.isFinite(m.bufferSec) && m.sourceSec >= 0 && m.bufferSec >= 0)
        .sort((a, b) => a.sourceSec - b.sourceSec);
      track.warpMarkers = sorted;
      // Worklet path — controller is live; just push the new params and
      // the next 128-sample block picks them up. No buffer rebuild, no
      // playback restart, no main-thread WSOLA. Buffer/trim stay where
      // they are so the visual waveform doesn't churn either (visual
      // updates from the buffer rebuild that happens lazily on next
      // play / pitch / warp change).
      if (track.workletController) {
        track.workletController.setParams(workletParamsFromTrack(track, projectBpm));
        set({ loadedTracks: new Map(loadedTracks), bufferVersion: get().bufferVersion + 1 });
        window.dispatchEvent(new CustomEvent('ghost-save-arrangement'));
        return;
      }
      // BufferSource path — rebuild the play buffer through
      // composePlayBuffer (piecewise stretch when markers are present).
      // Scale trim by the buffer-length change so markers stay pinned
      // to the same musical positions.
      if (track.originalBuffer) {
        if (track.source) safeStop(track.source);
        if (track.gainNode) { try { track.gainNode.disconnect(); } catch { /* ignore */ } }
        const oldLen = track.buffer.duration;
        const next = composePlayBuffer(track, projectBpm);
        const ratio = oldLen > 0 ? next.buffer.duration / oldLen : 1;
        track.buffer = next.buffer;
        track.trimStart = track.trimStart * ratio;
        track.trimEnd = track.trimEnd * ratio;
        track.source = null;
        track.gainNode = null;
      }
      set({ loadedTracks: new Map(loadedTracks), bufferVersion: get().bufferVersion + 1 });
      restartIfPlaying();
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
          pan: track.pan,
          busSend: track.busSend,
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
          existing.pan = (clip as any).pan ?? 0;
          existing.busSend = (clip as any).busSend ?? 0;
          if (existing.busSendNode) {
            try { existing.busSendNode.gain.value = Math.max(0, Math.min(1, existing.busSend || 0)); } catch { /* ignore */ }
          }
          if (existing.panNode) {
            try { existing.panNode.pan.value = Math.max(-1, Math.min(1, existing.pan || 0)); } catch { /* ignore */ }
          }
          // Migrate old `number[]` format from the first warp-marker
          // commit into the new {sourceSec, bufferSec} object form.
          // bufferSec defaults to sourceSec * baseStretch so old markers
          // play the same as before until the user drags them.
          const rawMarkers = (clip as any).warpMarkers;
          if (Array.isArray(rawMarkers) && rawMarkers.length > 0 && typeof rawMarkers[0] === 'number') {
            const sourceBpm = (clip.bpm && clip.bpm > 0) ? clip.bpm : (existing.detectedBpm ?? 0);
            const warpFactor = (clip.warp !== false && sourceBpm > 0 && projectBpm > 0) ? (sourceBpm / projectBpm) : 1;
            const pitchFactor = Math.pow(2, (clip.pitch || 0) / 12);
            const baseStretch = warpFactor * pitchFactor;
            existing.warpMarkers = (rawMarkers as number[]).map((s) => ({ sourceSec: s, bufferSec: s * baseStretch }));
          } else {
            existing.warpMarkers = rawMarkers;
          }
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
          existing.pan = (clip as any).pan ?? 0;
          existing.busSend = (clip as any).busSend ?? 0;
          if (existing.busSendNode) {
            try { existing.busSendNode.gain.value = Math.max(0, Math.min(1, existing.busSend || 0)); } catch { /* ignore */ }
          }
          if (existing.panNode) {
            try { existing.panNode.pan.value = Math.max(-1, Math.min(1, existing.pan || 0)); } catch { /* ignore */ }
          }
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
      // Drop every per-track EQ + Comp + Reverb chain so the next
      // project doesn't inherit orphan filter / worklet / convolver
      // nodes.
      disposeAllTrackEq();
      disposeAllTrackComp();
      disposeAllTrackReverb();
      pitchCommitTimers.forEach((t) => clearTimeout(t));
      pitchCommitTimers.clear();
      trackCommittedPitch.clear();
      set({
        isPlaying: false, currentTime: 0, loadedTracks: new Map(), duration: 0,
        projectBpm: 0, soloPlayingTrackId: null, soloCurrentTime: 0, soloDuration: 0,
        canUndo: false, canRedo: false,
      });
    },
  };
});

// Rebuild the drum-rack effect chain wired between drumBus and the
// mixer. Called on rewire AND at module load so the rack picks up
// any persisted chain even before the user presses play.
function rebuildDrumBusFx() {
  try {
    const ctx = getCtx();
    // Tear down whatever was registered on the drum-rack key last
    // pass so we don't leak biquad / compressor nodes across rewires.
    removeTrackEq(DRUM_RACK_FX_KEY);
    removeTrackComp(DRUM_RACK_FX_KEY);
    removeTrackReverb(DRUM_RACK_FX_KEY);
    const chain = useEffectsStore.getState().getChain(DRUM_RACK_FX_KEY);
    if (!chain || chain.length === 0) {
      wireDrumBusOutput(null);
      return;
    }
    let firstInput: AudioNode | null = null;
    let cursor: AudioNode | null = null;
    for (const fx of chain) {
      try {
        let stage: { input: AudioNode; output: AudioNode } | null = null;
        if (fx.kind === 'eq' && fx.params && 'bands' in fx.params) {
          stage = buildTrackEqChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, (fx.params as EqParams).bands as any, fx.bypassed);
        } else if (fx.kind === 'comp' && fx.params && 'threshold' in fx.params) {
          stage = buildTrackCompChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, fx.params as CompParams, fx.bypassed);
        } else if (fx.kind === 'reverb' && fx.params && 'mix' in fx.params) {
          stage = buildTrackReverbChain(ctx, DRUM_RACK_FX_KEY, DRUM_RACK_FX_KEY, fx.params as ReverbParams, fx.bypassed);
        }
        if (!stage) continue;
        if (!firstInput) firstInput = stage.input;
        if (cursor) cursor.connect(stage.input);
        cursor = stage.output;
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[audioStore] drum bus FX build failed for', fx.kind, err);
      }
    }
    if (firstInput && cursor) {
      wireDrumBusOutput({ input: firstInput, output: cursor });
    } else {
      wireDrumBusOutput(null);
    }
  } catch { /* audio not initialised yet — wireDrumBusOutput re-init is a no-op */ }
}

// Hot-rewire on FX add / remove. effectsStore fires `ghost-fx-rewire`
// whenever the chain shape changes — we seek to the current position
// to force startAllSources to rebuild with the new chain. Sub-millisecond
// click is the trade-off for hot add/remove of effects mid-playback.
if (typeof window !== 'undefined') {
  window.addEventListener('ghost-fx-rewire', () => {
    rebuildDrumBusFx();
    const s = useAudioStore.getState();
    if (!s.isPlaying) return;
    s.seekTo(s.currentTime);
  });
}
