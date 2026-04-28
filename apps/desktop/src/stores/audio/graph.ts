import { FFT_SIZE, SMOOTHING_TIME_CONSTANT } from '../../lib/constants';

/**
 * Audio routing — single FX-bus architecture.
 *
 *   Track / drum source → trackGain → trackPan ─┐
 *                                                ├──→ fxBusInput
 *                                                │       │
 *                                                │       ▼
 *                                                │   busEqLow → busEqMid → busEqHigh → busComp ─┬──→ busDry ──┐
 *                                                │                                              └──→ convolver → busWet ─┤
 *                                                │                                                                       ▼
 *                                                │                                                                  fxBusOut → mixerBus → masterGain → limiter → destination
 *                                                │                                                                                ↘
 *                                                │                                                                                  masterAnalyser  (parallel meter)
 *                                                ▼
 *                                       (or dry-direct-to-mixerBus path for tracks that opt-out — future)
 *
 * Master FX bus replaces the per-track EQ / Comp / Reverb-send model. Every
 * track / drum row routes into fxBusInput, the bus chain processes the
 * signal once, and the wet/dry mix lands on the mixer. One UI surface
 * controls every FX param — clicking the bus track opens the channel
 * strip showing EQ + Comp + Reverb side-by-side.
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
 *      scheduler) keep working without a rename — they now land on the
 *      FX bus input instead of mixerBus directly.
 */

let audioCtx: AudioContext | null = null;
let mixerBus: GainNode | null = null;
let masterGain: GainNode | null = null;
let masterAnalyser: AnalyserNode | null = null;
// Brickwall limiter on the master output. Inserted asynchronously once
// the worklet registers (init() builds the graph without it, then
// hot-swaps the master→destination edge through the limiter).
let masterLimiter: AudioWorkletNode | null = null;
// Drum sub-bus: every drum row sums into here, then drumBus → fxBusInput
// (so drum hits get FX'd by the master bus alongside tracks).
let drumBus: GainNode | null = null;
let drumAnalyser: AnalyserNode | null = null;

// FX bus — the channel strip that processes every track. Lives between
// the per-track pan stage and the mixerBus. Inputs (tracks, drum bus)
// land on fxBusInput; the chain runs eq → comp → wet/dry split → fxBusOut,
// and fxBusOut feeds the mixer.
let fxBusInput: GainNode | null = null;
let busEqLow: BiquadFilterNode | null = null;
let busEqMid: BiquadFilterNode | null = null;
let busEqHigh: BiquadFilterNode | null = null;
let busComp: AudioWorkletNode | null = null;
// Hot bypass node used while the compressor worklet finishes registering.
// Audio routes input → bypass → wet/dry split until the worklet is
// available, then we splice the worklet in atomically.
let busCompBypass: GainNode | null = null;
let busDry: GainNode | null = null;
let busWet: GainNode | null = null;
let busConvolver: ConvolverNode | null = null;
let fxBusOut: GainNode | null = null;
let busDecaySec = 1.8;

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

  // Build the FX bus. Persisted values for EQ / Comp / Reverb wet+decay
  // come from localStorage so the bus's processing state survives a
  // reload. Defaults are the channel-strip-transparent values
  // (every band 0 dB, ratio 1, wet 0%).
  fxBusInput = audioCtx.createGain();
  fxBusInput.gain.value = 1;

  busEqLow = audioCtx.createBiquadFilter();
  busEqLow.type = 'lowshelf';
  busEqLow.frequency.value = 80;
  busEqLow.gain.value = readNumber('ghost_bus_eq_low', -24, 24, 0);

  busEqMid = audioCtx.createBiquadFilter();
  busEqMid.type = 'peaking';
  busEqMid.frequency.value = 1000;
  busEqMid.Q.value = 0.7;
  busEqMid.gain.value = readNumber('ghost_bus_eq_mid', -24, 24, 0);

  busEqHigh = audioCtx.createBiquadFilter();
  busEqHigh.type = 'highshelf';
  busEqHigh.frequency.value = 8000;
  busEqHigh.gain.value = readNumber('ghost_bus_eq_high', -24, 24, 0);

  // Bypass between EQ chain and the wet/dry split — replaced by the
  // compressor worklet once it registers.
  busCompBypass = audioCtx.createGain();
  busCompBypass.gain.value = 1;

  busDry = audioCtx.createGain();
  busDry.gain.value = 1;
  busWet = audioCtx.createGain();
  busWet.gain.value = readNumber('ghost_bus_reverb_wet', 0, 1, 0);

  busConvolver = audioCtx.createConvolver();
  busConvolver.normalize = true;
  busDecaySec = readNumber('ghost_bus_reverb_decay', 0.1, 6, 1.8);
  busConvolver.buffer = buildReverbIR(audioCtx, busDecaySec);

  fxBusOut = audioCtx.createGain();
  fxBusOut.gain.value = 1;

  // Wire it together: input → eq → comp-bypass → splits → out → mixer.
  fxBusInput.connect(busEqLow);
  busEqLow.connect(busEqMid);
  busEqMid.connect(busEqHigh);
  busEqHigh.connect(busCompBypass);
  busCompBypass.connect(busDry);
  busCompBypass.connect(busConvolver);
  busConvolver.connect(busWet);
  busDry.connect(fxBusOut);
  busWet.connect(fxBusOut);
  fxBusOut.connect(mixerBus);

  // Audio path — kept as short as possible. Tracks and the drum bus
  // route DRY to mixerBus directly. Per-track sendNodes (created in
  // audioStore.startAllSources) tap into fxBusInput in parallel for
  // FX'd signal — classic send/return architecture.
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

  // Splice the bus compressor in once its worklet registers. Same
  // hot-swap pattern as the master limiter — replaces busCompBypass with
  // a real worklet without dropping audio.
  ensureTrackCompressorWorklet().then(() => {
    if (!audioCtx || !busEqHigh || !busDry || !busConvolver || busComp || !busCompBypass) return;
    try {
      busComp = new AudioWorkletNode(audioCtx, 'track-compressor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      // Apply persisted comp params before splicing so the first
      // render quantum already runs at the user's settings.
      const setParam = (name: string, v: number) => {
        const p = (busComp!.parameters as unknown as Map<string, AudioParam>).get(name);
        if (p) p.value = v;
      };
      setParam('threshold', readNumber('ghost_bus_comp_threshold', -60, 0, 0));
      setParam('ratio', readNumber('ghost_bus_comp_ratio', 1, 20, 1));
      setParam('attack', 0.003);
      setParam('release', 0.1);
      setParam('makeup', readNumber('ghost_bus_comp_makeup', -20, 20, 0));
      // Atomic re-route: disconnect bypass → splits, then wire eq → comp → splits.
      try { busEqHigh.disconnect(busCompBypass); } catch { /* ignore */ }
      try { busCompBypass.disconnect(); } catch { /* ignore */ }
      busEqHigh.connect(busComp);
      busComp.connect(busDry);
      busComp.connect(busConvolver);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[graph] bus compressor install failed', err);
    }
  }).catch((err) => {
    if (typeof console !== 'undefined') console.warn('[graph] bus compressor worklet not registered', err);
  });
}

function readNumber(key: string, min: number, max: number, fallback: number): number {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(key) : null;
    const v = raw ? parseFloat(raw) : NaN;
    if (isFinite(v) && v >= min && v <= max) return v;
  } catch { /* fall through */ }
  return fallback;
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
      // Exponential decay envelope. Random noise gives a dense diffuse
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

/**
 * FX bus input — per-track sendNodes connect into THIS GainNode. The bus
 * runs the EQ → Comp → Reverb chain and sums its output back into the
 * mixer alongside the dry track signals. Tracks at busSend = 0 stay
 * fully dry; turning the send up routes more of the track through the FX.
 */
export function getFxBusInput(): GainNode {
  if (!fxBusInput) init();
  return fxBusInput!;
}

/**
 * Update one of the bus EQ band gains. Smooth-ramps over 30 ms so a
 * slider drag doesn't zipper. Values clamped to ±24 dB.
 */
export function setBusEqBand(band: 'low' | 'mid' | 'high', dB: number) {
  if (!audioCtx) init();
  const node = band === 'low' ? busEqLow : band === 'mid' ? busEqMid : busEqHigh;
  if (!node) return;
  const v = Math.max(-24, Math.min(24, dB));
  try {
    node.gain.cancelScheduledValues(audioCtx!.currentTime);
    node.gain.linearRampToValueAtTime(v, audioCtx!.currentTime + 0.03);
  } catch { node.gain.value = v; }
  try { localStorage.setItem(`ghost_bus_eq_${band}`, String(v)); } catch { /* ignore */ }
}

export function getBusEqBand(band: 'low' | 'mid' | 'high'): number {
  if (!audioCtx) init();
  const node = band === 'low' ? busEqLow : band === 'mid' ? busEqMid : busEqHigh;
  return node?.gain.value ?? 0;
}

/**
 * Update bus compressor params. No-op if the worklet hasn't registered
 * yet (the bypass node passes audio through unchanged in the meantime,
 * and the persisted localStorage value gets applied when init() splices
 * the worklet in). Smooth-ramps each k-rate param.
 */
export function setBusCompParam(field: 'threshold' | 'ratio' | 'makeup', v: number) {
  if (!audioCtx) init();
  const ranges = { threshold: [-60, 0], ratio: [1, 20], makeup: [-20, 20] } as const;
  const [min, max] = ranges[field];
  const clamped = Math.max(min, Math.min(max, v));
  try { localStorage.setItem(`ghost_bus_comp_${field}`, String(clamped)); } catch { /* ignore */ }
  if (!busComp) return;
  const p = (busComp.parameters as unknown as Map<string, AudioParam>).get(field);
  if (!p) return;
  try {
    p.cancelScheduledValues(audioCtx!.currentTime);
    p.linearRampToValueAtTime(clamped, audioCtx!.currentTime + 0.03);
  } catch { p.value = clamped; }
}

export function getBusCompParam(field: 'threshold' | 'ratio' | 'makeup'): number {
  if (!audioCtx) init();
  const fallback = field === 'ratio' ? 1 : 0;
  if (!busComp) return readNumber(`ghost_bus_comp_${field}`, -60, 20, fallback);
  const p = (busComp.parameters as unknown as Map<string, AudioParam>).get(field);
  return p?.value ?? fallback;
}

/**
 * Update bus reverb wet level (0..1). 0 = fully dry, 1 = wet only.
 * The dry gain is fixed at unity — wet adds on top so the user is
 * always blending wet INTO the dry signal rather than crossfading.
 */
export function setBusReverbWet(level: number) {
  if (!audioCtx || !busWet) init();
  const v = Math.max(0, Math.min(1, level));
  try {
    busWet!.gain.cancelScheduledValues(audioCtx!.currentTime);
    busWet!.gain.linearRampToValueAtTime(v, audioCtx!.currentTime + 0.03);
  } catch { busWet!.gain.value = v; }
  try { localStorage.setItem('ghost_bus_reverb_wet', String(v)); } catch { /* ignore */ }
}

export function getBusReverbWet(): number {
  if (!busWet) init();
  return busWet?.gain.value ?? 0;
}

/**
 * Regenerate the convolver IR for a new decay length. Cheap — a fresh
 * IR for a 5-second tail at 48 kHz is ~1 MB and takes a few ms to
 * synthesise. Swapping the buffer on a live ConvolverNode is supported
 * by the spec and produces a click-free transition because the old
 * tail's reverberant energy fades naturally as it convolves through.
 */
export function setBusReverbDecay(seconds: number) {
  if (!audioCtx || !busConvolver) init();
  const clamped = Math.max(0.1, Math.min(6, seconds));
  busDecaySec = clamped;
  busConvolver!.buffer = buildReverbIR(audioCtx!, clamped);
  try { localStorage.setItem('ghost_bus_reverb_decay', String(clamped)); } catch { /* ignore */ }
}

export function getBusReverbDecay(): number {
  if (!busConvolver) init();
  return busDecaySec;
}

/**
 * Entry point for the DRY track signal. Connect into THIS node — it's
 * the mixer bus that feeds the master fader and the destination. The
 * FX bus runs in parallel: per-track sendNodes feed it via getFxBusInput().
 */
export function getMaster(): GainNode {
  if (!mixerBus) init();
  return mixerBus!;
}

/** Direct handle to the master fader, for the master-volume UI. */
export function getMasterFader(): GainNode {
  if (!masterGain) init();
  return masterGain!;
}

/**
 * Drum sub-bus. Drum row buffer sources connect their per-row gain →
 * per-row analyser → drumBus, so the drum-rack-lane meter sees the SUM
 * of every row through `getDrumAnalyser()`. drumBus → fxBusInput so
 * drum hits run through the same channel-strip FX as tracks.
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
 * Construct a `warped-playback` AudioWorkletNode with the source buffer
 * already pushed across the message port. Returns the node + a small
 * controller wrapping its port so call sites don't have to know the
 * message protocol. Caller is responsible for connecting the node into
 * the graph (typically → trackGain → trackPan → fxBusInput) and for
 * calling stop() + disconnect() at the end of playback.
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
