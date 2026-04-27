import { FFT_SIZE, SMOOTHING_TIME_CONSTANT } from '../../lib/constants';

/**
 * Audio routing — Ableton/FL Studio style bus architecture.
 *
 *   Track / drum source → trackGain ─┐
 *                                    ├──→ mixerBus → masterGain ──→ destination
 *   Track / drum source → trackGain ─┘                            ↘
 *                                                                   masterAnalyser  (parallel meter — does NOT chain on)
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

  // Audio path — kept as short as possible.
  mixerBus.connect(masterGain);
  masterGain.connect(audioCtx.destination);

  // Parallel branch — meter only. Crucially does NOT connect to anything
  // downstream, so it's a passive observer of the master signal.
  masterGain.connect(masterAnalyser);
}

export function getCtx(): AudioContext {
  if (!audioCtx) init();
  return audioCtx!;
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
