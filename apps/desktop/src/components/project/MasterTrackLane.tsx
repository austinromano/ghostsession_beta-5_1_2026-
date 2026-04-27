import { useEffect, useRef } from 'react';
import { getAnalyser } from '../../stores/audio/graph';
import { TRACK_HEADER_WIDTH } from './ArrangementComponents';

/**
 * Master track lane — looks exactly like a regular lane, no controls.
 * Header is the FL/editor TrackHeader treatment (solid block fill,
 * name, accent dot, inline level meter); the lane area is intentionally
 * empty. The level meter taps the master analyser so it reflects the
 * SUM of every track + drum row going through the master bus.
 */
export default function MasterTrackLane({ trackZoom = 'full' }: { trackZoom?: 'full' | 'half' }) {
  // Same lane heights DraggableTrackList uses for regular lanes — keeps
  // the master visually flush with the rest of the arrangement.
  const laneHeight = trackZoom === 'half' ? 50 : 72;

  // Gold hue family. Same hsl() construction as TrackHeader so the master
  // reads as a lane peer instead of a foreign banner.
  const fill = `hsl(50, 45%, 24%)`;
  const accent = `hsl(50, 88%, 60%)`;

  return (
    <div className="flex relative" style={{ height: laneHeight }}>
      <div
        className="relative shrink-0 select-none flex items-center gap-1.5 px-2 rounded-l-md overflow-hidden"
        style={{
          width: TRACK_HEADER_WIDTH,
          height: '100%',
          background: fill,
          borderRight: `2px solid ${accent}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.25)',
        }}
        title="Master output — sum of every track + drum row"
      >
        <span
          className="text-[11px] font-semibold text-white/95 truncate flex-1"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
        >
          MASTER
        </span>
        <span
          className="shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 4px ${accent}` }}
        />
        <MasterLevelMeter />
      </div>
      {/* Empty lane area — same background tone as regular lanes so the
          master row blends into the arrangement. No clips, no controls. */}
      <div className="flex-1 relative" style={{ background: 'rgba(10,4,18,0.4)' }} />
    </div>
  );
}

/**
 * Same shape as `LaneLevelMeter` (a 4 px vertical VU strip inline in the
 * lane header), but reads off the master analyser so the bar reflects
 * the post-master output level — the sum of every track + drum hit
 * routed through getMaster().
 */
function MasterLevelMeter() {
  const fillRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const analyser = getAnalyser();
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    let lastDisplayed = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const abs = buf[i] < 0 ? -buf[i] : buf[i];
        if (abs > peak) peak = abs;
      }
      // Mild attack / release so the meter tracks audio without
      // flickering on every frame — same constants LaneLevelMeter uses.
      const next = peak > lastDisplayed ? peak : lastDisplayed * 0.85 + peak * 0.15;
      lastDisplayed = next;
      const el = fillRef.current;
      if (el) el.style.height = `${Math.min(100, next * 100)}%`;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div
      className="relative shrink-0 rounded-sm overflow-hidden"
      style={{
        width: 4,
        height: '70%',
        background: 'rgba(0,0,0,0.45)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}
    >
      <div
        ref={fillRef}
        className="absolute bottom-0 left-0 right-0"
        style={{
          height: '0%',
          // Classic VU gradient — green safe → amber → red near clipping.
          background: 'linear-gradient(180deg, #ff4d4d 0%, #ffd24d 25%, #4dff8c 60%, #2bd16f 100%)',
          transition: 'height 0.05s linear',
        }}
      />
    </div>
  );
}
