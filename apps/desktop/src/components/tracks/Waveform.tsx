import { useEffect, useState, useMemo, useRef, useCallback, memo } from 'react';
import { motion } from 'framer-motion';
import { useAudioStore, getEffectiveDuration } from '../../stores/audioStore';
import { rawDataCache, audioBufferCache, getAudioData, snapToGrid, getPeaks, peaksCache, type ServerPeaks } from '../../lib/audio';

export default memo(function Waveform({
  seed, height = 60, fileId, projectId, showPlayhead = false, trackId, viewStart, viewEnd,
}: {
  seed: string; height?: number; fileId?: string | null; projectId?: string; showPlayhead?: boolean; trackId?: string;
  // Optional crop into the source buffer. When set, only audio in
  // [viewStart, viewEnd] seconds is rendered, stretched to fill the canvas
  // and the playhead. Used by the arrangement clip so the visible waveform
  // matches the clip box once it has been trimmed.
  viewStart?: number; viewEnd?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [rawData, setRawData] = useState<Float32Array | null>(
    fileId ? rawDataCache.get(fileId) || null : null
  );
  const [serverPeaks, setServerPeaks] = useState<ServerPeaks | null>(
    fileId ? peaksCache.get(fileId) || null : null
  );

  const [loadFailed, setLoadFailed] = useState(false);

  const trackBuffer = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.buffer : undefined);
  const trackPitch = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.pitch ?? 0 : 0);

  const bufferDuration = trackBuffer?.duration || 0;
  // Effective (project-time) duration accounts for the pitch playbackRate
  // so the inner playhead lines up with the visual clip width.
  const fullEffectiveDuration = trackBuffer ? getEffectiveDuration({ buffer: trackBuffer, pitch: trackPitch }) : 0;
  // Resolve the visible audio window. Default = full buffer.
  const resolvedViewStart = viewStart ?? 0;
  const resolvedViewEnd = (viewEnd && viewEnd > 0) ? viewEnd : bufferDuration;
  const viewSpan = Math.max(0, resolvedViewEnd - resolvedViewStart);
  // Effective duration of just the cropped slice — drives the playhead so
  // it tracks across only the visible portion of the buffer.
  const effectiveDuration = bufferDuration > 0
    ? fullEffectiveDuration * (viewSpan / bufferDuration)
    : 0;

  // Track buffer changes (warp marker drag, pitch / BPM / warp toggle)
  // are picked up directly in the audioData derivation below — no
  // useEffect → setRawData round trip, which used to add a one-render
  // lag where the FIRST frame after a buffer change still drew the
  // old peaks. The bufferVersion subscription forces a re-render
  // whenever the audio store rebuilds a buffer, so the canvas redraws
  // mid-drag too.
  const bufferVersion = useAudioStore((s) => s.bufferVersion);
  void bufferVersion;

  useEffect(() => {
    if (!fileId || !projectId) return;
    let cancelled = false;

    // 1) Render instantly from server-computed peaks (tiny JSON).
    if (!peaksCache.has(fileId)) {
      getPeaks(projectId, fileId).then((p) => {
        if (!cancelled && p) setServerPeaks(p);
      }).catch((err) => { if (import.meta.env.DEV) console.warn('[Waveform] getPeaks failed:', err); });
    }

    // 2) Kick off full decode in background for playback, trim handles, etc.
    if (rawDataCache.has(fileId)) {
      setRawData(rawDataCache.get(fileId)!);
    } else {
      getAudioData(projectId, fileId)
        .then(({ channelData }) => {
          if (!cancelled) setRawData(channelData);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    }

    return () => { cancelled = true; };
  }, [fileId, projectId]);

  const fakeData = useMemo(() => {
    if (rawData) return null;
    if (fileId && projectId && !loadFailed) return null;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const len = 44100 * 4;
    const data = new Float32Array(len);
    let env = 0;
    for (let i = 0; i < len; i++) {
      h = ((h * 1103515245 + 12345) & 0x7fffffff);
      const noise = ((h & 0xffff) / 32768) - 1;
      if (i % 512 === 0) {
        h = ((h * 1103515245 + 12345) & 0x7fffffff);
        const target = (h % 100) / 100;
        env += (target - env) * 0.3;
      }
      data[i] = noise * env * 0.9;
    }
    return data;
  }, [seed, rawData, fileId, projectId, loadFailed]);

  // Derive audioData directly from whichever source is freshest. Track
  // buffer wins when a track is loaded (changes per warp / pitch / BPM
  // edit), then the rawData state (sample library previews + the
  // fileId-decode fallback), then the placeholder fake noise. Pulling
  // off the live buffer here means the draw effect fires the same
  // render the buffer changes — no setState round trip in between.
  const audioData = trackBuffer ? trackBuffer.getChannelData(0) : (rawData || fakeData);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    // Don't paint until raw audio is decoded — timbre coloring needs the PCM
    // samples. Rendering from serverPeaks alone would flash a wrong-hue
    // version before the real one.
    if (!audioData) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10, 4, 18, 0.7)';
    ctx.fillRect(0, 0, w, h);

    const mid = h / 2;

    // Resolve the audio sample range to render. When viewStart/viewEnd are
    // set, only that slice fills the canvas — the trimmed clip box and the
    // waveform stay visually aligned without needing a CSS clip-path.
    const totalSamples = audioData.length;
    const viewSampleStart = bufferDuration > 0
      ? Math.max(0, Math.floor((resolvedViewStart / bufferDuration) * totalSamples))
      : 0;
    const viewSampleEnd = bufferDuration > 0
      ? Math.min(totalSamples, Math.ceil((resolvedViewEnd / bufferDuration) * totalSamples))
      : totalSamples;
    const visibleSamples = Math.max(1, viewSampleEnd - viewSampleStart);

    // Single pass over the visible slice: peaks, RMS, zero-crossing rate, crest factor.
    const peaks = new Float32Array(w);
    const rms = new Float32Array(w);
    const zcr = new Float32Array(w);
    const crest = new Float32Array(w);
    const onset = new Float32Array(w);
    const samplesPerPixel = visibleSamples / w;
    for (let x = 0; x < w; x++) {
      const start = viewSampleStart + Math.floor(x * samplesPerPixel);
      const end = Math.min(viewSampleStart + Math.floor((x + 1) * samplesPerPixel), viewSampleEnd);
      let max = 0, sumSq = 0, zc = 0, prevSign = 0;
      for (let j = start; j < end; j++) {
        const v = audioData[j];
        const abs = v < 0 ? -v : v;
        if (abs > max) max = abs;
        sumSq += v * v;
        const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
        if (prevSign !== 0 && sign !== 0 && sign !== prevSign) zc++;
        if (sign !== 0) prevSign = sign;
      }
      const count = end - start;
      peaks[x] = max;
      const r = count > 0 ? Math.sqrt(sumSq / count) : 0;
      rms[x] = r;
      zcr[x] = count > 0 ? zc / count : 0;
      crest[x] = r > 1e-6 ? max / r : 1;
    }
    for (let x = 1; x < w; x++) onset[x] = Math.max(0, rms[x] - rms[x - 1]);

    const scalePeak = mid * 0.9;
    const scaleRms = mid * 1.7; // amplify RMS — it's always smaller than peak

    // Pick a per-lane hue from the Ghost brand palette. Lanes are grouped by
    // fileId upstream, so hashing fileId first keeps every duplicate/split of
    // the same source clip in the same colour as the original.
    const idKey = fileId || trackId || seed;
    let hh = 0;
    for (let i = 0; i < idKey.length; i++) hh = ((hh << 5) - hh + idKey.charCodeAt(i)) | 0;
    const palette = [270, 165, 300, 220, 190, 330]; // purple, teal, violet, blue, cyan, pink
    const hue = palette[Math.abs(hh) % palette.length];

    for (let x = 0; x < w; x++) {
      const peakTop = peaks[x] * scalePeak;
      if (peakTop < 0.5) continue;
      const rmsTop = Math.min(rms[x] * scaleRms, peakTop);
      // Crest factor: sine ≈ 1.41, percussive hits 3+. Clamp to 40% boost.
      const sat = 55 + Math.min(35, (crest[x] - 1.4) * 10);
      // Onset energy brightens attacks — caps at +18% lightness.
      const light = 52 + Math.min(18, onset[x] * 140);
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, 0.32)`;
      ctx.fillRect(x, mid - peakTop, 1, peakTop * 2);
      ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
      ctx.fillRect(x, mid - rmsTop, 1, rmsTop * 2);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, mid - 0.5, w, 1);
  }, [audioData, trackId, fileId, seed, bufferDuration, resolvedViewStart, resolvedViewEnd]);

  useEffect(() => {
    draw();
    const obs = new ResizeObserver(draw);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [draw]);

  const currentTime = useAudioStore((s) => s.currentTime);
  const duration = useAudioStore((s) => s.duration);
  const isPlaying = useAudioStore((s) => s.isPlaying);
  const soloPlayingTrackId = useAudioStore((s) => s.soloPlayingTrackId);
  const soloCurrentTime = useAudioStore((s) => s.soloCurrentTime);
  const soloDuration = useAudioStore((s) => s.soloDuration);

  const startOffset = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.startOffset ?? 0 : 0);

  let playheadPct = 0;
  let showLine = false;
  if (showPlayhead && trackId) {
    if (soloPlayingTrackId === trackId && soloDuration > 0) {
      playheadPct = (soloCurrentTime / soloDuration) * 100;
      showLine = playheadPct >= 0 && playheadPct <= 100;
    } else if (isPlaying && !soloPlayingTrackId && effectiveDuration > 0) {
      // Position the playhead against effective (project-time) duration —
      // the same width the clip is rendered at — so it tracks the audio
      // in real time even when the buffer was pre-stretched for pitch.
      const clipStart = startOffset;
      const clipEnd = startOffset + effectiveDuration;
      if (currentTime >= clipStart && currentTime <= clipEnd) {
        playheadPct = ((currentTime - clipStart) / effectiveDuration) * 100;
        showLine = true;
      }
    }
  }

  return (
    <div ref={containerRef} className="flex-1 rounded relative overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      {!audioData && fileId && !loadFailed && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <motion.svg
            width="26"
            height="28"
            viewBox="0 0 20 22"
            fill="none"
            animate={{ y: [0, -3, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <defs>
              <linearGradient id="ghostLoaderBase" x1="0" y1="0" x2="20" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#00FFC8" />
                <stop offset="100%" stopColor="#7C3AED" />
              </linearGradient>
            </defs>
            {/* Base ghost — same glyph as the top-left navigation ghost. */}
            <path
              d="M10 1C5.5 1 2 4.5 2 9v8l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2V9c0-4.5-3.5-8-8-8z"
              fill="rgba(0,255,200,0.08)"
              stroke="url(#ghostLoaderBase)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              opacity="0.5"
            />
            <ellipse cx="7.5" cy="9.5" rx="1.6" ry="1.8" fill="url(#ghostLoaderBase)" opacity="0.9" />
            <ellipse cx="12.5" cy="9.5" rx="1.6" ry="1.8" fill="url(#ghostLoaderBase)" opacity="0.9" />
            <ellipse cx="7.5" cy="9.2" rx="0.6" ry="0.7" fill="#0A0412" />
            <ellipse cx="12.5" cy="9.2" rx="0.6" ry="0.7" fill="#0A0412" />
            {/* Purple arc chasing around the outline — the "loading" signal. */}
            <motion.path
              d="M10 1C5.5 1 2 4.5 2 9v8l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2V9c0-4.5-3.5-8-8-8z"
              fill="none"
              stroke="#A855F7"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={100}
              strokeDasharray="18 82"
              style={{ filter: 'drop-shadow(0 0 3px rgba(168,85,247,0.9))' }}
              animate={{ strokeDashoffset: [0, -100] }}
              transition={{ duration: 1.3, repeat: Infinity, ease: 'linear' }}
            />
          </motion.svg>
        </div>
      )}
      {showLine && (
        <div
          className="absolute top-0 bottom-0 w-[2px] pointer-events-none"
          style={{ left: `${playheadPct}%`, background: '#00FFC8', boxShadow: '0 0 6px rgba(0,255,200,0.6), 0 0 12px rgba(0,255,200,0.2)' }}
        />
      )}
    </div>
  );
});
