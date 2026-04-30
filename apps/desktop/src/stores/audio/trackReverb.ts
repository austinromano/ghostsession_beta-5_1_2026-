import type { ReverbParams } from '../effectsStore';

/**
 * Per-clip reverb DSP. Mirrors trackEq / trackComp's pattern: a
 * registry keyed by clip trackId, each entry carrying the live audio
 * nodes + bypass state.
 *
 * Signal flow per clip:
 *
 *   input ─┬─→ dryGain ─────────────────→ output
 *          └─→ predelay → convolver →
 *              damping (lowshelf+highshelf) →
 *              widthSplit (M/S width) →
 *              wetGain ───────────────────→ output
 *
 * Bypass = mute the wet path. The dry path stays at unity so audio
 * passes through untouched.
 *
 * IR is generated synthetically (exponentially-decaying noise with a
 * size-shaped early-reflection cluster) so we don't have to ship audio
 * files. Rebuilding the IR on every param change would be expensive,
 * so we throttle: the IR is regenerated when `time`, `size`, or
 * `decay` change (with a short debounce); `damping`, `width`, `mix`,
 * and bypass updates are cheap parameter pokes.
 */

interface TrackReverbEntry {
  laneKey: string;
  // Audio nodes
  splitter: GainNode;       // input (fed by chain walker)
  dry: GainNode;
  predelay: DelayNode;
  convolver: ConvolverNode;
  damp: BiquadFilterNode;   // single highshelf for high-freq damping
  widthMid: GainNode;
  widthSide: GainNode;
  // M/S encode/decode plumbing
  splitterMS: ChannelSplitterNode;
  mergerMS: ChannelMergerNode;
  msMidIn: GainNode;
  msSideIn: GainNode;
  msInvR: GainNode;         // -1 gain on R for side calc
  msInvSide: GainNode;
  wet: GainNode;
  output: GainNode;
  // Parallel tap on the post-mix signal — drives the panel's
  // visualizer pulse so the iso cubes brighten on each audio peak.
  outputAnalyser: AnalyserNode;
  bypassed: boolean;
  // Cached params so we know when to rebuild the IR.
  lastTime: number;
  lastSize: number;
  lastDecay: number;
  rebuildHandle: number;
}

const registry = new Map<string /* trackId */, TrackReverbEntry>();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rampParam(p: AudioParam, value: number, ctx?: AudioContext): void {
  try {
    const t = ctx?.currentTime ?? 0;
    p.cancelScheduledValues(t);
    p.linearRampToValueAtTime(value, t + 0.04);
  } catch {
    p.value = value;
  }
}

/**
 * Build a synthetic stereo impulse response — exponentially-decaying
 * noise. Size and decay shape the envelope: bigger size = longer
 * pre-decay attack; bigger decay multiplier = slower fall.
 */
function buildIR(ctx: AudioContext, timeSec: number, size: number, decay: number): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(timeSec * sampleRate));
  const ir = ctx.createBuffer(2, length, sampleRate);
  // Higher size widens the early-reflection cluster.
  const earlyLen = Math.floor(length * (0.04 + 0.10 * size));
  const decayPow = 2 + decay * 2; // 2..4 — controls envelope steepness
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Early reflections: brighter and more dense for the first
      // `earlyLen` samples.
      const early = i < earlyLen ? Math.exp(-i / earlyLen * 2) : 0;
      // Late tail: smooth exponential decay.
      const env = Math.pow(1 - t, decayPow);
      data[i] = (Math.random() * 2 - 1) * (env + early * 0.6);
    }
  }
  return ir;
}

/**
 * Build the per-clip reverb chain. Returns the `splitter` (input)
 * and `output` so the audio-store splice site can wire the chain
 * into series.
 */
export function buildTrackReverbChain(
  ctx: AudioContext,
  trackId: string,
  laneKey: string,
  params: ReverbParams,
  bypassed: boolean,
): { input: AudioNode; output: AudioNode } {
  removeTrackReverb(trackId);

  const splitter = ctx.createGain();
  const dry = ctx.createGain();
  const predelay = ctx.createDelay(0.5);
  predelay.delayTime.value = 0.02; // 20 ms — fixed for now
  const convolver = ctx.createConvolver();
  convolver.normalize = true;

  // Damping: highshelf cut at ~5 kHz. Damping = 0 → 0 dB cut, 1 → -24 dB.
  const damp = ctx.createBiquadFilter();
  damp.type = 'highshelf';
  damp.frequency.value = 5000;
  damp.gain.value = -clamp(params.damping, 0, 1) * 24;

  // M/S width — split L/R into M (sum) and S (diff), scale S by width,
  // recombine. Width 0.5 = stereo passthrough; 0 = mono; 1 = enhanced.
  const splitterMS = ctx.createChannelSplitter(2);
  const msMidIn = ctx.createGain();   msMidIn.gain.value = 0.5;
  const msSideIn = ctx.createGain();  msSideIn.gain.value = 0.5;
  const msInvR = ctx.createGain();    msInvR.gain.value = -1;
  const widthMid = ctx.createGain();  widthMid.gain.value = 1;
  const widthSide = ctx.createGain(); widthSide.gain.value = clamp(params.width, 0, 1) * 2;
  const msInvSide = ctx.createGain(); msInvSide.gain.value = -1;
  const mergerMS = ctx.createChannelMerger(2);

  const wet = ctx.createGain();
  const output = ctx.createGain();
  const outputAnalyser = ctx.createAnalyser();
  outputAnalyser.fftSize = 1024;
  outputAnalyser.smoothingTimeConstant = 0.6;
  // Parallel tap — analyser does NOT sit in the audio path.
  output.connect(outputAnalyser);

  // Dry mix. params.mix is the WET amount (0..1) so dry = 1 - mix.
  const mix = clamp(params.mix, 0, 1);
  dry.gain.value = 1 - mix;
  wet.gain.value = bypassed ? 0 : mix;

  // Wire dry path
  splitter.connect(dry);
  dry.connect(output);

  // Wire wet path
  splitter.connect(predelay);
  predelay.connect(convolver);
  convolver.connect(damp);

  // M/S width on convolver output
  damp.connect(splitterMS);
  // L → mid (+0.5) and side (+0.5)
  splitterMS.connect(msMidIn, 0);
  splitterMS.connect(msSideIn, 0);
  // R → mid (+0.5) and side (-0.5)
  splitterMS.connect(msMidIn, 1);
  splitterMS.connect(msInvR, 1);
  msInvR.connect(msSideIn);

  // M = msMidIn, S = msSideIn — both single-channel
  msMidIn.connect(widthMid);
  msSideIn.connect(widthSide);

  // Decode M+S back to L/R: L = M + S, R = M - S
  widthMid.connect(mergerMS, 0, 0);
  widthSide.connect(mergerMS, 0, 0);
  widthMid.connect(mergerMS, 0, 1);
  widthSide.connect(msInvSide);
  msInvSide.connect(mergerMS, 0, 1);

  mergerMS.connect(wet);
  wet.connect(output);

  // Generate the initial IR.
  try {
    convolver.buffer = buildIR(ctx, clamp(params.time, 0.1, 10), clamp(params.size, 0, 1), clamp(params.decay, 0, 1));
  } catch { /* ignore — IR can fail on locked ctx */ }

  const entry: TrackReverbEntry = {
    laneKey,
    splitter, dry, predelay, convolver, damp,
    widthMid, widthSide,
    splitterMS, mergerMS, msMidIn, msSideIn, msInvR, msInvSide,
    wet, output, outputAnalyser,
    bypassed,
    lastTime: params.time,
    lastSize: params.size,
    lastDecay: params.decay,
    rebuildHandle: 0,
  };
  registry.set(trackId, entry);
  return { input: splitter, output };
}

function scheduleIRRebuild(entry: TrackReverbEntry, ctx?: AudioContext) {
  if (entry.rebuildHandle) {
    clearTimeout(entry.rebuildHandle);
    entry.rebuildHandle = 0;
  }
  // Debounce so a slider drag doesn't rebuild the IR on every frame.
  // 90 ms feels responsive without burning the CPU.
  entry.rebuildHandle = window.setTimeout(() => {
    try {
      const audio = ctx ?? entry.convolver.context as AudioContext;
      entry.convolver.buffer = buildIR(audio, clamp(entry.lastTime, 0.1, 10), clamp(entry.lastSize, 0, 1), clamp(entry.lastDecay, 0, 1));
    } catch { /* ignore */ }
    entry.rebuildHandle = 0;
  }, 90);
}

export function setLaneReverbParam(
  laneKey: string,
  field: keyof ReverbParams,
  value: number,
  ctx?: AudioContext,
): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    if (field === 'mix') {
      const v = clamp(value, 0, 1);
      rampParam(entry.dry.gain, 1 - v, ctx);
      rampParam(entry.wet.gain, entry.bypassed ? 0 : v, ctx);
      return;
    }
    if (field === 'damping') {
      rampParam(entry.damp.gain, -clamp(value, 0, 1) * 24, ctx);
      return;
    }
    if (field === 'width') {
      rampParam(entry.widthSide.gain, clamp(value, 0, 1) * 2, ctx);
      return;
    }
    if (field === 'time') {
      entry.lastTime = clamp(value, 0.1, 10);
      scheduleIRRebuild(entry, ctx);
      return;
    }
    if (field === 'size') {
      entry.lastSize = clamp(value, 0, 1);
      scheduleIRRebuild(entry, ctx);
      return;
    }
    if (field === 'decay') {
      entry.lastDecay = clamp(value, 0, 1);
      scheduleIRRebuild(entry, ctx);
      return;
    }
  });
}

export function setLaneReverbBypass(laneKey: string, bypassed: boolean, ctx?: AudioContext): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    entry.bypassed = bypassed;
    // Wet path mute on bypass; dry stays at its current mix value.
    // Pulling the stored mix out of dry.gain isn't reliable across
    // ramps, so we approximate by keeping the dry path untouched and
    // toggling wet only.
    rampParam(entry.wet.gain, bypassed ? 0 : Math.max(0, 1 - entry.dry.gain.value), ctx);
  });
}

/** Output analyser — drives the panel's visualizer pulse. */
export function getLaneReverbAnalyser(laneKey: string): AnalyserNode | null {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.outputAnalyser;
  }
  return null;
}

export function removeTrackReverb(trackId: string): void {
  const entry = registry.get(trackId);
  if (!entry) return;
  if (entry.rebuildHandle) clearTimeout(entry.rebuildHandle);
  for (const node of [
    entry.splitter, entry.dry, entry.predelay, entry.convolver, entry.damp,
    entry.widthMid, entry.widthSide, entry.splitterMS, entry.mergerMS,
    entry.msMidIn, entry.msSideIn, entry.msInvR, entry.msInvSide,
    entry.wet, entry.output, entry.outputAnalyser,
  ]) {
    try { node.disconnect(); } catch { /* ignore */ }
  }
  registry.delete(trackId);
}

export function disposeAllTrackReverb(): void {
  registry.forEach((_, trackId) => removeTrackReverb(trackId));
  registry.clear();
}
