import type { EqBand } from '../effectsStore';

/**
 * Per-clip 4-band peaking BiquadFilter chain. Inserted between the
 * track's pan stage and the master mixer in startAllSources, so audio
 * flows: source → gain → pan → eq[0] → eq[1] → eq[2] → eq[3] → master.
 *
 * Multiple clips can share the same lane (same fileId) — every clip
 * gets its own filter chain instance, but they're all kept in sync via
 * `setLaneEqBand` which updates every entry whose laneKey matches.
 *
 * Bypass works by routing around stored gain values: when bypassed, all
 * 4 filters' gain is set to 0 dB (a peaking biquad at 0 dB gain is
 * effectively transparent regardless of frequency / Q). The stored
 * gains are restored when the user un-bypasses.
 *
 * The DSP layer never owns "chain shape" — it only mirrors what
 * effectsStore says is true. effectsStore is the source of truth.
 */

interface TrackEqEntry {
  laneKey: string;
  filters: BiquadFilterNode[];   // exactly 4
  storedGains: number[];         // exactly 4 — last unbypassed gain per band
  bypassed: boolean;
  // Per-clip input passthrough — taps the shared lane analyser in
  // parallel and feeds the filter chain. Kept here for tear-down.
  input: GainNode;
}

const registry = new Map<string /* trackId */, TrackEqEntry>();

// Persistent per-lane analyser. Every clip on the same lane funnels
// its pre-EQ signal into this one node, so the visualizer sees the
// LANE's audio — not just the currently-selected clip's. Lives across
// playback restarts and clip changes; only disposed on full cleanup.
const laneAnalysers = new Map<string /* laneKey */, AnalyserNode>();

function getOrCreateLaneAnalyser(ctx: AudioContext, laneKey: string): AnalyserNode {
  let a = laneAnalysers.get(laneKey);
  if (!a) {
    a = ctx.createAnalyser();
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.75;
    a.minDecibels = -90;
    a.maxDecibels = -10;
    laneAnalysers.set(laneKey, a);
  }
  return a;
}

const FILTER_Q = 1.0;            // peaking width — matches the visual sigma roughly
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_GAIN = -24;
const MAX_GAIN = 24;

function clampFreq(v: number): number { return Math.max(MIN_FREQ, Math.min(MAX_FREQ, v)); }
function clampGain(v: number): number { return Math.max(MIN_GAIN, Math.min(MAX_GAIN, v)); }

/**
 * Build a fresh 4-band chain for a track. Disposes any prior chain
 * that was registered under this trackId (keeps the registry clean
 * across playback restarts).
 *
 * Returns the input + output nodes so the caller can splice the chain
 * into the audio graph.
 */
export function buildTrackEqChain(
  ctx: AudioContext,
  trackId: string,
  laneKey: string,
  bands: EqBand[],
  bypassed: boolean,
): { input: AudioNode; output: AudioNode } {
  removeTrackEq(trackId);

  const filters: BiquadFilterNode[] = [];
  const storedGains: number[] = [];
  // Pad / truncate to exactly 4 bands so the chain shape is stable
  // even if a malformed params blob slips through.
  for (let i = 0; i < 4; i++) {
    const band = bands[i] ?? { freq: 1000, gain: 0 };
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = clampFreq(band.freq);
    f.Q.value = FILTER_Q;
    f.gain.value = bypassed ? 0 : clampGain(band.gain);
    filters.push(f);
    storedGains.push(clampGain(band.gain));
  }
  for (let i = 0; i < filters.length - 1; i++) {
    filters[i].connect(filters[i + 1]);
  }

  // Lane-scoped visualizer tap. Each clip's chain forks its input into
  // (a) a shared lane analyser — parallel branch, audio doesn't go
  // anywhere from there; AnalyserNode is transparent so the fork itself
  // doesn't colour the signal — and (b) the filter chain. All clips on
  // the lane share one analyser, so the panel sees lane audio whichever
  // clip is currently producing it.
  const laneAnalyser = getOrCreateLaneAnalyser(ctx, laneKey);
  const input = ctx.createGain();
  input.gain.value = 1;
  input.connect(laneAnalyser);
  input.connect(filters[0]);

  registry.set(trackId, { laneKey, filters, storedGains, bypassed, input });

  return { input, output: filters[filters.length - 1] };
}

/**
 * Lane-scoped analyser shared by every clip on the lane. Persists
 * across playback restarts so the visualizer keeps reading the same
 * node — and sees audio from whichever clip on the lane is playing.
 * Returns null only if no clip on this lane has ever been built.
 */
export function getLaneAnalyser(laneKey: string): AnalyserNode | null {
  return laneAnalysers.get(laneKey) ?? null;
}

/**
 * Update one band on every clip that belongs to a lane. Smooth-ramps
 * over 30 ms so a slider drag doesn't zipper.
 */
export function setLaneEqBand(
  laneKey: string,
  bandIndex: number,
  freq: number,
  gain: number,
  ctx?: AudioContext,
): void {
  if (bandIndex < 0 || bandIndex > 3) return;
  const f = clampFreq(freq);
  const g = clampGain(gain);
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    entry.storedGains[bandIndex] = g;
    const node = entry.filters[bandIndex];
    if (!node) return;
    try {
      const t = ctx?.currentTime ?? 0;
      node.frequency.cancelScheduledValues(t);
      node.frequency.linearRampToValueAtTime(f, t + 0.03);
      const targetGain = entry.bypassed ? 0 : g;
      node.gain.cancelScheduledValues(t);
      node.gain.linearRampToValueAtTime(targetGain, t + 0.03);
    } catch {
      // Older Safari fallback — direct value assignment.
      node.frequency.value = f;
      node.gain.value = entry.bypassed ? 0 : g;
    }
  });
}

/**
 * Toggle bypass for every clip in a lane. Flattens band gains to 0 dB
 * (peaking biquad at 0 dB is transparent) without touching the stored
 * values, so un-bypass restores the previous shape exactly.
 */
export function setLaneEqBypass(laneKey: string, bypassed: boolean, ctx?: AudioContext): void {
  registry.forEach((entry) => {
    if (entry.laneKey !== laneKey) return;
    entry.bypassed = bypassed;
    for (let i = 0; i < entry.filters.length; i++) {
      const node = entry.filters[i];
      const target = bypassed ? 0 : entry.storedGains[i];
      try {
        const t = ctx?.currentTime ?? 0;
        node.gain.cancelScheduledValues(t);
        node.gain.linearRampToValueAtTime(target, t + 0.03);
      } catch {
        node.gain.value = target;
      }
    }
  });
}

/** Disconnect + drop a single track's chain. Called on playback restart.
 * The lane analyser is INTENTIONALLY left alive — it's shared across
 * clips and we want it persistent so the visualizer reads the same
 * node every frame. */
export function removeTrackEq(trackId: string): void {
  const entry = registry.get(trackId);
  if (!entry) return;
  try { entry.input.disconnect(); } catch { /* ignore */ }
  for (const f of entry.filters) {
    try { f.disconnect(); } catch { /* ignore */ }
  }
  registry.delete(trackId);
}

/** Wipe the entire registry + lane analysers. Called on cleanup() so
 * a project switch doesn't carry orphan filters into the next session. */
export function disposeAllTrackEq(): void {
  registry.forEach((entry) => {
    try { entry.input.disconnect(); } catch { /* ignore */ }
    for (const f of entry.filters) {
      try { f.disconnect(); } catch { /* ignore */ }
    }
  });
  registry.clear();
  laneAnalysers.forEach((a) => { try { a.disconnect(); } catch { /* ignore */ } });
  laneAnalysers.clear();
}
