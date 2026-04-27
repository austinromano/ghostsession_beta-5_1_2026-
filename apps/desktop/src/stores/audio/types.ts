export interface LoadedTrack {
  id: string;
  buffer: AudioBuffer;          // buffer that actually plays — may be time-stretched
  source: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  // Tapped off the gain node so the lane header's level meter can read
  // per-track audio amplitude in real time. Lives only while playing.
  analyser?: AnalyserNode | null;
  volume: number;
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
  // User-pinned warp markers, in ORIGINAL buffer seconds. Empty array
  // means "no manual warp markers" — playback uses the global stretch
  // factor. When populated, future versions will warp each segment
  // between markers independently (Ableton-style). For now they're
  // visual + interactive only.
  warpMarkers?: number[];
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
  // User-pinned warp markers in original-buffer seconds. Persisted with
  // the arrangement so the user's marker placements survive a reload.
  warpMarkers?: number[];
  parentTrackId?: string;
  parentFileId?: string;
}

export interface ArrangementState {
  clips: ArrangementClipState[];
}
