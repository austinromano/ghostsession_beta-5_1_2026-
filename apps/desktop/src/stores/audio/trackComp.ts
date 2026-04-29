import type { CompParams } from '../effectsStore';

/**
 * Per-clip compressor DSP. Mirrors trackEq.ts's pattern: a registry
 * keyed by clip trackId, each entry carrying the live AudioWorkletNode
 * + analyser + bypass state. The visualizer in CompressorPanel reads
 * the analyser; the audio store splices the chain in series after the
 * pan stage (or after the EQ chain when both are present).
 *
 * Reuses the existing `track-compressor` worklet — same processor that
 * powers the master FX bus comp. The worklet is bit-perfect transparent
 * at ratio == 1, which is exactly what bypass needs: stash the user's
 * ratio, set live ratio to 1, restore on un-bypass.
 */

interface TrackCompEntry {
  laneKey: string;
  node: AudioWorkletNode;
  analyser: AnalyserNode;       // tapped at INPUT — what's going INTO the comp
  outputAnalyser: AnalyserNode; // tapped at OUTPUT — what comes OUT
  bypassed: boolean;
  storedRatio: number;          // last unbypassed ratio for restore
  // Latest gain-reduction envelope value posted by the worklet
  // (dB, always ≤ 0). The CompressorPanel's GR meter polls this.
  envelopeDb: number;
}

const registry = new Map<string /* trackId */, TrackCompEntry>();

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function setParam(node: AudioWorkletNode, name: string, value: number, ctx?: AudioContext): void {
  const param = (node.parameters as unknown as Map<string, AudioParam>).get(name);
  if (!param) return;
  try {
    const t = ctx?.currentTime ?? 0;
    param.cancelScheduledValues(t);
    param.linearRampToValueAtTime(value, t + 0.03);
  } catch {
    param.value = value;
  }
}

/**
 * Build a fresh compressor chain for a clip. Disposes any prior
 * registry entry under the same trackId.
 *
 * Returns input + output AudioNodes so the audio-store splice site
 * can wire it in series after the pan / EQ stage.
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

  const node = new AudioWorkletNode(ctx, 'track-compressor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  // Apply params before the first audio block. Worklet expects attack
  // / release in SECONDS — convert from our ms-based store.
  const ratioClamped = clamp(params.ratio, 1, 20);
  const liveRatio = bypassed ? 1 : ratioClamped;
  setParam(node, 'threshold', clamp(params.threshold, -60, 0));
  setParam(node, 'ratio', liveRatio);
  setParam(node, 'attack', clamp(params.attack, 1, 200) / 1000);
  setParam(node, 'release', clamp(params.release, 10, 1000) / 1000);
  setParam(node, 'makeup', clamp(params.makeup, -20, 20));

  // Wire: analyser(in) → worklet → outputAnalyser
  analyser.connect(node);
  node.connect(outputAnalyser);

  const entry: TrackCompEntry = { laneKey, node, analyser, outputAnalyser, bypassed, storedRatio: ratioClamped, envelopeDb: 0 };
  // Listen for periodic gain-reduction posts from the worklet.
  // ~75 Hz updates feed the GR meter. Only this entry's GR is updated
  // — every clip in the lane has its own worklet, but for visualizer
  // purposes we just read from the first one (getLaneCompEnvelope).
  node.port.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; envelopeDb?: number } | undefined;
    if (data && data.type === 'gr' && typeof data.envelopeDb === 'number') {
      entry.envelopeDb = data.envelopeDb;
    }
  };

  registry.set(trackId, entry);
  return { input: analyser, output: outputAnalyser };
}

/**
 * Push a single param change to every clip's compressor in a lane.
 * Smooth-ramps via setParam; UI sliders feel instant without zipper.
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
      // Always update the stored ratio. Live param respects bypass.
      const r = clamp(value, 1, 20);
      entry.storedRatio = r;
      setParam(entry.node, 'ratio', entry.bypassed ? 1 : r, ctx);
      return;
    }
    if (field === 'attack') {
      setParam(entry.node, 'attack', clamp(value, 1, 200) / 1000, ctx);
      return;
    }
    if (field === 'release') {
      setParam(entry.node, 'release', clamp(value, 10, 1000) / 1000, ctx);
      return;
    }
    if (field === 'threshold') {
      setParam(entry.node, 'threshold', clamp(value, -60, 0), ctx);
      return;
    }
    if (field === 'makeup') {
      setParam(entry.node, 'makeup', clamp(value, -20, 20), ctx);
      return;
    }
  });
}

/**
 * Toggle bypass for every clip's comp in a lane. Worklet is bit-perfect
 * transparent at ratio == 1, so bypass = force ratio to 1 (storing the
 * user's actual ratio for restore) and pass-through makeup gain.
 */
export function setLaneCompBypass(laneKey: string, bypassed: boolean, ctx?: AudioContext): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    entry.bypassed = bypassed;
    setParam(entry.node, 'ratio', bypassed ? 1 : entry.storedRatio, ctx);
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

/** Output analyser — drives the OUT meter showing post-comp signal. */
export function getLaneCompOutputAnalyser(laneKey: string): AnalyserNode | null {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.outputAnalyser;
  }
  return null;
}

/** Latest gain-reduction envelope (dB, ≤ 0) posted by the worklet.
 * Drives the GR meter — invert so larger reduction reads as a taller
 * meter. Returns 0 when no chain is registered. */
export function getLaneCompEnvelope(laneKey: string): number {
  for (const entry of registry.values()) {
    if (entry.laneKey === laneKey) return entry.envelopeDb;
  }
  return 0;
}

export function removeTrackComp(trackId: string): void {
  const entry = registry.get(trackId);
  if (!entry) return;
  try { entry.node.port.onmessage = null; } catch { /* ignore */ }
  try { entry.analyser.disconnect(); } catch { /* ignore */ }
  try { entry.node.disconnect(); } catch { /* ignore */ }
  try { entry.outputAnalyser.disconnect(); } catch { /* ignore */ }
  registry.delete(trackId);
}

export function disposeAllTrackComp(): void {
  registry.forEach((entry) => {
    try { entry.node.port.onmessage = null; } catch { /* ignore */ }
    try { entry.analyser.disconnect(); } catch { /* ignore */ }
    try { entry.node.disconnect(); } catch { /* ignore */ }
    try { entry.outputAnalyser.disconnect(); } catch { /* ignore */ }
  });
  registry.clear();
}
