import { useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  defaultParams,
  useEffectsStore,
  type Effect,
  type ReverbParams,
} from '../../stores/effectsStore';

// Reverb panel — visual + DSP. Matches the user-supplied reference:
//
//   ┌──────────────────────────────────────────────┐
//   │ ⊘  Reverb                              [×]   │
//   ├──────────────────────────────────────────────┤
//   │ ┌────────────────────────────┐ ┌─────────┐   │
//   │ │ +20 ▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸▸ 0 ms  │ │  Size   │   │
//   │ │ +10  ┌────┐                │ │ (knob)  │   │
//   │ │  0   │ ▰▰ │  10 ms         │ │   60%   │   │
//   │ │ -10  │▰▰▰▰│                │ │  Decay  │   │
//   │ │ -20  │▰▰▰▰▰▰│  20 ms       │ │ (knob)  │   │
//   │ │ -30  │ ▰▰▰▰▰▰▰▰ │  30 ms   │ │   40%   │   │
//   │ └────────────────────────────┘ └─────────┘   │
//   ├──────────────────────────────────────────────┤
//   │  ◯       ◯       ◯       ◯                   │
//   │ 60%    2.50 s    40%    35%                  │
//   │ MIX    TIME      DAMP   WIDTH                │
//   └──────────────────────────────────────────────┘
//
// The 3D iso-cube stack is rendered with Framer Motion-animated SVG
// parallelograms — each layer scales with `size`, opacity ties to
// `mix`, and `decay` shifts the stack's total height.

const ACCENT = '#a855f7';
const PANEL_W = 520;
const PANEL_H = 400;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}
function formatSeconds(v: number): string {
  return `${v.toFixed(2)} s`;
}

export default function ReverbPanel({
  laneKey,
  effect,
  onClose,
  onHeaderPointerDown,
}: {
  laneKey: string;
  effect: Effect;
  onClose?: () => void;
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
}) {
  const setReverbParam = useEffectsStore((s) => s.setReverbParam);
  const toggleBypass = useEffectsStore((s) => s.toggleBypass);

  const params: ReverbParams = useMemo(() => {
    if (effect.params && 'mix' in effect.params) return effect.params as ReverbParams;
    return defaultParams('reverb') as ReverbParams;
  }, [effect.params]);

  const { size, decay, mix, time, damping, width } = params;
  const dimmed = effect.bypassed ? 0.5 : 1;

  return (
    <div
      className="rounded-xl select-none"
      style={{
        width: PANEL_W,
        height: PANEL_H,
        background: 'rgba(15, 12, 32, 0.92)',
        border: '1px solid rgba(168, 134, 255, 0.18)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        opacity: dimmed,
        transition: 'opacity 120ms linear',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.05)', userSelect: 'none' }}
      >
        {onHeaderPointerDown && (
          <button
            type="button"
            aria-label="Drag to reorder"
            title="Drag to reorder"
            className="shrink-0 -ml-1 flex items-center justify-center w-5 h-5 rounded text-white/40 hover:text-white/85 transition-colors"
            style={{ cursor: 'grab', touchAction: 'none' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onHeaderPointerDown(e);
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="5" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="9" cy="19" r="1.6" />
              <circle cx="15" cy="5" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="15" cy="19" r="1.6" />
            </svg>
          </button>
        )}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleBypass(laneKey, effect.id); }}
          title={effect.bypassed ? 'Enable' : 'Bypass'}
          className="w-5 h-5 flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
          style={{ color: effect.bypassed ? 'rgba(255,255,255,0.45)' : ACCENT }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
        </button>
        <span className="text-[14px] font-semibold text-white/90 ml-1">Reverb</span>
        <span className="ml-auto" />
        {onClose && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close"
            className="w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Main row: visualization + Size/Decay column */}
      <div className="flex gap-3 px-4 pt-3 pb-2" style={{ height: 240 }}>
        <RoomVisualizer size={size} decay={decay} mix={mix} />
        <div className="flex flex-col items-center gap-3 shrink-0 pl-2 border-l" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          <Knob
            label="Size"
            valueLabel={formatPercent(size)}
            value={size} min={0} max={1}
            onChange={(v) => setReverbParam(laneKey, effect.id, 'size', v)}
          />
          <Knob
            label="Decay"
            valueLabel={formatPercent(decay)}
            value={decay} min={0} max={1}
            onChange={(v) => setReverbParam(laneKey, effect.id, 'decay', v)}
          />
        </div>
      </div>

      {/* Bottom knob row */}
      <div className="flex items-center justify-around px-4 pt-2 pb-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <Knob
          label="Mix"
          valueLabel={formatPercent(mix)}
          value={mix} min={0} max={1}
          onChange={(v) => setReverbParam(laneKey, effect.id, 'mix', v)}
          large
        />
        <Knob
          label="Time"
          valueLabel={formatSeconds(time)}
          value={time} min={0.1} max={10}
          onChange={(v) => setReverbParam(laneKey, effect.id, 'time', v)}
          large
        />
        <Knob
          label="Damping"
          valueLabel={formatPercent(damping)}
          value={damping} min={0} max={1}
          onChange={(v) => setReverbParam(laneKey, effect.id, 'damping', v)}
          large
        />
        <Knob
          label="Width"
          valueLabel={formatPercent(width)}
          value={width} min={0} max={1}
          onChange={(v) => setReverbParam(laneKey, effect.id, 'width', v)}
          large
        />
      </div>
    </div>
  );
}

// 3D isometric step-pyramid visualization. Each layer is a parallelogram
// scaled by `size`. The whole stack opacity scales with `mix` so a dry
// reverb fades back into the floor. Framer Motion animates layer
// transitions when params change.
function RoomVisualizer({ size, decay, mix }: { size: number; decay: number; mix: number }) {
  const VIEW_W = 280;
  const VIEW_H = 220;
  const cx = VIEW_W / 2;
  const baseY = VIEW_H * 0.78;
  // Number of layers and base half-widths. Bigger size pushes the
  // base layer outward; decay raises the whole stack.
  const layers = useMemo(() => {
    const n = 4;
    const out: Array<{ halfW: number; halfH: number; y: number; opacity: number }> = [];
    const baseHalfW = 40 + size * 80;        // 40..120
    const baseHalfH = baseHalfW * 0.4;
    const vertSpacing = 14 + decay * 16;     // 14..30
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const halfW = baseHalfW * (1 - t * 0.65);
      const halfH = baseHalfH * (1 - t * 0.65);
      const y = baseY - i * vertSpacing;
      out.push({ halfW, halfH, y, opacity: 0.18 + (1 - t) * 0.45 });
    }
    return out;
  }, [size, decay]);

  // dB scale on left (visual only), ms scale on right.
  const dBLabels = ['+20', '+10', '0', '-10', '-20', '-30'];
  const msLabels = ['0', '10', '20', '30'];

  return (
    <div className="relative shrink-0" style={{ width: VIEW_W, height: VIEW_H }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width={VIEW_W} height={VIEW_H} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="roomTopGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c084fc" stopOpacity="0.85" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="roomLeftGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.45" />
            <stop offset="100%" stopColor="#581c87" stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id="roomRightGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#581c87" stopOpacity="0.30" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.20" />
          </linearGradient>
          <linearGradient id="roomGlowGrad" cx="0.5" cy="1" r="0.7">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.30" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Faint ambient floor glow */}
        <ellipse cx={cx} cy={baseY + 8} rx={150} ry={20} fill="url(#roomGlowGrad)" opacity={0.6 * mix + 0.2} />

        {/* Floor plane outline (the largest base) — drawn slightly
            transparent regardless of layer count so the room reads
            as sitting on a floor. */}
        <PerspectivePlane cx={cx} y={baseY + 6} halfW={layers[0]?.halfW ?? 80} halfH={(layers[0]?.halfH ?? 30) * 1.05} fillTop="rgba(168,85,247,0.10)" fillLeft="transparent" fillRight="transparent" stroke="rgba(168,134,255,0.20)" />

        {/* Stacked iso boxes from bottom up. We use Framer Motion's
            <motion.g> so size + decay changes animate smoothly. */}
        {layers.map((layer, i) => (
          <motion.g
            key={`layer-${i}`}
            animate={{ opacity: layer.opacity * (0.3 + 0.7 * mix) }}
            transition={{ type: 'spring', stiffness: 180, damping: 22 }}
          >
            <PerspectivePlane
              cx={cx}
              y={layer.y}
              halfW={layer.halfW}
              halfH={layer.halfH}
              fillTop="url(#roomTopGrad)"
              fillLeft="url(#roomLeftGrad)"
              fillRight="url(#roomRightGrad)"
              stroke="rgba(232,213,255,0.30)"
              showSides={i > 0}
              sideHeight={i === layers.length - 1 ? 0 : (layers[i + 1]?.y ?? layer.y) - layer.y}
            />
          </motion.g>
        ))}

        {/* Y-axis labels (left = dB) */}
        {dBLabels.map((label, i) => {
          const y = 28 + (i / (dBLabels.length - 1)) * (VIEW_H - 60);
          return (
            <text key={`db-${i}`} x={4} y={y} fill="rgba(255,255,255,0.40)" fontSize={9} fontFamily="monospace">{label}</text>
          );
        })}
        {/* Y-axis labels (right = ms) */}
        {msLabels.map((label, i) => {
          const y = 32 + (i / (msLabels.length - 1)) * (VIEW_H - 70);
          return (
            <text key={`ms-${i}`} x={VIEW_W - 22} y={y} fill="rgba(255,255,255,0.40)" fontSize={9} fontFamily="monospace">{label}</text>
          );
        })}
      </svg>
    </div>
  );
}

// One iso box top + optional left + right side faces. `sideHeight`
// controls how much of the side is visible (between layers).
function PerspectivePlane({
  cx, y, halfW, halfH,
  fillTop, fillLeft, fillRight, stroke,
  showSides = false, sideHeight = 0,
}: {
  cx: number; y: number; halfW: number; halfH: number;
  fillTop: string; fillLeft: string; fillRight: string; stroke: string;
  showSides?: boolean; sideHeight?: number;
}) {
  // Iso top face — diamond shape
  const topPath = `M ${cx - halfW} ${y} L ${cx} ${y - halfH} L ${cx + halfW} ${y} L ${cx} ${y + halfH} Z`;
  // Left side face (drops down from the bottom-left edge by sideHeight)
  const leftPath = showSides && sideHeight > 0
    ? `M ${cx - halfW} ${y} L ${cx} ${y + halfH} L ${cx} ${y + halfH + sideHeight} L ${cx - halfW} ${y + sideHeight} Z`
    : '';
  // Right side face
  const rightPath = showSides && sideHeight > 0
    ? `M ${cx + halfW} ${y} L ${cx} ${y + halfH} L ${cx} ${y + halfH + sideHeight} L ${cx + halfW} ${y + sideHeight} Z`
    : '';
  return (
    <g>
      {leftPath && <path d={leftPath} fill={fillLeft} stroke={stroke} strokeWidth={0.5} />}
      {rightPath && <path d={rightPath} fill={fillRight} stroke={stroke} strokeWidth={0.5} />}
      <path d={topPath} fill={fillTop} stroke={stroke} strokeWidth={0.8} />
    </g>
  );
}

// Round purple knob — drag vertically to change. Same visual idiom as
// CompressorPanel's knob; copied here so the reverb panel can size
// independently (the reverb knobs are bigger).
function Knob({ label, valueLabel, value, min, max, onChange, large = false }: {
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  large?: boolean;
}) {
  const dragStartRef = useRef<{ y: number; v: number } | null>(null);
  const SIZE = large ? 56 : 44;
  const RADIUS = large ? 24 : 19;

  const t = clamp((value - min) / (max - min), 0, 1);
  const startAngle = -135;
  const endAngle = 135;
  const angle = startAngle + t * (endAngle - startAngle);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragStartRef.current = { y: e.clientY, v: value };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const dy = dragStartRef.current.y - e.clientY;
    const SENS = 0.005;
    const range = max - min;
    onChange(clamp(dragStartRef.current.v + dy * range * SENS, min, max));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragStartRef.current = null;
  };

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const toXY = (a: number) => {
    const r = (a - 90) * (Math.PI / 180);
    return [cx + RADIUS * Math.cos(r), cy + RADIUS * Math.sin(r)];
  };
  const [sx, sy] = toXY(startAngle);
  const [ex, ey] = toXY(angle);
  const [tx, ty] = toXY(endAngle);
  const largeArcBg = endAngle - startAngle > 180 ? 1 : 0;
  const largeArcFg = angle - startAngle > 180 ? 1 : 0;
  const arcBg = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArcBg} 1 ${tx.toFixed(2)} ${ty.toFixed(2)}`;
  const arcFg = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${RADIUS} ${RADIUS} 0 ${largeArcFg} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;

  const [tickX, tickY] = toXY(angle);
  const tickInner = (() => {
    const r = (angle - 90) * (Math.PI / 180);
    return [cx + (RADIUS - 9) * Math.cos(r), cy + (RADIUS - 9) * Math.sin(r)];
  })();

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      {!large && <span className="text-[9.5px] uppercase tracking-wider text-white/55">{label}</span>}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          width: SIZE,
          height: SIZE,
          cursor: 'ns-resize',
          touchAction: 'none',
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 35%, #2c1f54 0%, #14102b 80%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -2px 4px rgba(0,0,0,0.35), 0 0 12px rgba(168,85,247,0.20)',
          border: '1px solid rgba(168, 134, 255, 0.22)',
        }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ display: 'block' }}>
          <path d={arcBg} stroke="rgba(255,255,255,0.08)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
          <path d={arcFg} stroke={ACCENT} strokeWidth={2.5} fill="none" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${ACCENT})` }} />
          <line x1={tickInner[0]} y1={tickInner[1]} x2={tickX} y2={tickY} stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
        </svg>
      </div>
      <span className="text-[12px] font-semibold tabular-nums text-white/90 leading-none mt-0.5">{valueLabel}</span>
      {large && <span className="text-[9px] uppercase tracking-wider text-white/45 leading-none">{label}</span>}
    </div>
  );
}
