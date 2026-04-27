import { useEffect, useRef } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { getAnalyser } from '../../stores/audio/graph';
import { TRACK_HEADER_WIDTH } from './ArrangementComponents';

/**
 * Master track lane — a regular-looking lane at the bottom of the
 * arrangement that controls the master bus. Header mirrors the FL/editor
 * TrackHeader style (solid block fill, name across the top, accent dot
 * + meter on the right) so the master reads as one of the lanes, not
 * a foreign control surface. The lane area holds the master fader and
 * a wider post-master level meter; clips can't drop here.
 */
export default function MasterTrackLane() {
  const masterVolume = useAudioStore((s) => s.masterVolume);
  const setMasterVolume = useAudioStore((s) => s.setMasterVolume);

  const meterRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  // Drive the meter from the master analyser via rAF.
  useEffect(() => {
    const analyser = getAnalyser();
    if (!analyser) return;

    const buf = new Float32Array(analyser.fftSize);
    let peakHold = 0;
    let lastPeakDecay = performance.now();

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const linear = peak * 0.7 + rms * 0.3;
      const db = linear > 0 ? 20 * Math.log10(linear) : -100;
      const normalized = Math.max(0, Math.min(1, (db + 60) / 60));

      if (meterRef.current) meterRef.current.style.width = `${normalized * 100}%`;

      const now = performance.now();
      const decay = (now - lastPeakDecay) / 1000;
      lastPeakDecay = now;
      peakHold = Math.max(normalized, peakHold - decay * 0.2);
      if (peakRef.current) peakRef.current.style.left = `${peakHold * 100}%`;

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const dbReadout = masterVolume > 0
    ? `${(20 * Math.log10(masterVolume)).toFixed(1)} dB`
    : '−∞';

  // Gold hue family — 50° = warm yellow. Same construction as TrackHeader's
  // fill / accent so the master reads as a lane peer instead of a special
  // banner.
  const fill = `hsl(50, 45%, 24%)`;
  const accent = `hsl(50, 88%, 60%)`;

  // 56 px = sits between the editor's half-zoom (48) and full-zoom (70)
  // lane heights. Tall enough for the slider + meter row to breathe,
  // short enough to read as a single lane.
  const laneHeight = 56;

  return (
    <div className="flex items-stretch border-t border-white/[0.08]" style={{ height: laneHeight }}>
      {/* Header — same construction as TrackHeader (solid block fill,
          name on the left, accent dot on the right). */}
      <div
        className="relative shrink-0 select-none flex items-center gap-1.5 px-2 rounded-l-md overflow-hidden"
        style={{
          width: TRACK_HEADER_WIDTH,
          background: fill,
          borderRight: `2px solid ${accent}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.25)',
        }}
        title="Master output"
      >
        <span className="text-[11px] font-semibold text-white/95 truncate flex-1" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
          MASTER
        </span>
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
        />
      </div>

      {/* Lane area — fader on the left third, level meter spanning the
          rest. dB readout sits inline above the slider. */}
      <div className="flex-1 relative px-3 flex items-center gap-3" style={{ background: 'rgba(10,4,18,0.55)' }}>
        <div className="flex items-center gap-2 shrink-0" style={{ width: 220 }}>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={masterVolume}
            onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
            className="flex-1"
            style={{ accentColor: accent }}
            aria-label="Master volume"
          />
          <span className="text-white/65 text-[10px] font-mono tabular-nums shrink-0" style={{ minWidth: 52 }}>
            {dbReadout}
          </span>
        </div>
        <div className="relative h-2 flex-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div
            ref={meterRef}
            className="absolute top-0 bottom-0 left-0"
            style={{
              width: '0%',
              background: 'linear-gradient(90deg, #00FFC8 0%, #00FFC8 60%, #F5C518 80%, #FF4444 100%)',
              transition: 'width 30ms linear',
            }}
          />
          <div
            ref={peakRef}
            className="absolute top-0 bottom-0"
            style={{ left: '0%', width: 1, background: 'rgba(255,255,255,0.85)' }}
          />
          {/* 0 dB tick — visual reference for "you are slamming the master". */}
          <div className="absolute top-0 bottom-0" style={{ left: '100%', width: 1, background: 'rgba(255,255,255,0.25)' }} />
        </div>
      </div>
    </div>
  );
}
