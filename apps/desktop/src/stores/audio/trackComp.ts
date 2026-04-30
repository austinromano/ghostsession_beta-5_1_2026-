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
  // Per-clip input/output passthroughs. They tap the shared lane
  // analysers in parallel and feed the per-clip dynamics chain. Held
  // here for tear-down on playback restart.
  input: GainNode;
  output: GainNode;
  bypassed: boolean;
  storedRatio: number;
  storedMakeupDb: number;
}

const registry = new Map<string /* trackId */, TrackCompEntry>();

// Lane-scoped, persistent analyser pair. Every clip on the same lane
// summates into these so the panel's IN / OUT meters + the scrolling
// waveform read whichever clip is currently producing audio — not
// just the selected one. Lives across playback restarts.
const laneInputAnalysers = new Map<string /* laneKey */, AnalyserNode>();
const laneOutputAnalysers = new Map<string /* laneKey */, AnalyserNode>();
// Latest reduction (dB, ≤ 0) per lane, mirrored from whichever clip's
// compressor on the lane is most active. Polled by the GR meter.
const laneReductions = new Map<string /* laneKey */, () => number>();

function makeLaneAnalyser(ctx: AudioContext): AnalyserNode {
  const a = ctx.createAnalyser();
  a.fftSize = 1024;
  a.smoothingTimeConstant = 0.4;
  return a;
}

function getOrCreateLaneInputAnalyser(ctx: AudioContext, laneKey: string): AnalyserNode {
  let a = laneInputAnalysers.get(laneKey);
  if (!a) { a = makeLaneAnalyser(ctx); laneInputAnalysers.set(laneKey, a); }
  return a;
}

function getOrCreateLaneOutputAnalyser(ctx: AudioContext, laneKey: string): AnalyserNode {
  let a = laneOutputAnalysers.get(laneKey);
  if (!a) { a = makeLaneAnalyser(ctx); laneOutputAnalysers.set(laneKey, a); }
  return a;
}

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

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = clamp(params.threshold, -60, 0);
  compressor.ratio.value = bypassed ? 1 : clamp(params.ratio, 1, 20);
  compressor.attack.value = clamp(params.attack, 1, 200) / 1000;
  compressor.release.value = clamp(params.release, 10, 1000) / 1000;
  compressor.knee.value = 0;

  const makeupDb = clamp(params.makeup, -20, 20);
  const makeup = ctx.createGain();
  makeup.gain.value = dbToLinear(makeupDb);

  // Per-clip passthrough gains. The shared lane analysers are tapped
  // off these in parallel so any clip on the lane drives the visualizer.
  const input = ctx.createGain();
  const output = ctx.createGain();

  const laneIn = getOrCreateLaneInputAnalyser(ctx, laneKey);
  const laneOut = getOrCreateLaneOutputAnalyser(ctx, laneKey);

  // Wire (audio path):  input → compressor → makeup → output
  // Wire (taps):        input → laneIn (parallel),  output → laneOut (parallel)
  input.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(output);
  input.connect(laneIn);
  output.connect(laneOut);

  // Mirror this clip's reduction into the lane's getter. Last-built
  // wins, but clips on the lane share the same effective threshold so
  // any of them is representative.
  laneReductions.set(laneKey, () => compressor.reduction);

  const entry: TrackCompEntry = {
    laneKey,
    compressor,
    makeup,
    input,
    output,
    bypassed,
    storedRatio: clamp(params.ratio, 1, 20),
    storedMakeupDb: makeupDb,
  };
  registry.set(trackId, entry);
  return { input, output };
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

/** Lane-shared input analyser — drives the IN meter + the input side
 * of the scrolling waveform. Persistent so the panel reads from the
 * same node across plays + sees whichever clip on the lane is playing. */
export function getLaneCompAnalyser(laneKey: string): AnalyserNode | null {
  return laneInputAnalysers.get(laneKey) ?? null;
}

/** Lane-shared output analyser — drives the OUT meter and the post-comp
 * portion of the scrolling waveform behind the transfer curve. */
export function getLaneCompOutputAnalyser(laneKey: string): AnalyserNode | null {
  return laneOutputAnalysers.get(laneKey) ?? null;
}

/** Latest gain-reduction (dB, ≤ 0) for the lane. Reads through a
 * lane-keyed getter so the value reflects the most recently-built
 * clip's compressor on that lane. */
export function getLaneCompEnvelope(laneKey: string): number {
  const fn = laneReductions.get(laneKey);
  return fn ? fn() : 0;
}

/** Tear down a single clip's compressor chain. Lane analysers are
 * INTENTIONALLY left alive so the visualizer keeps reading the same
 * persistent node across playback restarts. */
export function removeTrackComp(trackId: string): void {
  const entry = registry.get(trackId);
  if (!entry) return;
  try { entry.input.disconnect(); } catch { /* ignore */ }
  try { entry.compressor.disconnect(); } catch { /* ignore */ }
  try { entry.makeup.disconnect(); } catch { /* ignore */ }
  try { entry.output.disconnect(); } catch { /* ignore */ }
  registry.delete(trackId);
}

export function disposeAllTrackComp(): void {
  registry.forEach((entry) => {
    try { entry.input.disconnect(); } catch { /* ignore */ }
    try { entry.compressor.disconnect(); } catch { /* ignore */ }
    try { entry.makeup.disconnect(); } catch { /* ignore */ }
    try { entry.output.disconnect(); } catch { /* ignore */ }
  });
  registry.clear();
  laneInputAnalysers.forEach((a) => { try { a.disconnect(); } catch { /* ignore */ } });
  laneInputAnalysers.clear();
  laneOutputAnalysers.forEach((a) => { try { a.disconnect(); } catch { /* ignore */ } });
  laneOutputAnalysers.clear();
  laneReductions.clear();
}
