import { useMemo, useRef } from 'react';
import {
  EQ_BAND_LABELS,
  defaultParams,
  useEffectsStore,
  type EqParams,
  type Effect,
} from '../../stores/effectsStore';

// 4-band parametric EQ panel. Drag any of the four nodes to reshape the
// curve; the readouts at the bottom mirror live freq + gain values.
//
// The plotted curve is a visual approximation — sum of Gaussian peaks
// per band, so the shape responds smoothly to gain changes without
// implementing real biquad math (this is the visual layer; the audio
// graph isn't wired yet). Once DSP routing lands, the same band state
// drives real BiquadFilter "peaking" nodes.

const LOG_MIN = Math.log10(20);     // 20 Hz
const LOG_MAX = Math.log10(20000);  // 20 kHz
const GAIN_RANGE = 12;              // ±12 dB clamp

const VIEW_W = 280;
const VIEW_H = 130;
const PAD_X = 12;
const PAD_Y = 8;
const PLOT_X = PAD_X;
const PLOT_Y = PAD_Y;
const PLOT_W = VIEW_W - PAD_X * 2;
const PLOT_H = VIEW_H - PAD_Y * 2;

// Each band's "Q" — width of its Gaussian contribution in log-frequency
// units. ~0.55 octaves is a reasonable visual peaking curve.
const BAND_SIGMA = 0.55;

function freqToX(freq: number): number {
  const f = Math.max(20, Math.min(20000, freq));
  const t = (Math.log10(f) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return PLOT_X + t * PLOT_W;
}

function xToFreq(x: number): number {
  const t = Math.max(0, Math.min(1, (x - PLOT_X) / PLOT_W));
  return Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
}

function gainToY(dB: number): number {
  const clamped = Math.max(-GAIN_RANGE, Math.min(GAIN_RANGE, dB));
  // 0 dB sits in the middle vertically. Positive gain pushes y toward
  // the top (smaller y in SVG coords).
  return PLOT_Y + (PLOT_H / 2) - (clamped / GAIN_RANGE) * (PLOT_H / 2 - 6);
}

function yToGain(y: number): number {
  const center = PLOT_Y + PLOT_H / 2;
  const halfRange = PLOT_H / 2 - 6;
  const dB = ((center - y) / halfRange) * GAIN_RANGE;
  return Math.max(-GAIN_RANGE, Math.min(GAIN_RANGE, dB));
}

// Gaussian peak contribution at logF for one band.
function bandResponseDb(logF: number, bandLogF: number, bandGainDb: number): number {
  const d = logF - bandLogF;
  return bandGainDb * Math.exp(-(d * d) / (2 * BAND_SIGMA * BAND_SIGMA));
}

function formatFreq(f: number): string {
  if (f >= 1000) return `${(f / 1000).toFixed(1)} kHz`;
  return `${f.toFixed(1)} Hz`;
}

function formatGain(dB: number): string {
  const v = dB.toFixed(1);
  return `${dB >= 0 ? '+' : ''}${v} dB`;
}

export default function ChannelEqPanel({
  laneKey,
  effect,
  onClose,
  onHeaderPointerDown,
}: {
  laneKey: string;
  effect: Effect;
  onClose?: () => void;
  // Optional: when supplied, the header strip becomes a drag handle
  // for an outer Reorder.Item. The panel itself never starts a drag —
  // only this hook lets the parent escalate the gesture to a reorder.
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const setEqBand = useEffectsStore((s) => s.setEqBand);
  const toggleBypass = useEffectsStore((s) => s.toggleBypass);

  const params: EqParams = useMemo(() => {
    if (effect.params && 'bands' in effect.params) return effect.params as EqParams;
    return defaultParams('eq') as EqParams;
  }, [effect.params]);

  const bands = params.bands;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);

  // Generate the response curve as 120 sample points across the
  // visible log-frequency range. Recomputed on every render — cheap,
  // 120 points × 4 bands × cheap math.
  const curvePath = useMemo(() => {
    const pts: string[] = [];
    const STEPS = 120;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const logF = LOG_MIN + t * (LOG_MAX - LOG_MIN);
      let dB = 0;
      for (const band of bands) {
        dB += bandResponseDb(logF, Math.log10(band.freq), band.gain);
      }
      const x = PLOT_X + t * PLOT_W;
      const y = gainToY(dB);
      pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return pts.join(' ');
  }, [bands]);

  // The same curve, closed at the bottom of the plot — used as the
  // gradient-filled area beneath the line.
  const fillPath = useMemo(() => {
    return `${curvePath} L ${PLOT_X + PLOT_W} ${PLOT_Y + PLOT_H} L ${PLOT_X} ${PLOT_Y + PLOT_H} Z`;
  }, [curvePath]);

  const onPointerDown = (idx: number) => (e: React.PointerEvent<SVGCircleElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = idx;
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = dragRef.current;
    if (idx == null) return;
    const svg = svgRef.current;
    if (!svg) return;
    // Convert client coords → SVG-viewBox coords.
    const rect = svg.getBoundingClientRect();
    const xRatio = VIEW_W / rect.width;
    const yRatio = VIEW_H / rect.height;
    const x = (e.clientX - rect.left) * xRatio;
    const y = (e.clientY - rect.top) * yRatio;
    const freq = xToFreq(x);
    const gain = yToGain(y);
    setEqBand(laneKey, effect.id, idx, { freq, gain });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = dragRef.current;
    if (idx == null) return;
    const target = e.target as Element;
    target.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const onDoubleClickNode = (idx: number) => () => {
    // Snap gain back to 0 dB on double-click — same affordance as the
    // sample editor sliders. Frequency is preserved.
    setEqBand(laneKey, effect.id, idx, { gain: 0 });
  };

  const accent = '#a855f7';
  const dimmed = effect.bypassed ? 0.5 : 1;

  return (
    <div
      className="rounded-xl select-none"
      style={{
        width: VIEW_W + 24,
        background: 'rgba(15, 12, 32, 0.92)',
        border: '1px solid rgba(168, 134, 255, 0.18)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        opacity: dimmed,
        transition: 'opacity 120ms linear',
      }}
    >
      {/* Header — also acts as the drag handle for the outer
          Reorder.Item when the parent supplies onHeaderPointerDown. */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{
          borderColor: 'rgba(255,255,255,0.05)',
          cursor: onHeaderPointerDown ? 'grab' : 'default',
          userSelect: 'none',
        }}
        onPointerDown={(e) => {
          // Only escalate to reorder if the press lands on the strip
          // itself, not on a button (bypass / close). Buttons have
          // their own onPointerDown that stop propagation.
          if (!onHeaderPointerDown) return;
          if (e.button !== 0) return;
          onHeaderPointerDown(e);
        }}
      >
        <span
          className="w-3 h-3 rotate-45"
          style={{
            background: 'linear-gradient(135deg, #c084fc 0%, #7c3aed 100%)',
            borderRadius: 2,
            boxShadow: `0 0 6px ${accent}`,
          }}
        />
        <span className="text-[12px] font-semibold text-white/90">Channel EQ</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleBypass(laneKey, effect.id); }}
          title={effect.bypassed ? 'Enable' : 'Bypass'}
          className="w-5 h-5 flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
          style={{ color: effect.bypassed ? 'rgba(255,255,255,0.45)' : accent }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
        </button>
        <span className="ml-auto" />
        {onClose && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close"
            className="w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Graph */}
      <div className="px-2 pt-2 pb-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          width={VIEW_W}
          height={VIEW_H}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ display: 'block', cursor: dragRef.current != null ? 'grabbing' : 'default' }}
        >
          <defs>
            <linearGradient id="eqFillGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0.32" />
              <stop offset="100%" stopColor={accent} stopOpacity="0.02" />
            </linearGradient>
            <radialGradient id="eqNodeGrad" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="#e9d5ff" />
              <stop offset="60%" stopColor={accent} />
              <stop offset="100%" stopColor="#6d28d9" />
            </radialGradient>
          </defs>

          {/* Faint vertical grid (octaves: 50, 100, 200, 500, 1k, 2k, 5k, 10k) */}
          {[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => (
            <line
              key={`vg-${f}`}
              x1={freqToX(f)}
              y1={PLOT_Y}
              x2={freqToX(f)}
              y2={PLOT_Y + PLOT_H}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth={1}
            />
          ))}
          {/* Faint horizontal grid (every 6 dB) */}
          {[-12, -6, 0, 6, 12].map((dB) => (
            <line
              key={`hg-${dB}`}
              x1={PLOT_X}
              y1={gainToY(dB)}
              x2={PLOT_X + PLOT_W}
              y2={gainToY(dB)}
              stroke={dB === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)'}
              strokeWidth={1}
            />
          ))}

          {/* Filled area beneath the curve */}
          <path d={fillPath} fill="url(#eqFillGrad)" />
          {/* Curve */}
          <path d={curvePath} fill="none" stroke={accent} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />

          {/* Draggable band nodes */}
          {bands.map((band, idx) => {
            const cx = freqToX(band.freq);
            const cy = gainToY(band.gain);
            return (
              <g key={idx}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={9}
                  fill="rgba(168,85,247,0.18)"
                  stroke="none"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={5.5}
                  fill="url(#eqNodeGrad)"
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1.2}
                  style={{ cursor: 'grab', filter: `drop-shadow(0 0 4px ${accent})` }}
                  onPointerDown={onPointerDown(idx)}
                  onDoubleClick={onDoubleClickNode(idx)}
                />
              </g>
            );
          })}
        </svg>
      </div>

      {/* Band readouts */}
      <div className="grid grid-cols-4 gap-2 px-3 pt-1 pb-3">
        {bands.map((band, idx) => (
          <div key={idx} className="flex flex-col items-center text-center">
            <span className="text-[9.5px] text-white/45 uppercase tracking-wider">{EQ_BAND_LABELS[idx]}</span>
            <span className="text-[12px] font-semibold text-white/90 tabular-nums mt-0.5">{formatFreq(band.freq)}</span>
            <span
              className="text-[11px] tabular-nums mt-1"
              style={{ color: band.gain === 0 ? 'rgba(255,255,255,0.5)' : (band.gain > 0 ? '#c4b5fd' : '#a78bfa') }}
            >
              {formatGain(band.gain)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
