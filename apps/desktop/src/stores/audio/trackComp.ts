import type { CompParams } from '../effectsStore';

/**
 * Per-clip compressor DSP. Mirrors trackEq.ts's pattern: a registry
 * keyed by clip trackId, each entry carrying the live audio nodes +
 * analyser taps + bypass state. The visualizer in CompressorPanel
 * reads from this registry; the audio store splices the chain in
 * series after the pan stage (or after the EQ chain when both are
 * present).
 *
 * Implementation note: this used to wrap the custom track-compressor
 * AudioWorklet, but worklet loading is async (`ctx.audioWorklet.addModule`)
 * and that race meant the comp was sometimes silently skipped on the
 * first build pass — meters dead, visualizer dead. The native
 * DynamicsCompressorNode is always available, has a `reduction` field
 * we can poll directly for the GR meter, and bypass is implemented by
 * setting ratio to 1. We pair it with a downstream GainNode for
 * makeup gain (DynamicsCompressorNode has no makeup).
 *
 * Signal flow per clip:
 *   inputAnalyser → compressor → makeupGain → outputAnalyser
 *      (also a parallel tap from inputAnalyser, no further connection)
 */

interface TrackCompEntry {
  laneKey: string;
  compressor: DynamicsCompressorNode;
  makeup: GainNode;
  analyser: AnalyserNode;
  outputAnalyser: AnalyserNode;
  bypassed: boolean;
  storedRatio: number;
  storedMakeupDb: number;
}

const registry = new Map<string /* trackId */, TrackCompEntry>();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rampParam(p: AudioParam, value: number, ctx?: AudioContext): void {
  try {
    const t = ctx?.currentTime ?? 0;
    p.cancelScheduledValues(t);
    p.linearRampToValueAtTime(value, t + 0.03);
  } catch {
    p.value = value;
  }
}

function dbToLinear(dB: number): number {
  return Math.pow(10, dB / 20);
}

/**
 * Build a fresh compressor chain for a clip. Disposes any prior
 * registry entry under the same trackId.
 */
export function buildTrackCompChain(
  ctx: AudioContext,
  trackId: string,
  laneKey: string,
  params: CompParams,
  bypassed: boolean,
): { input: AudioNode; output: AudioNode } {
  removeTrackComp(trackId);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.4;

  const outputAnalyser = ctx.createAnalyser();
  outputAnalyser.fftSize = 1024;
  outputAnalyser.smoothingTimeConstant = 0.4;

  const compressor = ctx.createDynamicsCompressor();
  // DynamicsCompressorNode allows ratio 1..20, threshold -100..0,
  // attack 0..1 s, release 0..1 s, knee 0..40 dB. We use a hard knee
  // so the curve in the UI matches the audio behavior.
  compressor.threshold.value = clamp(params.threshold, -60, 0);
  compressor.ratio.value = bypassed ? 1 : clamp(params.ratio, 1, 20);
  compressor.attack.value = clamp(params.attack, 1, 200) / 1000;
  compressor.release.value = clamp(params.release, 10, 1000) / 1000;
  compressor.knee.value = 0;

  const makeupDb = clamp(params.makeup, -20, 20);
  const makeup = ctx.createGain();
  makeup.gain.value = dbToLinear(makeupDb);

  // Wire: analyser(in) → compressor → makeup → outputAnalyser
  analyser.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(outputAnalyser);

  const entry: TrackCompEntry = {
    laneKey,
    compressor,
    makeup,
    analyser,
    outputAnalyser,
    bypassed,
    storedRatio: clamp(params.ratio, 1, 20),
    storedMakeupDb: makeupDb,
  };
  registry.set(trackId, entry);
  return { input: analyser, output: outputAnalyser };
}

/**
 * Push a single param change to every clip's compressor in a lane.
 * Smooth-ramped so UI sliders feel instant without zipper.
 */
export function setLaneCompParam(
  laneKey: string,
  field: keyof CompParams,
  value: number,
  ctx?: AudioContext,
): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    if (field === 'ratio') {
      const r = clamp(value, 1, 20);
      entry.storedRatio = r;
      rampParam(entry.compressor.ratio, entry.bypassed ? 1 : r, ctx);
      return;
    }
    if (field === 'attack') {
      rampParam(entry.compressor.attack, clamp(value, 1, 200) / 1000, ctx);
      return;
    }
    if (field === 'release') {
      rampParam(entry.compressor.release, clamp(value, 10, 1000) / 1000, ctx);
      return;
    }
    if (field === 'threshold') {
      rampParam(entry.compressor.threshold, clamp(value, -60, 0), ctx);
      return;
    }
    if (field === 'makeup') {
      const dB = clamp(value, -20, 20);
      entry.storedMakeupDb = dB;
      rampParam(entry.makeup.gain, dbToLinear(dB), ctx);
      return;
    }
  });
}

/**
 * Toggle bypass for every clip's comp in a lane. Bypass = ratio 1
 * (the compressor passes through with knee/attack/release applied
 * but no actual gain reduction). Makeup gain still applies — same
 * behavior as the master FX bus comp.
 */
export function setLaneCompBypass(laneKey: string, bypassed: boolean, ctx?: AudioContext): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    entry.bypassed = bypassed;
    rampParam(entry.compressor.ratio, bypassed ? 1 : entry.storedRatio, ctx);
  });
}

/** Look up the input analyser for the lane's comp. Drives the
 * CompressorPanel input level meter. */
export function getLaneCompAnalyser(laneKey: string): AnalyserNode | null {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.analyser;
  }
  return null;
}

/** Output analyser — drives the OUT meter and the post-comp portion
 * of the scrolling waveform behind the transfer curve. */
export function getLaneCompOutputAnalyser(laneKey: string): AnalyserNode | null {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.outputAnalyser;
  }
  return null;
}

/** Latest gain-reduction (dB, ≤ 0) directly from the
 * DynamicsCompressorNode.reduction field. Drives the GR meter. */
export function getLaneCompEnvelope(laneKey: string): number {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.compressor.reduction;
  }
  return 0;
}

export function removeTrackComp(trackId: string): void {
  const entry = registry.get(trackId);
  if (!entry) return;
  try { entry.analyser.disconnect(); } catch { /* ignore */ }
  try { entry.compressor.disconnect(); } catch { /* ignore */ }
  try { entry.makeup.disconnect(); } catch { /* ignore */ }
  try { entry.outputAnalyser.disconnect(); } catch { /* ignore */ }
  registry.delete(trackId);
}

export function disposeAllTrackComp(): void {
  registry.forEach((entry) => {
    try { entry.analyser.disconnect(); } catch { /* ignore */ }
    try { entry.compressor.disconnect(); } catch { /* ignore */ }
    try { entry.makeup.disconnect(); } catch { /* ignore */ }
    try { entry.outputAnalyser.disconnect(); } catch { /* ignore */ }
  });
  registry.clear();
}
