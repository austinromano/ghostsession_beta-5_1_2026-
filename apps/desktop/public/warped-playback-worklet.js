// AudioWorklet processor for warped sample playback.
//
// Replaces the per-track BufferSource + main-thread `composePlayBuffer`
// rebuild for clips that have warp markers. Streams audio out one
// 128-sample block at a time from the audio thread, with the warp
// stretch applied as a piecewise-linear source-time → output-time map.
//
// Why a worklet:
// - Marker drags don't have to rebuild a whole AudioBuffer per pixel,
//   so the main thread stays responsive.
// - Param updates posted via MessagePort take effect on the next block
//   (≈3 ms at 48 kHz) instead of waiting for a full WSOLA recompute.
//
// Trade-off vs the existing main-thread WSOLA path:
// - Stretching is linear interpolation per-sample (no spectral
//   smoothing). Sounds clean for ±20% timing tweaks (typical warp
//   marker work). Big stretches (>±50%) sound like a vinyl
//   slow-down / speed-up. Good-enough for v1; PSOLA / WSOLA inside
//   the worklet is the next milestone.
//
// Message protocol (main → worklet):
//   { type: 'init', channels: Float32Array[], sampleRate: number }
//   { type: 'params', markers, baseStretch, pitchFactor, trimStart,
//                     trimEnd, volume }
//   { type: 'play',   startCtxTime: number, startProjectSec: number }
//   { type: 'stop' }
//
// Worklet → main:
//   { type: 'ended' }   — fires once when playback walks past trimEnd

/* global registerProcessor, AudioWorkletProcessor, sampleRate */

class WarpedPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Source audio (channels of Float32Array). Set by the 'init'
    // message — the main thread transfers ownership so we don't pay
    // the structured-clone cost.
    this.channels = [];
    this.sourceSampleRate = sampleRate;

    // Warp / stretch state. baseStretch == warpFactor (sourceBpm /
    // projectBpm); pitchFactor multiplies the source read rate to
    // shift pitch (couples speed for now — proper pitch-preserving
    // stretching is a follow-up).
    this.markers = [];
    this.baseStretch = 1;
    this.pitchFactor = 1;
    this.trimStart = 0;
    this.trimEnd = 0; // 0 = use full source
    this.volume = 1;

    // Playback state.
    this.isPlaying = false;
    this.startCtxTime = 0;       // currentTime to begin playback
    this.startProjectSec = 0;    // project-time the play head started at
    this.endNotified = false;

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'init':
        this.channels = msg.channels;
        this.sourceSampleRate = msg.sampleRate || sampleRate;
        break;
      case 'params':
        if (Array.isArray(msg.markers)) {
          // Defensive sort — the main thread should have already sorted,
          // but the segment math below assumes monotonic sourceSec.
          this.markers = msg.markers.slice().sort((a, b) => a.sourceSec - b.sourceSec);
        }
        if (typeof msg.baseStretch === 'number') this.baseStretch = msg.baseStretch;
        if (typeof msg.pitchFactor === 'number') this.pitchFactor = msg.pitchFactor;
        if (typeof msg.trimStart === 'number') this.trimStart = msg.trimStart;
        if (typeof msg.trimEnd === 'number') this.trimEnd = msg.trimEnd;
        if (typeof msg.volume === 'number') this.volume = msg.volume;
        break;
      case 'play':
        this.isPlaying = true;
        this.startCtxTime = msg.startCtxTime || currentTime;
        this.startProjectSec = msg.startProjectSec || 0;
        this.endNotified = false;
        break;
      case 'stop':
        this.isPlaying = false;
        break;
    }
  }

  // Map output (project) time → source time using piecewise linear
  // segments defined by warp markers. Implicit endpoints (0,0) and
  // (sourceLen, sourceLen * baseStretch) bracket the user's markers
  // so the head and tail of the source are always reachable.
  outputToSource(outputProjectSec) {
    const sourceLen = this.channels.length > 0
      ? this.channels[0].length / this.sourceSampleRate
      : 0;
    if (sourceLen <= 0) return -1;

    if (this.markers.length === 0) {
      // No markers — single global segment from (0,0) to
      // (sourceLen, sourceLen * baseStretch).
      const totalOutput = sourceLen * this.baseStretch;
      if (outputProjectSec < 0 || outputProjectSec > totalOutput) return -1;
      return (outputProjectSec / totalOutput) * sourceLen;
    }

    // Walk segments. Each segment maps a [bufferSec_a, bufferSec_b]
    // range to [sourceSec_a, sourceSec_b].
    let prevSource = 0;
    let prevBuffer = 0;
    for (let i = 0; i <= this.markers.length; i++) {
      const next = i < this.markers.length
        ? this.markers[i]
        : { sourceSec: sourceLen, bufferSec: sourceLen * this.baseStretch };
      if (outputProjectSec >= prevBuffer && outputProjectSec <= next.bufferSec) {
        const segSource = next.sourceSec - prevSource;
        const segBuffer = next.bufferSec - prevBuffer;
        if (segBuffer <= 0) return prevSource;
        const t = (outputProjectSec - prevBuffer) / segBuffer;
        return prevSource + t * segSource;
      }
      prevSource = next.sourceSec;
      prevBuffer = next.bufferSec;
    }
    return -1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const blockSize = output[0].length;
    const outChannels = output.length;

    if (!this.isPlaying || this.channels.length === 0) {
      for (let ch = 0; ch < outChannels; ch++) output[ch].fill(0);
      return true;
    }

    const sourceLen = this.channels[0].length / this.sourceSampleRate;
    const trimEndEff = this.trimEnd > 0 ? this.trimEnd : sourceLen;
    let allSilent = true;

    for (let i = 0; i < blockSize; i++) {
      // currentTime advances per block, so we interpolate within the
      // block by deriving each sample's project time from the block's
      // start time + sample index.
      const sampleCtxTime = currentTime + i / sampleRate;
      if (sampleCtxTime < this.startCtxTime) {
        // Pre-roll silence until the scheduled start.
        for (let ch = 0; ch < outChannels; ch++) output[ch][i] = 0;
        continue;
      }
      const elapsed = sampleCtxTime - this.startCtxTime;
      // pitchFactor squeezes / stretches the project-time the worklet
      // walks through the buffer, so a +1 octave shift reads twice as
      // fast (and shortens the clip — coupling speed + pitch the same
      // way the BufferSource path does today).
      const outputProjectSec = this.startProjectSec + elapsed * this.pitchFactor;

      let sourceSec = this.outputToSource(outputProjectSec);
      if (sourceSec < 0 || sourceSec < this.trimStart || sourceSec >= trimEndEff) {
        for (let ch = 0; ch < outChannels; ch++) output[ch][i] = 0;
        continue;
      }
      allSilent = false;

      // Linear sample interpolation in the source.
      const srcIdx = sourceSec * this.sourceSampleRate;
      const idxFloor = Math.floor(srcIdx);
      const frac = srcIdx - idxFloor;
      for (let ch = 0; ch < outChannels; ch++) {
        const srcCh = this.channels[Math.min(ch, this.channels.length - 1)];
        if (idxFloor < 0 || idxFloor >= srcCh.length - 1) {
          output[ch][i] = 0;
          continue;
        }
        const a = srcCh[idxFloor];
        const b = srcCh[idxFloor + 1];
        output[ch][i] = (a + (b - a) * frac) * this.volume;
      }
    }

    // Notify main thread once when playback walks past trimEnd so the
    // store can mark the source as finished (matches BufferSource's
    // 'ended' event).
    if (allSilent && !this.endNotified && this.isPlaying) {
      // Probe the very next sample — if outputToSource returns -1 (past
      // the source end) for a position past trimEnd, we're truly done.
      const probe = this.outputToSource(
        this.startProjectSec + (currentTime + blockSize / sampleRate - this.startCtxTime) * this.pitchFactor,
      );
      if (probe < 0 || probe >= trimEndEff) {
        this.endNotified = true;
        this.port.postMessage({ type: 'ended' });
      }
    }

    return true;
  }
}

registerProcessor('warped-playback', WarpedPlaybackProcessor);
