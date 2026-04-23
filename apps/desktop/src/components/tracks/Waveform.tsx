import { useEffect, useState, useMemo, useRef, useCallback, memo } from 'react';
import { motion } from 'framer-motion';
import { useAudioStore } from '../../stores/audioStore';
import { rawDataCache, audioBufferCache, getAudioData, snapToBar, getPeaks, peaksCache, type ServerPeaks } from '../../lib/audio';

export default memo(function Waveform({
  seed, height = 60, fileId, projectId, showPlayhead = false, trackId, showTrimHandles = false,
}: {
  seed: string; height?: number; fileId?: string | null; projectId?: string; showPlayhead?: boolean; trackId?: string; showTrimHandles?: boolean;
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
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);

  const trimStart = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.trimStart ?? 0 : 0);
  const trimEnd = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.trimEnd ?? 0 : 0);
  const trackBuffer = useAudioStore((s) => trackId ? s.loadedTracks.get(trackId)?.buffer : undefined);
  const projectBpm = useAudioStore((s) => s.projectBpm);
  const setTrackTrim = useAudioStore((s) => s.setTrackTrim);

  const bufferDuration = trackBuffer?.duration || 0;
  const effectiveTrimEnd = trimEnd > 0 ? trimEnd : bufferDuration;
  const bpm = projectBpm > 0 ? projectBpm : 120;

  // If no fileId but we have a buffer (e.g. duplicated/split track), derive waveform from buffer
  useEffect(() => {
    if (!fileId && trackBuffer) {
      setRawData(trackBuffer.getChannelData(0));
    }
  }, [fileId, trackBuffer]);

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

  const audioData = rawData || fakeData;

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

    // Single pass over audioData: peaks, RMS, zero-crossing rate, crest factor.
    const peaks = new Float32Array(w);
    const rms = new Float32Array(w);
    const zcr = new Float32Array(w);
    const crest = new Float32Array(w);
    const onset = new Float32Array(w);
    const samplesPerPixel = audioData.length / w;
    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * samplesPerPixel);
      const end = Math.min(Math.floor((x + 1) * samplesPerPixel), audioData.length);
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

    // Pick a per-clip hue from the Ghost brand palette. Hash a stable id so the
    // same clip gets the same colour on every client and across reloads.
    const idKey = trackId || fileId || seed;
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
  }, [audioData, trackId, fileId, seed]);

  useEffect(() => {
    draw();
    const obs = new ResizeObserver(draw);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [draw]);

  // Trim handle dragging
  const handleMouseDown = useCallback((handle: 'start' | 'end') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingHandle(handle);
  }, []);

  useEffect(() => {
    if (!draggingHandle || !containerRef.current || !trackId || bufferDuration === 0) return;

    const container = containerRef.current;

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const rawTime = ratio * bufferDuration;
      const clamped = Math.max(0, Math.min(bufferDuration, rawTime));

      if (draggingHandle === 'start') {
        const maxStart = (trimEnd > 0 ? trimEnd : bufferDuration) - 0.01;
        setTrackTrim(trackId, Math.min(clamped, maxStart), trimEnd);
      } else {
        const minEnd = trimStart + 0.01;
        setTrackTrim(trackId, trimStart, Math.max(clamped, minEnd));
      }
    };

    const onMouseUp = () => {
      // Snap to nearest bar on release
      if (trackId) {
        const snappedStart = snapToBar(useAudioStore.getState().loadedTracks.get(trackId)?.trimStart ?? 0, bpm, 'nearest');
        const rawEnd = useAudioStore.getState().loadedTracks.get(trackId)?.trimEnd ?? 0;
        const snappedEnd = rawEnd > 0 ? snapToBar(rawEnd, bpm, 'nearest') : 0;
        setTrackTrim(trackId, Math.max(0, snappedStart), snappedEnd);
      }
      setDraggingHandle(null);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [draggingHandle, trackId, bufferDuration, bpm, trimStart, trimEnd, setTrackTrim]);

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
    } else if (isPlaying && !soloPlayingTrackId && bufferDuration > 0) {
      // Only show playhead when currentTime is within this clip's time range
      const clipStart = startOffset;
      const clipEnd = startOffset + bufferDuration;
      if (currentTime >= clipStart && currentTime <= clipEnd) {
        playheadPct = ((currentTime - clipStart) / bufferDuration) * 100;
        showLine = true;
      }
    }
  }

  const trimStartPct = bufferDuration > 0 ? (trimStart / bufferDuration) * 100 : 0;
  const trimEndPct = bufferDuration > 0 ? (effectiveTrimEnd / bufferDuration) * 100 : 100;

  return (
    <div ref={containerRef} className="flex-1 rounded relative" style={{ height, overflow: showTrimHandles ? 'visible' : 'hidden' }}>
      <canvas ref={canvasRef} style={{
        display: 'block',
        clipPath: showTrimHandles && bufferDuration > 0 && (trimStart > 0 || (trimEnd > 0 && trimEnd < bufferDuration))
          ? `inset(0 ${100 - trimEndPct}% 0 ${trimStartPct}%)`
          : undefined,
      }} />
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
      {showTrimHandles && bufferDuration > 0 && (
        <>
          {/* Left trim handle — gold tab with left chevron */}
          <div
            className="absolute top-0 bottom-0 cursor-col-resize z-20"
            style={{ left: `calc(${trimStartPct}% - 18px)`, width: 20 }}
            onMouseDown={handleMouseDown('start')}
          >
            <div
              className="absolute right-0 top-[4px] bottom-[4px] flex items-center justify-center transition-shadow"
              style={{
                width: 18,
                background: draggingHandle === 'start'
                  ? 'linear-gradient(180deg, #FFD700 0%, #E6AC00 100%)'
                  : 'linear-gradient(180deg, #F5C518 0%, #D4A017 100%)',
                borderRadius: '6px 0 0 6px',
                boxShadow: draggingHandle === 'start'
                  ? '0 0 12px rgba(245,197,24,0.6), -2px 0 8px rgba(0,0,0,0.4)'
                  : '-2px 0 6px rgba(0,0,0,0.3)',
              }}
            >
              <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
                <path d="M7 3L3 8L7 13" stroke="#1a1a1a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
          {/* Right trim handle — gold tab with right chevron */}
          <div
            className="absolute top-0 bottom-0 cursor-col-resize z-20"
            style={{ left: `calc(${trimEndPct}% - 2px)`, width: 20 }}
            onMouseDown={handleMouseDown('end')}
          >
            <div
              className="absolute left-0 top-[4px] bottom-[4px] flex items-center justify-center transition-shadow"
              style={{
                width: 18,
                background: draggingHandle === 'end'
                  ? 'linear-gradient(180deg, #FFD700 0%, #E6AC00 100%)'
                  : 'linear-gradient(180deg, #F5C518 0%, #D4A017 100%)',
                borderRadius: '0 6px 6px 0',
                boxShadow: draggingHandle === 'end'
                  ? '0 0 12px rgba(245,197,24,0.6), 2px 0 8px rgba(0,0,0,0.4)'
                  : '2px 0 6px rgba(0,0,0,0.3)',
              }}
            >
              <svg width="10" height="16" viewBox="0 0 10 16" fill="none">
                <path d="M3 3L7 8L3 13" stroke="#1a1a1a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
