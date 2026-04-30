import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  defaultParams,
  useEffectsStore,
  type Effect,
  type ReverbParams,
} from '../../stores/effectsStore';
import { getLaneReverbAnalyser } from '../../stores/audio/trackReverb';

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
// Sized to match ChannelEqPanel + CompressorPanel so all three plugins
// align in the chain rail. Width tuned so the iso-stack visualization
// reads with the same room-y proportion as the reference image.
const PANEL_W = 460;
const PANEL_H = 252;

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

  // Audio-reactive energy (0..1). Read RMS of the lane's pre-reverb
  // signal off the shared analyser, smooth it lightly, and pass it
  // down so the visualizer's motion components animate to the room
  // amplitude. Decays gracefully when audio stops so the dashed
  // wireframe "tail" eases back to rest instead of snapping.
  const [energy, setEnergy] = useState(0);
  useEffect(() => {
    if (effect.bypassed) { setEnergy(0); return; }
    const buf = new Uint8Array(512);
    let raf = 0;
    let smoothed = 0;
    const loop = () => {
      const an = getLaneReverbAnalyser(laneKey);
      let rms = 0;
      if (an) {
        an.getByteTimeDomainData(buf as unknown as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / buf.length);
      }
      // Asymmetric smoothing — fast attack, slow release so the room
      // animation has perceptible "tail" between hits.
      const a = rms > smoothed ? 0.45 : 0.08;
      smoothed = smoothed * (1 - a) + rms * a;
      setEnergy(Math.min(1, smoothed * 2.5));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [laneKey, effect.bypassed]);

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

      {/* Main area split horizontally: left column stacks the iso
          visualizer + the Mix/Time/Damping knob row; right column
          stacks Size + Decay + Width so they read as a single
          dedicated "room" parameter strip. Total height is the
          panel minus the header. */}
      <div className="flex" style={{ height: PANEL_H - 36 }}>
        {/* Left column */}
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex px-1 pt-2 pb-1" style={{ height: 130 }}>
            <RoomVisualizer size={size} decay={decay} mix={mix} energy={energy} />
          </div>
          {/* Bottom knob row — Mix / Time / Damping. */}
          <div
            className="flex items-center justify-around px-3 pt-1 pb-2 border-t"
            style={{ borderColor: 'rgba(255,255,255,0.05)', flex: 1 }}
          >
            <Knob
              label="Mix"
              valueLabel={formatPercent(mix)}
              value={mix} min={0} max={1}
              onChange={(v) => setReverbParam(laneKey, effect.id, 'mix', v)}
            />
            <Knob
              label="Time"
              valueLabel={formatSeconds(time)}
              value={time} min={0.1} max={10}
              onChange={(v) => setReverbParam(laneKey, effect.id, 'time', v)}
            />
            <Knob
              label="Damping"
              valueLabel={formatPercent(damping)}
              value={damping} min={0} max={1}
              onChange={(v) => setReverbParam(laneKey, effect.id, 'damping', v)}
            />
          </div>
        </div>

        {/* Right column — Size / Decay / Width vertically stacked.
            justify-center + gap-3 puts even space between each knob
            group so the label/knob/value triplets read as cohesive
            units instead of bleeding into each other. */}
        <div
          className="flex flex-col items-center justify-center gap-3 shrink-0 px-2 py-2 border-l"
          style={{ width: 70, borderColor: 'rgba(255,255,255,0.05)' }}
        >
          <Knob
            compact
            label="Size"
            valueLabel={formatPercent(size)}
            value={size} min={0} max={1}
            onChange={(v) => setReverbParam(laneKey, effect.id, 'size', v)}
          />
          <Knob
            compact
            label="Decay"
            valueLabel={formatPercent(decay)}
            value={decay} min={0} max={1}
            onChange={(v) => setReverbParam(laneKey, effect.id, 'decay', v)}
          />
          <Knob
            compact
            label="Width"
            valueLabel={formatPercent(width)}
            value={width} min={0} max={1}
            onChange={(v) => setReverbParam(laneKey, effect.id, 'width', v)}
          />
        </div>
      </div>
    </div>
  );
}

// 3D isometric step-pyramid visualization. Each layer is a parallelogram
// scaled by `size`. The whole stack opacity scales with `mix` so a dry
// reverb fades back into the floor. Framer Motion animates layer
// transitions when params change.
function RoomVisualizer({ size, decay, mix, energy }: { size: number; decay: number; mix: number; energy: number }) {
  // Wider viewBox so the SVG fills the body-row width without
  // preserveAspectRatio="meet" creating big letterbox bars on the
  // sides. cx auto-recenters, so layer geometry stays correct.
  const VIEW_W = 380;
  const VIEW_H = 140;
  const cx = VIEW_W / 2;
  // Base diamond is centred so its bottom edge stays inside the
  // viewBox at every size. baseY plus the largest possible halfH
  // (set below) leaves a small floor margin for the ambient glow.
  const baseY = VIEW_H * 0.74;

  // Five floating layers — the bottom three form the main "room"
  // step-pyramid; the top two render as faint dashed wireframes that
  // suggest the open ceiling space, matching the reference image.
  const layers = useMemo(() => {
    const n = 5;
    const out: Array<{ halfW: number; halfH: number; y: number; fillOpacity: number; strokeOpacity: number; wireframe: boolean }> = [];
    // Bigger base + wider vertical spread so the pyramid fills the
    // viewport instead of bunching at the floor. halfH is bounded
    // independently of halfW so the base diamond never overshoots
    // the SVG floor at maximum size.
    const baseHalfW = 50 + size * 90;        // 50..140
    const baseHalfH = 14 + size * 16;        // 14..30 — flat enough that
                                             // baseY + halfH stays in view
    const vertSpacing = 12 + decay * 18;     // 12..30
    // Layer 0 = base (largest, brightest); layers grow smaller and
    // climb upward.
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);                 // 0..1 from base to top
      const halfW = baseHalfW * (1 - t * 0.78);
      const halfH = baseHalfH * (1 - t * 0.78);
      const y = baseY - i * vertSpacing;
      const wireframe = i >= 3;              // top two layers
      const fillOpacity = wireframe ? 0 : (0.25 + (1 - t) * 0.35);
      const strokeOpacity = wireframe ? 0.22 + (1 - t) * 0.18 : 0.45 + (1 - t) * 0.20;
      out.push({ halfW, halfH, y, fillOpacity, strokeOpacity, wireframe });
    }
    return out;
  }, [size, decay]);

  const dBLabels = ['+20', '+10', '0', '-10', '-20', '-30'];
  const msLabels = ['0', '10', '20', '30'];

  return (
    <div className="relative shrink-0 grow" style={{ height: VIEW_H }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height={VIEW_H} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="roomTopGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d8b4fe" stopOpacity="0.95" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="roomLeftGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.55" />
            <stop offset="100%" stopColor="#4c1d95" stopOpacity="0.30" />
          </linearGradient>
          <linearGradient id="roomRightGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#4c1d95" stopOpacity="0.28" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.18" />
          </linearGradient>
          <radialGradient id="roomGlowGrad" cx="0.5" cy="1" r="0.7">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.50" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Soft ambient floor glow under the base — pulses with the
            input energy so loud hits brighten the floor. */}
        <motion.ellipse
          cx={cx} cy={baseY + 8}
          rx={(layers[0]?.halfW ?? 80) * 1.5}
          ry={20}
          fill="url(#roomGlowGrad)"
          animate={{
            opacity: 0.5 * mix + 0.18 + energy * 0.55,
            scale: 1 + energy * 0.18,
          }}
          transition={{ type: 'tween', duration: 0.08, ease: 'linear' }}
          style={{ originX: '50%', originY: '100%' }}
        />

        {/* Energy ring — emanates outward from the base on loud
            transients. Modeled as a flat iso-diamond outline whose
            scale + opacity tracks energy. Sits BEHIND the layers so
            it reads as light spilling out of the room. */}
        {layers[0] && (
          <motion.path
            d={`M ${cx - layers[0].halfW} ${baseY} L ${cx} ${baseY - layers[0].halfH} L ${cx + layers[0].halfW} ${baseY} L ${cx} ${baseY + layers[0].halfH} Z`}
            fill="none"
            stroke={ACCENT}
            strokeWidth={1.2}
            animate={{
              opacity: energy * 0.55,
              scale: 1 + energy * 0.45,
            }}
            transition={{ type: 'tween', duration: 0.1, ease: 'easeOut' }}
            style={{ originX: `${cx}px`, originY: `${baseY}px`, transformBox: 'fill-box' as any }}
          />
        )}

        {/* Vertical perspective struts from the top wireframe down to
            the base — connect the four iso corners through every
            layer to read as a transparent box. */}
        {(() => {
          const top = layers[layers.length - 1];
          const bot = layers[0];
          if (!top || !bot) return null;
          const struts = [
            { x1: cx - top.halfW, y1: top.y, x2: cx - bot.halfW, y2: bot.y },
            { x1: cx + top.halfW, y1: top.y, x2: cx + bot.halfW, y2: bot.y },
            { x1: cx, y1: top.y - top.halfH, x2: cx, y2: bot.y - bot.halfH },
            { x1: cx, y1: top.y + top.halfH, x2: cx, y2: bot.y + bot.halfH },
          ];
          return struts.map((s, i) => (
            <line
              key={`strut-${i}`}
              x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
              stroke="rgba(168, 134, 255, 0.16)"
              strokeWidth={0.6}
              strokeDasharray="2 3"
            />
          ));
        })()}

        {/* Stacked layers, base → top. <motion.g> animates layer
            transitions when params change AND tracks input energy:
            solid layers brighten on hits, the dashed wireframe
            layers expand outward to sell the "ceiling rises with
            the tail" feel. Higher layers move more (multiplied by
            t) so the top of the room breathes the most. */}
        {layers.map((layer, i) => {
          const fillTop = layer.wireframe ? 'transparent' : 'url(#roomTopGrad)';
          const fillLeft = layer.wireframe ? 'transparent' : 'url(#roomLeftGrad)';
          const fillRight = layer.wireframe ? 'transparent' : 'url(#roomRightGrad)';
          const stroke = layer.wireframe
            ? `rgba(168, 134, 255, ${layer.strokeOpacity})`
            : `rgba(232, 213, 255, ${layer.strokeOpacity})`;
          const dash = layer.wireframe ? '2 3' : undefined;
          const t = i / Math.max(1, layers.length - 1);
          // Solid layers: subtle brighten on hit. Wireframe layers:
          // expand outward + brighten — they read as the reverb tail.
          const baseOpacity = (layer.wireframe ? 1 : layer.fillOpacity / 0.6) * (0.35 + 0.65 * mix);
          const energyBoost = layer.wireframe ? energy * 0.55 : energy * 0.30;
          const scale = 1 + (layer.wireframe ? energy * 0.22 * (0.6 + t) : energy * 0.06);
          return (
            <motion.g
              key={`layer-${i}`}
              animate={{
                opacity: Math.min(1, baseOpacity + energyBoost),
                scale,
              }}
              transition={{ type: 'spring', stiffness: 220, damping: 20, mass: 0.6 }}
              style={{ originX: `${cx}px`, originY: `${layer.y}px`, transformBox: 'fill-box' as any }}
            >
              <PerspectivePlane
                cx={cx}
                y={layer.y}
                halfW={layer.halfW}
                halfH={layer.halfH}
                fillTop={fillTop}
                fillLeft={fillLeft}
                fillRight={fillRight}
                stroke={stroke}
                strokeDasharray={dash}
                showSides={!layer.wireframe && i > 0}
                sideHeight={i === layers.length - 1 ? 0 : (layers[i + 1]?.y ?? layer.y) - layer.y}
              />
            </motion.g>
          );
        })}

        {/* Y-axis labels — left = dB scale. Tucked in close to the
            graph (cx) with a small margin off the SVG's left edge,
            so the numbers read alongside the layer stack instead of
            hugging the panel edge. */}
        {dBLabels.map((label, i) => {
          const topY = 22;
          const bottomY = baseY + 6;
          const y = topY + (i / (dBLabels.length - 1)) * (bottomY - topY);
          return (
            <text key={`db-${i}`} x={70} y={y} fill="rgba(255,255,255,0.42)" fontSize={7.5} fontFamily="monospace" textAnchor="end">{label}</text>
          );
        })}
        {/* Y-axis labels — right = ms scale. Mirrors the dB column;
            sits ~70 px from the right edge of the SVG. */}
        {msLabels.map((label, i) => {
          const topY = 28;
          const bottomY = baseY + 6;
          const y = topY + (i / (msLabels.length - 1)) * (bottomY - topY);
          return (
            <text key={`ms-${i}`} x={VIEW_W - 70} y={y} fill="rgba(255,255,255,0.42)" fontSize={7.5} fontFamily="monospace" textAnchor="start">{label}</text>
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
  strokeDasharray,
  showSides = false, sideHeight = 0,
}: {
  cx: number; y: number; halfW: number; halfH: number;
  fillTop: string; fillLeft: string; fillRight: string; stroke: string;
  strokeDasharray?: string;
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
      {leftPath && <path d={leftPath} fill={fillLeft} stroke={stroke} strokeWidth={0.5} strokeDasharray={strokeDasharray} />}
      {rightPath && <path d={rightPath} fill={fillRight} stroke={stroke} strokeWidth={0.5} strokeDasharray={strokeDasharray} />}
      <path d={topPath} fill={fillTop} stroke={stroke} strokeWidth={0.8} strokeDasharray={strokeDasharray} />
    </g>
  );
}

// Round purple knob — drag vertically to change. Same visual idiom as
// CompressorPanel's knob; copied here so the reverb panel can size
// independently (the reverb knobs are bigger).
function Knob({ label, valueLabel, value, min, max, onChange, large = false, compact = false }: {
  label: string;
  valueLabel: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  large?: boolean;
  compact?: boolean;
}) {
  const dragStartRef = useRef<{ y: number; v: number } | null>(null);
  const SIZE = large ? 56 : compact ? 36 : 44;
  const RADIUS = large ? 24 : compact ? 14 : 19;

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

  // Tight internal stacking: label sits 2 px above the knob; value
  // sits 4 px below it. The parent column controls the gap BETWEEN
  // knobs so each knob reads as a cohesive label/knob/value group
  // instead of three values floating between groups.
  return (
    <div className="flex flex-col items-center select-none">
      {!large && <span className="text-[9.5px] uppercase tracking-wider text-white/55 leading-none mb-[3px]">{label}</span>}
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
      <span className="text-[11.5px] font-semibold tabular-nums text-white/90 leading-none mt-1">{valueLabel}</span>
      {large && <span className="text-[9px] uppercase tracking-wider text-white/45 leading-none mt-[2px]">{label}</span>}
    </div>
  );
}
