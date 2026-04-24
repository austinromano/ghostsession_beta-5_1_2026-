// BPM / beat detection.
//
// Algorithm: onset-strength autocorrelation.
//   1. Decode PCM from the WAV buffer (ignores anything that isn't 16-bit /
//      24-bit / 32-bit-float PCM — caller decides what to do in that case).
//   2. Downmix to mono, downsample to ~4 kHz so the autocorrelation is cheap.
//   3. Compute a short-time energy curve, then half-wave-rectified first
//      derivative — the onset strength function.
//   4. Autocorrelate the onset function over lags corresponding to the BPM
//      range [minBpm, maxBpm], pick the peak.
//   5. Locate the first prominent onset → firstBeatOffset.
//   6. Propagate beats at the detected period from firstBeatOffset across the
//      file duration.
//
// Not as accurate as essentia.js or a neural beat tracker, but good enough
// for producer loops / drum samples / melodic one-shots, runs in ~50ms on
// typical files, and adds zero WASM/native dependencies to the server.
// We can swap in essentia.js in Phase 2+ without changing the call sites.

export interface BpmAnalysis {
  bpm: number;              // detected tempo, clamped to [60, 200]
  confidence: number;       // normalised autocorrelation peak (0..1)
  firstBeatOffset: number;  // seconds from sample start to first detected beat
  beats: number[];          // beat timestamps in seconds
  durationSec: number;      // full sample duration (for the caller's convenience)
}

/** Decode a WAV buffer into mono Float32 samples. Returns null on unsupported formats. */
export function decodeWavMono(buffer: Buffer): { samples: Float32Array; sampleRate: number } | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmtSubchunk: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataStart = -1;
  let dataSize = 0;

  // Walk RIFF chunks until we've seen fmt  and data.
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      const audioFormat = buffer.readUInt16LE(offset + 8);
      const channels = buffer.readUInt16LE(offset + 10);
      const sampleRate = buffer.readUInt32LE(offset + 12);
      const bitsPerSample = buffer.readUInt16LE(offset + 22);
      fmtSubchunk = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (chunkId === 'data') {
      dataStart = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize & 1);
  }

  if (!fmtSubchunk || dataStart < 0) return null;
  const { audioFormat, channels, sampleRate, bitsPerSample } = fmtSubchunk;

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * channels));
  const out = new Float32Array(frameCount);

  if (audioFormat === 1) {
    // PCM integer
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        const sampleOffset = dataStart + (i * channels + ch) * bytesPerSample;
        let v = 0;
        if (bitsPerSample === 16) {
          v = buffer.readInt16LE(sampleOffset) / 32768;
        } else if (bitsPerSample === 24) {
          const b0 = buffer[sampleOffset];
          const b1 = buffer[sampleOffset + 1];
          const b2 = buffer[sampleOffset + 2];
          let v24 = b0 | (b1 << 8) | (b2 << 16);
          if (v24 & 0x800000) v24 |= ~0xffffff;
          v = v24 / 8388608;
        } else if (bitsPerSample === 32) {
          v = buffer.readInt32LE(sampleOffset) / 2147483648;
        } else if (bitsPerSample === 8) {
          v = (buffer.readUInt8(sampleOffset) - 128) / 128;
        } else {
          return null;
        }
        sum += v;
      }
      out[i] = sum / channels;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    // IEEE float
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        sum += buffer.readFloatLE(dataStart + (i * channels + ch) * 4);
      }
      out[i] = sum / channels;
    }
  } else {
    return null; // unsupported (e.g. MP3 in RIFF, A-law, etc.)
  }

  return { samples: out, sampleRate };
}

/**
 * Run BPM + beat analysis on a mono sample buffer.
 * Algorithm details at the top of the file.
 */
export function analyseBpm(samples: Float32Array, sampleRate: number, opts: { minBpm?: number; maxBpm?: number } = {}): BpmAnalysis {
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const durationSec = samples.length / sampleRate;

  // 1. Downsample to ~4 kHz. Onset detection doesn't need HF content and
  //    the autocorrelation is O(N*lagRange) so every halving matters.
  const targetSr = 4000;
  const ratio = Math.max(1, Math.floor(sampleRate / targetSr));
  const dsLen = Math.floor(samples.length / ratio);
  const ds = new Float32Array(dsLen);
  for (let i = 0; i < dsLen; i++) ds[i] = samples[i * ratio];
  const sr = sampleRate / ratio;

  // 2. Short-time RMS envelope.
  const windowSec = 0.020; // 20 ms — long enough to smooth sample-level noise, short enough to resolve hi-hat onsets
  const window = Math.max(4, Math.floor(sr * windowSec));
  const hop = Math.max(1, Math.floor(window / 2));
  const numFrames = Math.max(0, Math.floor((ds.length - window) / hop));
  if (numFrames < 4) {
    return { bpm: 120, confidence: 0, firstBeatOffset: 0, beats: [], durationSec };
  }
  const env = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * hop;
    for (let j = 0; j < window; j++) {
      const s = ds[start + j];
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / window);
  }

  // 3. Half-wave-rectified derivative — spectral-flux-style onset strength
  //    but in the time domain. Subtract a slow moving average to suppress
  //    steady-state bias (long pads, etc.).
  const onset = new Float32Array(numFrames);
  const smoothWin = 20; // ~200 ms at hop=10ms
  let runSum = 0;
  const runBuf = new Float32Array(smoothWin);
  let runIdx = 0;
  for (let i = 0; i < numFrames; i++) {
    runSum -= runBuf[runIdx];
    runBuf[runIdx] = env[i];
    runSum += env[i];
    runIdx = (runIdx + 1) % smoothWin;
    const avg = runSum / Math.min(i + 1, smoothWin);
    const deriv = i > 0 ? env[i] - env[i - 1] : 0;
    onset[i] = Math.max(0, deriv - avg * 0.02);
  }

  // 4. Autocorrelation over BPM range.
  const frameDur = hop / sr;
  const minLag = Math.max(1, Math.floor(60 / maxBpm / frameDur));
  const maxLag = Math.min(numFrames - 1, Math.floor(60 / minBpm / frameDur));
  let bestLag = minLag;
  let bestCorr = -Infinity;
  // Pre-compute normalisation denominators so confidence is comparable
  // across files of different loudness.
  let autoZero = 0;
  for (let i = 0; i < numFrames; i++) autoZero += onset[i] * onset[i];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const end = numFrames - lag;
    for (let i = 0; i < end; i++) corr += onset[i] * onset[i + lag];
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  const confidence = autoZero > 0 ? Math.min(1, Math.max(0, bestCorr / autoZero)) : 0;
  let bpm = 60 / (bestLag * frameDur);

  // Octave correction: if detected tempo is <72 BPM and doubling stays in
  // range, prefer the double (drum loops often get detected at half-time).
  if (bpm < 72 && bpm * 2 <= maxBpm) bpm *= 2;
  // Same trick for >160 — halve if it falls back into a musical range.
  else if (bpm > 160 && bpm / 2 >= minBpm) bpm /= 2;

  // 5. First beat: the earliest prominent onset peak.
  let maxOnset = 0;
  for (let i = 0; i < numFrames; i++) if (onset[i] > maxOnset) maxOnset = onset[i];
  const firstBeatThresh = maxOnset * 0.25;
  let firstBeatFrame = 0;
  for (let i = 1; i < numFrames - 1; i++) {
    if (onset[i] > firstBeatThresh && onset[i] >= onset[i - 1] && onset[i] >= onset[i + 1]) {
      firstBeatFrame = i;
      break;
    }
  }
  const firstBeatOffset = firstBeatFrame * frameDur;

  // 6. Generate beat grid from detected tempo starting at firstBeatOffset.
  const beatInterval = 60 / bpm;
  const beats: number[] = [];
  for (let t = firstBeatOffset; t < durationSec; t += beatInterval) beats.push(Number(t.toFixed(4)));

  return { bpm: Number(bpm.toFixed(2)), confidence: Number(confidence.toFixed(3)), firstBeatOffset: Number(firstBeatOffset.toFixed(4)), beats, durationSec };
}

/** Convenience: run the whole analysis on a WAV buffer. Returns null for non-WAV / unsupported. */
export function analyseWav(buffer: Buffer): BpmAnalysis | null {
  const decoded = decodeWavMono(buffer);
  if (!decoded) return null;
  return analyseBpm(decoded.samples, decoded.sampleRate);
}
