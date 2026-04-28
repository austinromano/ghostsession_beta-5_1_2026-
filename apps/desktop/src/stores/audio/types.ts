export interface LoadedTrack {
  id: string;
  buffer: AudioBuffer;          // buffer that actually plays — may be time-stretched
  source: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  // Tapped off the gain node so the lane header's level meter can read
  // per-track audio amplitude in real time. Lives only while playing.
  analyser?: AnalyserNode | null;
  volume: number;
  // Stereo position, -1 (full left) … 0 (centre) … +1 (full right).
  // Optional in the type so existing call sites that build LoadedTracks
  // before this field existed keep compiling — at runtime the audio
  // store treats undefined as 0.
  pan?: number;
  panNode?: StereoPannerNode | null;
  // Per-track 3-band channel-strip EQ. Three BiquadFilterNodes wired
  // in series before the trackGain. Optional in the type so existing
  // call sites that build LoadedTrack inline keep compiling — the
  // audio store treats undefined as the transparent default.
  eq?: TrackEq;
  eqLowNode?: BiquadFilterNode | null;
  eqMidNode?: BiquadFilterNode | null;
  eqHighNode?: BiquadFilterNode | null;
  // Per-track compressor. Worklet-based, sits after EQ and before the
  // gain stage. Optional in the type so existing call sites keep
  // compiling — undefined means "no compression configured" (the
  // worklet still inserts but defaults to ratio=1, which is bypass).
  comp?: TrackComp;
  compNode?: AudioWorkletNode | null;
  // Per-track reverb send level, 0..1. Drives sendNode.gain — the post-pan
  // tap that feeds the shared reverb bus. 0 = dry only.
  reverbSend?: number;
  reverbSendNode?: GainNode | null;
  muted: boolean;
  soloed: boolean;
  bpm: number;
  pitch: number;
  trimStart: number;   // seconds from buffer start
  trimEnd: number;     // seconds from buffer start (0 = use full length)
  startOffset: number; // seconds from project start (timeline position)
  // Phase 2+: tempo-aware playback metadata. When present, changing the
  // project BPM re-stretches `buffer` from `originalBuffer` so the sample
  // stays locked to the project's grid.
  originalBuffer?: AudioBuffer; // unstretched source (kept so BPM changes can re-stretch)
  detectedBpm?: number;         // sample's native tempo as analysed at upload
  firstBeatOffset?: number;     // seconds from start of ORIGINAL buffer to first detected beat
  beats?: number[];             // onset timestamps in ORIGINAL buffer time — drives transient-preserving stretch
  character?: 'percussive' | 'tonal' | 'mixed' | 'ambient'; // drives algorithm selection
  // Warp on/off. true (or undefined) = stretch to project BPM and snap by
  // first detected beat. false = play native and snap by clip leading edge
  // — what 808s, hits, FX, and any sample with bad BPM detection want.
  // Optional so existing call sites that build LoadedTracks elsewhere
  // (loadTrack, splitTrack, duplicateTrack) keep compiling without each
  // having to opt in explicitly.
  warp?: boolean;
  // User-pinned warp markers, Ableton-style. `sourceSec` is the
  // position in the ORIGINAL buffer the marker is anchored to;
  // `bufferSec` is where in the PLAY (pre-stretched) buffer that
  // anchor should land. composePlayBuffer reads this list and
  // piecewise-stretches each [m_i, m_{i+1}] source segment to fit the
  // matching [m_i, m_{i+1}] buffer segment.
  // Empty array → no manual markers → fall back to a single global
  // stretch factor.
  warpMarkers?: WarpMarker[];
  // When the track is playing through the AudioWorklet path (because
  // it has warp markers), this holds the controller for the worklet
  // node so we can post param updates without recreating the node.
  // Null on the BufferSource path.
  workletController?: WarpedPlaybackController | null;
}

export interface WarpedPlaybackController {
  node: AudioWorkletNode;
  setParams: (p: import('./graph').WarpedParams) => void;
  play: (startCtxTime: number, startProjectSec: number) => void;
  stop: () => void;
  dispose: () => void;
}

export interface WarpMarker {
  sourceSec: number;
  bufferSec: number;
}

/**
 * Per-track 3-band channel-strip EQ. Default fixed frequencies are
 * the classic FL / Logic / Ableton channel-strip layout: low shelf at
 * 80 Hz, mid peak at 1 kHz, high shelf at 8 kHz. Gain is in dB, range
 * −24…+24 to match what a normal mixer provides; 0 dB on every band
 * is fully transparent.
 */
export interface TrackEq {
  low: number;   // dB
  mid: number;   // dB
  high: number;  // dB
}

/**
 * Per-track compressor params. ratio = 1 is bypass (the worklet
 * fast-paths through, bit-perfect). threshold is in dBFS, attack /
 * release in seconds, makeup in dB applied post-compression.
 */
export interface TrackComp {
  threshold: number;  // dB,  -60..0
  ratio: number;      // 1..20  (1 = bypass)
  attack: number;     // sec, 0.0001..1
  release: number;    // sec, 0.001..1
  makeup: number;     // dB,  -20..+20
}

export interface UndoSnapshot {
  trackId: string;
  buffer: AudioBuffer;
  fileId?: string;
}

export interface ArrangementClipState {
  trackId: string;
  trimStart: number;
  trimEnd: number;
  startOffset: number;
  volume: number;
  pan?: number;
  eq?: TrackEq;
  comp?: TrackComp;
  reverbSend?: number;
  muted: boolean;
  soloed: boolean;
  pitch: number;
  // Manual BPM override — when set, takes precedence over the file's
  // detectedBpm for stretch calculations. Lets the user correct a wrong
  // detection or halve / double the tempo.
  bpm?: number;
  // Whether warp/stretch is active. Undefined ≡ true (default) so old
  // arrangement blobs without this field keep behaving the same.
  warp?: boolean;
  // User-pinned warp markers (sourceSec + bufferSec). Persisted with
  // the arrangement so the user's marker placements survive a reload.
  warpMarkers?: WarpMarker[];
  parentTrackId?: string;
  parentFileId?: string;
}

export interface ArrangementState {
  clips: ArrangementClipState[];
}
