// AudioWorklet — per-track feed-forward compressor.
//
// Sits between the track's EQ and gain stages:
//   source → eqLow → eqMid → eqHigh → compressor → trackGain → pan → bus
//
// Why a custom worklet instead of DynamicsCompressorNode:
// - Built-in compressor has audible character (its own peak detector
//   + look-ahead behaviour); below threshold it's not 100% transparent.
// - Built-in caps ratio around 20:1 and locks attack/release ranges
//   to ranges that don't suit channel-strip work.
// - This one is hard-knee + simple peak detector: at ratio = 1 it's
//   bit-perfect transparent, so leaving it inserted on every track
//   is free when not engaged.
//
// Algorithm (classic feed-forward, hard knee):
//   1. Peak-detect input across channels (sample-by-sample max(|x|)).
//   2. Convert to dBFS.
//   3. If above threshold + ratio > 1, compute static gain reduction:
//        gain_reduction_dB = -(input_dB - threshold) * (1 - 1/ratio)
//   4. Smooth toward that target with attack (when reduction is
//      increasing — i.e. envelope is going further negative) and
//      release (when recovering toward 0).
//   5. Apply: out = in * 10^(envelope_dB / 20) * makeup_linear
//
// AudioParams (k-rate, sampled once per block):
//   threshold (dB) — default 0   (≤ 0; above this the comp engages)
//   ratio          — default 1   (1 = no compression)
//   attack  (sec)  — default 0.003 (3 ms)
//   release (sec)  — default 0.1   (100 ms)
//   makeup (dB)    — default 0     (post-compression linear gain)

/* global registerProcessor, AudioWorkletProcessor, sampleRate */

class TrackCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0,     minValue: -60,    maxValue: 0,  automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 1,     minValue: 1,      maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.003, minValue: 0.0001, maxValue: 1,  automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.1,   minValue: 0.001,  maxValue: 1,  automationRate: 'k-rate' },
      { name: 'makeup',    defaultValue: 0,     minValue: -20,    maxValue: 20, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Current gain reduction envelope (dB, always ≤ 0). Starts at 0
    // so the first sample passes through clean.
    this.envelope = 0;
    // Block counter for throttled postMessage of the envelope back to
    // the main thread (drives the per-track GR meter). Posting every
    // block (128 samples = ~2.7 ms) is overkill; once every 5 blocks
    // (~13 ms / ~75 Hz) is plenty for a smooth meter.
    this._publishEvery = 5;
    this._blocksSincePublish = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
      return true;
    }
    const blockSize = output[0].length;
    const channels = Math.min(input.length, output.length);

    const threshold = parameters.threshold[0];
    const ratio = parameters.ratio[0];
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const makeup = parameters.makeup[0];

    // Bypass entirely when ratio is 1 — saves the per-sample log/pow
    // cost on every track that hasn't engaged compression. Bit-perfect
    // pass-through plus makeup gain.
    if (ratio <= 1.0001) {
      const makeupLinear = Math.pow(10, makeup / 20);
      for (let ch = 0; ch < channels; ch++) {
        const inCh = input[ch];
        const outCh = output[ch];
        for (let i = 0; i < blockSize; i++) outCh[i] = inCh[i] * makeupLinear;
      }
      // Decay envelope toward 0 so when ratio bumps above 1 again the
      // first block doesn't start with a stale gain-reduction value.
      this.envelope *= 0.99;
      this._blocksSincePublish++;
      if (this._blocksSincePublish >= this._publishEvery) {
        this._blocksSincePublish = 0;
        this.port.postMessage({ type: 'gr', envelopeDb: this.envelope });
      }
      return true;
    }

    const attackCoeff = Math.exp(-1 / (Math.max(0.0001, attack) * sampleRate));
    const releaseCoeff = Math.exp(-1 / (Math.max(0.001, release) * sampleRate));
    const makeupLinear = Math.pow(10, makeup / 20);
    const oneMinusInvRatio = 1 - 1 / ratio;

    for (let i = 0; i < blockSize; i++) {
      // Peak detect across channels.
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) {
        const v = input[ch][i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }

      // Static gain reduction (hard knee). Skip the dB conversion
      // entirely below threshold — common case, save the log10.
      let staticGainDb;
      if (peak <= 1e-10) {
        staticGainDb = 0;
      } else {
        const inputDb = 20 * Math.log10(peak);
        const overshoot = inputDb - threshold;
        staticGainDb = overshoot > 0 ? -overshoot * oneMinusInvRatio : 0;
      }

      // Smooth toward target. Attack when going further negative
      // (more reduction), release when coming back toward 0.
      if (staticGainDb < this.envelope) {
        this.envelope = staticGainDb + (this.envelope - staticGainDb) * attackCoeff;
      } else {
        this.envelope = staticGainDb + (this.envelope - staticGainDb) * releaseCoeff;
      }

      // Apply: gain = 10^(env/20) × makeup
      const linearGain = Math.pow(10, this.envelope / 20) * makeupLinear;
      for (let ch = 0; ch < channels; ch++) {
        output[ch][i] = input[ch][i] * linearGain;
      }
    }

    // Periodically publish the gain-reduction envelope so the UI's GR
    // meter can render. dB is always ≤ 0; the meter inverts it for
    // "how much we're squashing" in dB.
    this._blocksSincePublish++;
    if (this._blocksSincePublish >= this._publishEvery) {
      this._blocksSincePublish = 0;
      this.port.postMessage({ type: 'gr', envelopeDb: this.envelope });
    }

    return true;
  }
}

registerProcessor('track-compressor', TrackCompressorProcessor);
