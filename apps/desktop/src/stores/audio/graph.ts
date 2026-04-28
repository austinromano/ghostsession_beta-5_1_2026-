import { FFT_SIZE, SMOOTHING_TIME_CONSTANT } from '../../lib/constants';

/**
 * Audio routing — Ableton/FL Studio style bus architecture.
 *
 *   Track / drum source → trackGain ─┐
 *                                    ├──→ mixerBus → masterGain ──→ destination
 *   Track / drum source → trackGain ─┘                ↑          ↘
 *                                                     │            masterAnalyser  (parallel meter)
 *                          per-track sendNode ───→ reverbBus → convolver → reverbReturn ─┘
 *
 * Reverb send bus is the channel-strip's first FX return — every track has
 * a per-track sendNode tapped post-pan that feeds a single shared
 * convolver. The wet output mixes back into the mixer bus through a
 * reverbReturn fader so the user can blend wet vs. dry on the master
 * without re-tweaking every send. ConvolverNode IR is generated
 * synthetically (exponential-decay noise) so we don't ship an IR file.
 *
 * Three reasons this matters:
 *   1. Single mixer bus is the natural place to hang sends, FX returns, and
 *      eventually a UI mixer with channel strips.
 *   2. Meters tap off masterGain in PARALLEL — they don't sit in the audio
 *      path. AnalyserNode is spec'd as transparent but every node in series
 *      adds a render-quantum of latency and a numerical pass; keeping the
 *      output chain as short as possible (gain → masterGain → destination)
 *      preserves the cleanest signal.
 *   3. getMaster() still returns the entry point everything connects to,
 *      so existing callers (audioStore.startAllSources, drumRackStore
 *      scheduler) keep working without a rename.
 */

let audioCtx: AudioContext | null = null;
let mixerBus: GainNode | null = null;
let masterGain: GainNode | null = null;
let masterAnalyser: AnalyserNode | null = null;
// Brickwall limiter on the master output. Inserted asynchronously once
// the worklet registers (init() builds the graph without it, then
// hot-swaps the master→destination edge through the limiter).
let masterLimiter: AudioWorkletNode | null = null;
// Drum sub-bus: every drum row sums into here, then drumBus → mixerBus.
// Lets the Drum Rack lane meter tap the SUM of all drum hits in
// parallel without affecting the audio path.
let drumBus: GainNode | null = null;
let drumAnalyser: AnalyserNode | null = null;
// Reverb send bus — every per-track sendNode connects into reverbBus,
// which feeds a single shared ConvolverNode. The wet output runs through
// reverbReturn (a master wet-level fader) and mixes back into mixerBus.
let reverbBus: GainNode | null = null;
let reverbConvolver: ConvolverNode | null = null;
let reverbReturn: GainNode | null = null;
let reverbDecaySec = 1.8; // current IR decay length — drives regenerateReverbIR()

function init() {
  // `latencyHint: 'playback'` lets the browser allocate larger buffers and
  // use higher-quality resampling at the cost of a few extra ms of delay.
  // For a DAW where the user listens to playback (not live monitoring),
  // that trade is the right one and noticeably tightens the sound.
  audioCtx = new AudioContext({ latencyHint: 'playback' });

  mixerBus = audioCtx.createGain();
  mixerBus.gain.value = 1;

  masterGain = audioCtx.createGain();
  // Restore the user's persisted master fader value before any source
  // has connected — otherwise the first frame would always play at unity
  // and the slider would visibly snap into place a tick later.
  let savedMaster = 1;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('ghost_master_volume') : null;
    const v = raw ? parseFloat(raw) : NaN;
    if (isFinite(v) && v >= 0 && v <= 1.5) savedMaster = v;
  } catch { /* default unity */ }
  masterGain.gain.value = savedMaster;

  masterAnalyser = audioCtx.createAnalyser();
  masterAnalyser.fftSize = FFT_SIZE;
  masterAnalyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;

  drumBus = audioCtx.createGain();
  drumBus.gain.value = 1;
  drumAnalyser = audioCtx.createAnalyser();
  drumAnalyser.fftSize = FFT_SIZE;
  drumAnalyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT;

  // Reverb send bus + return path. Built once at graph init so per-track
  // sends can connect into reverbBus the moment a track starts playing.
  reverbBus = audioCtx.createGain();
  reverbBus.gain.value = 1; // bus-level trim, fixed at unity for now
  reverbConvolver = audioCtx.createConvolver();
  reverbConvolver.normalize = true;
  reverbReturn = audioCtx.createGain();
  // Persisted master wet-return level. 0.35 default — enough to be
  // audible when the user pushes any send up but quiet enough that it
  // doesn't dominate at moderate send levels.
  let savedReverbReturn = 0.35;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('ghost_reverb_return') : null;
    const v = raw ? parseFloat(raw) : NaN;
    if (isFinite(v) && v >= 0 && v <= 1.5) savedReverbReturn = v;
  } catch { /* default 0.35 */ }
  reverbReturn.gain.value = savedReverbReturn;
  // Persisted decay length. Drives the synthetic IR — regenerated below.
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('ghost_reverb_decay') : null;
    const v = raw ? parseFloat(raw) : NaN;
    if (isFinite(v) && v >= 0.1 && v <= 6) reverbDecaySec = v;
  } catch { /* default 1.8 */ }
  reverbConvolver.buffer = buildReverbIR(audioCtx, reverbDecaySec);
  reverbBus.connect(reverbConvolver);
  reverbConvolver.connect(reverbReturn);
  reverbReturn.connect(mixerBus);

  // Audio path — kept as short as possible.
  drumBus.connect(mixerBus);
  mixerBus.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // Parallel meter branches — each connects to an analyser that does NOT
  // chain on, so they're passive observers of the bus they tap.
  drumBus.connect(drumAnalyser);
  masterGain.connect(masterAnalyser);

  // Async-install the brickwall limiter on the master path. While it's
  // loading, audio runs through the direct masterGain → destination
  // edge built above. Once the worklet registers we swap that edge
  // for masterGain → masterLimiter → destination atomically per
  // render quantum (a brief click is unlikely; below-ceiling audio
  // passes through transparent).
  ensureMasterLimiterWorklet().then(() => {
    if (!audioCtx || !masterGain) return;
    if (masterLimiter) return; // already installed
    try {
      masterLimiter = new AudioWorkletNode(audioCtx, 'master-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      masterGain.disconnect(audioCtx.destination);
      masterGain.connect(masterLimiter);
      masterLimiter.connect(audioCtx.destination);
    } catch (err) {
      // Worklet failed to construct — leave the direct edge in place
      // so audio still reaches the destination.
      if (typeof console !== 'undefined') console.warn('[graph] master limiter install failed', err);
    }
  }).catch((err) => {
    if (typeof console !== 'undefined') console.warn('[graph] master limiter not registered', err);
  });
}

/**
 * Generate a synthetic stereo impulse response — exponentially-decaying
 * white noise. Cheap, fileless, and tweakable in real time. Decoupled
 * left/right channels give the reverb a natural stereo width.
 */
function buildReverbIR(ctx: AudioContext, decaySec: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(decaySec * sampleRate));
  const ir = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      // Exponential decay envelope, 60 dB drop over decaySec — a
      // standard "RT60-shaped" tail. Random noise gives a dense diffuse
      // reverb without needing early reflections.
      const t = i / length;
      const env = Math.pow(1 - t, 3);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return ir;
}

export function getCtx(): AudioContext {
  if (!audioCtx) init();
  return audioCtx!;
}

/** Reverb send bus — per-track sendNodes connect into THIS GainNode. */
export function getReverbBus(): GainNode {
  if (!reverbBus) init();
  return reverbBus!;
}

/** Master wet-return fader for the reverb bus. */
export function getReverbReturn(): GainNode {
  if (!reverbReturn) init();
  return reverbReturn!;
}

/** Current reverb decay length, in seconds. */
export function getReverbDecay(): number {
  if (!reverbConvolver) init();
  return reverbDecaySec;
}

/**
 * Regenerate the convolver IR for a new decay length. Cheap — a fresh
 * IR for a 5-second tail at 48 kHz is ~1 MB and takes a few ms to
 * synthesise. Swapping the buffer on a live ConvolverNode is supported
 * by the spec and produces a click-free transition because the old
 * tail's reverberant energy fades naturally as it convolves through.
 */
export function setReverbDecay(seconds: number) {
  if (!audioCtx || !reverbConvolver) init();
  const clamped = Math.max(0.1, Math.min(6, seconds));
  reverbDecaySec = clamped;
  reverbConvolver!.buffer = buildReverbIR(audioCtx!, clamped);
  try { localStorage.setItem('ghost_reverb_decay', String(clamped)); } catch { /* ignore */ }
}

/**
 * Entry point for every track / drum row. Connect into THIS node — under
 * the hood it lands on the mixer bus, which then runs through the master
 * fader to the destination. Same name as before so existing call sites
 * keep working without a refactor.
 */
export function getMaster(): GainNode {
  if (!mixerBus) init();
  return mixerBus!;
}

/** Direct handle to the master fader, for a future master-volume UI. */
export function getMasterFader(): GainNode {
  if (!masterGain) init();
  return masterGain!;
}

/**
 * Drum sub-bus. Drum row buffer sources connect their per-row gain →
 * per-row analyser → drumBus, so the drum-rack-lane meter sees the SUM
 * of every row through `getDrumAnalyser()`.
 */
export function getDrumBus(): GainNode {
  if (!drumBus) init();
  return drumBus!;
}

export function getDrumAnalyser(): AnalyserNode {
  if (!drumAnalyser) init();
  return drumAnalyser!;
}

export function getAnalyser(): AnalyserNode {
  // Force init so the master meter has something to tap even before the
  // first track loads — otherwise the meter mounts, sees `null`, bails
  // out, and never paints a single frame.
  if (!masterAnalyser) init();
  return masterAnalyser!;
}

export function safeStop(source: AudioBufferSourceNode | null) {
  if (!source) return;
  try { source.stop(); } catch { /* already stopped */ }
}

// AudioWorklet registration. Each processor file lives under
// apps/desktop/public/ so Vite copies it as a static asset. We load
// each lazily on first use because addModule is async and we don't
// want to block app startup on it.
let warpedPlaybackReady: Promise<void> | null = null;
export function ensureWarpedPlaybackWorklet(): Promise<void> {
  if (warpedPlaybackReady) return warpedPlaybackReady;
  const ctx = getCtx();
  warpedPlaybackReady = ctx.audioWorklet
    .addModule('/warped-playback-worklet.js')
    .catch((err) => { warpedPlaybackReady = null; throw err; });
  return warpedPlaybackReady;
}

let masterLimiterReady: Promise<void> | null = null;
export function ensureMasterLimiterWorklet(): Promise<void> {
  if (masterLimiterReady) return masterLimiterReady;
  const ctx = getCtx();
  masterLimiterReady = ctx.audioWorklet
    .addModule('/master-limiter-worklet.js')
    .catch((err) => { masterLimiterReady = null; throw err; });
  return masterLimiterReady;
}

let trackCompressorReady: Promise<void> | null = null;
export function ensureTrackCompressorWorklet(): Promise<void> {
  if (trackCompressorReady) return trackCompressorReady;
  const ctx = getCtx();
  trackCompressorReady = ctx.audioWorklet
    .addModule('/track-compressor-worklet.js')
    .catch((err) => { trackCompressorReady = null; throw err; });
  return trackCompressorReady;
}

/**
 * Try to construct a track-compressor AudioWorkletNode. Returns null if
 * the worklet hasn't loaded yet — callers should fall back to a plain
 * passthrough connection so the chain still produces audio while the
 * worklet finishes registering. Subsequent calls succeed once the
 * registration promise resolves.
 */
export function createTrackCompressorNode(): AudioWorkletNode | null {
  const ctx = getCtx();
  try {
    return new AudioWorkletNode(ctx, 'track-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  } catch {
    return null;
  }
}

/**
 * Construct a `warped-playback` AudioWorkletNode with the source buffer
 * already pushed across the message port. Returns the node + a small
 * controller wrapping its port so call sites don't have to know the
 * message protocol. Caller is responsible for connecting the node into
 * the graph (typically → trackGain → mixerBus) and for calling stop()
 * + disconnect() at the end of playback.
 */
export interface WarpedPlaybackController {
  node: AudioWorkletNode;
  setParams: (p: WarpedParams) => void;
  play: (startCtxTime: number, startProjectSec: number) => void;
  stop: () => void;
  dispose: () => void;
}

export interface WarpedParams {
  markers: Array<{ sourceSec: number; bufferSec: number }>;
  baseStretch: number;
  pitchFactor: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
}

export function createWarpedPlaybackNode(buffer: AudioBuffer): WarpedPlaybackController {
  const ctx = getCtx();
  const node = new AudioWorkletNode(ctx, 'warped-playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [buffer.numberOfChannels],
  });
  // Snapshot every channel's data into a transferable array of
  // Float32Arrays. Using `slice()` so we don't touch the source
  // AudioBuffer's internal storage.
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch).slice());
  }
  node.port.postMessage(
    { type: 'init', channels, sampleRate: buffer.sampleRate },
    channels.map((c) => c.buffer),
  );
  return {
    node,
    setParams: (p) => node.port.postMessage({ type: 'params', ...p }),
    play: (startCtxTime, startProjectSec) =>
      node.port.postMessage({ type: 'play', startCtxTime, startProjectSec }),
    stop: () => node.port.postMessage({ type: 'stop' }),
    dispose: () => {
      try { node.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
    },
  };
}
