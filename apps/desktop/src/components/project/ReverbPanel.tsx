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
const PANEL_W = 500;
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
            <ParticleRoom
              size={size} decay={decay} mix={mix}
              time={time} damping={damping} width={width}
              energy={energy}
            />
          </div>
          {/* Bottom knob row — Mix / Time / Damping. Each knob lives in
              an equal-width flex-1 slot so the longer labels (DAMPING)
              never bump the right divider regardless of label width. */}
          <div
            className="flex items-center px-6 pt-1 pb-2 border-t"
            style={{ borderColor: 'rgba(255,255,255,0.05)', flex: 1 }}
          >
            <div className="flex-1 flex justify-center min-w-0">
              <Knob
                compact
                label="Mix"
                valueLabel={formatPercent(mix)}
                value={mix} min={0} max={1}
                onChange={(v) => setReverbParam(laneKey, effect.id, 'mix', v)}
              />
            </div>
            <div className="flex-1 flex justify-center min-w-0">
              <Knob
                compact
                label="Time"
                valueLabel={formatSeconds(time)}
                value={time} min={0.1} max={10}
                onChange={(v) => setReverbParam(laneKey, effect.id, 'time', v)}
              />
            </div>
            <div className="flex-1 flex justify-center min-w-0">
              <Knob
                compact
                label="Damping"
                valueLabel={formatPercent(damping)}
                value={damping} min={0} max={1}
                onChange={(v) => setReverbParam(laneKey, effect.id, 'damping', v)}
              />
            </div>
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

// Canvas-based particle-dispersion visualizer. Each reverb param drives
// a different aspect of particle physics so the visualization reads as
// the room responding to the audio:
//
//   mix     → spawn density (more wet = more particles)
//   time    → particle lifetime (long time = particles linger)
//   damping → friction (high damping = particles slow & stop fast)
//   size    → initial vertical velocity + particle radius (room scale)
//   decay   → alpha-decay curve steepness (visual fade shape)
//   width   → horizontal velocity spread (stereo width)
//   energy  → spawn rate boost + transient burst trigger
//
// Implementation notes:
// - A single radial-gradient sprite is pre-rendered once and blitted
//   per-particle via drawImage with globalAlpha. Drawing ~hundreds of
//   gradients per frame would otherwise dominate frame time.
// - The frame is composited with a translucent black rect each tick
//   instead of a full clear, so trailing particles bleed into a soft
//   smoke trail. Also keeps the floor area readable when idle.
function ParticleRoom({
  size, decay, mix, time, damping, width, energy,
}: {
  size: number; decay: number; mix: number;
  time: number; damping: number; width: number;
  energy: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The RAF loop reads params via this ref so we don't have to
  // teardown/re-init on every slider tick. React updates the ref each
  // render; the loop reads the latest values next frame.
  const paramsRef = useRef({ size, decay, mix, time, damping, width, energy });
  paramsRef.current = { size, decay, mix, time, damping, width, energy };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(W * dpr));
    canvas.height = Math.max(1, Math.floor(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Pre-render a soft purple particle sprite once. Blitted per
    // particle per frame — much cheaper than recreating gradients.
    const SPRITE = 64;
    const sprite = document.createElement('canvas');
    sprite.width = SPRITE;
    sprite.height = SPRITE;
    const sctx = sprite.getContext('2d');
    if (sctx) {
      const g = sctx.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
      g.addColorStop(0, 'rgba(232, 213, 255, 1)');
      g.addColorStop(0.35, 'rgba(168, 85, 247, 0.55)');
      g.addColorStop(1, 'rgba(124, 58, 237, 0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, SPRITE, SPRITE);
    }

    interface Particle {
      x: number; y: number;
      vx: number; vy: number;
      life: number;       // 1 → 0
      lifetime: number;   // seconds
      r: number;          // base radius (px)
      hueJitter: number;  // small per-particle warmth offset
    }
    const particles: Particle[] = [];
    const MAX_PARTICLES = 600;

    let raf = 0;
    let prev = performance.now();
    let prevEnergy = 0;
    let spawnAccum = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const p = paramsRef.current;

      // Continuous spawn proportional to mix * energy. A transient
      // burst fires when energy spikes, regardless of mix, so a hit
      // always gets a visible response.
      const continuousRate = p.mix * p.energy * 220;
      const transient = Math.max(0, p.energy - prevEnergy - 0.04);
      const burstRate = transient * 1800;
      prevEnergy = p.energy;
      spawnAccum += (continuousRate + burstRate) * dt;
      let toSpawn = Math.floor(spawnAccum);
      spawnAccum -= toSpawn;
      if (particles.length + toSpawn > MAX_PARTICLES) {
        toSpawn = Math.max(0, MAX_PARTICLES - particles.length);
      }

      // Param → physics mapping.
      const lifetime = 0.45 + p.time * 1.6;          // seconds (Time)
      const horizSpread = 25 + p.width * 130;        // px/s   (Width)
      const vertVel = 60 + p.size * 140 + p.energy * 80;  // px/s (Size + impulse)
      const baseR = 0.9 + p.size * 1.3 + p.mix * 0.4;     // px   (Size + Mix)
      const fric = Math.exp(-p.damping * 3.5 * dt);  // friction (Damping)
      const decayPow = 1 + p.decay * 3.2;            // alpha-curve (Decay)

      // Spawn particles from the iso-cube's base diamond so they
      // emerge "from inside the room" instead of from the canvas floor.
      // Match RoomLayer's baseY ratio (0.74 of viewport height).
      const baseY = H * 0.74;
      for (let i = 0; i < toSpawn; i++) {
        const sx = W * 0.5 + (Math.random() - 0.5) * W * 0.45;
        const sy = baseY + 4;
        const angleSpread = (Math.random() - 0.5) * 1.6;  // -0.8..0.8 rad
        // Combine angled emission with the width-controlled horizontal
        // spread so width visibly changes the dispersion cone.
        const speed = vertVel * (0.55 + Math.random() * 0.85);
        particles.push({
          x: sx,
          y: sy,
          vx: Math.sin(angleSpread) * horizSpread + (Math.random() - 0.5) * horizSpread * 0.6,
          vy: -Math.cos(angleSpread) * speed,
          life: 1,
          lifetime,
          r: baseR * (0.55 + Math.random() * 1.0),
          hueJitter: Math.random() * 0.18 - 0.09,
        });
      }

      // Trail: fade the previous frame instead of clearing fully so
      // particles paint a soft smoke wake behind them.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(11, 8, 24, 0.28)';
      ctx.fillRect(0, 0, W, H);

      // Faint floor reference — a horizontal gradient line so the room
      // reads as a "stage" the particles rise off of.
      const floor = ctx.createLinearGradient(0, 0, W, 0);
      floor.addColorStop(0, 'rgba(168, 85, 247, 0)');
      floor.addColorStop(0.5, `rgba(168, 85, 247, ${0.22 + p.mix * 0.18 + p.energy * 0.20})`);
      floor.addColorStop(1, 'rgba(168, 85, 247, 0)');
      ctx.fillStyle = floor;
      ctx.fillRect(0, H * 0.92, W, 0.8);

      ctx.globalCompositeOperation = 'lighter';

      for (let i = particles.length - 1; i >= 0; i--) {
        const part = particles[i];
        // Apply friction. High damping kills velocity quickly and
        // particles "stick" — feels like wool absorbing the room.
        part.vx *= fric;
        part.vy *= fric;
        part.x += part.vx * dt;
        part.y += part.vy * dt;
        part.life -= dt / part.lifetime;

        if (part.life <= 0 || part.y < -8 || part.x < -16 || part.x > W + 16) {
          particles.splice(i, 1);
          continue;
        }

        const alpha = Math.pow(Math.max(0, part.life), decayPow);
        const rPx = part.r * (0.7 + alpha * 0.7);
        ctx.globalAlpha = alpha * 0.95;
        const dest = rPx * 4;
        ctx.drawImage(sprite, part.x - dest / 2, part.y - dest / 2, dest, dest);
      }
      ctx.globalAlpha = 1;

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative shrink-0 grow" style={{ height: 130 }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          borderRadius: 6,
          background: 'linear-gradient(180deg, rgba(20,14,42,1) 0%, rgba(11,8,24,1) 100%)',
        }}
      />
      {/* Iso-cube overlay sits on top of the canvas — wireframe room
          containing the particles. Both react to the same params +
          energy so the cube breathes while the particles disperse. */}
      <div className="absolute inset-0 pointer-events-none">
        <IsoRoom size={size} decay={decay} mix={mix} energy={energy} />
      </div>
    </div>
  );
}

// 3D isometric step-pyramid overlay. 5 floating diamonds — the bottom
// 3 solid, the top 2 dashed wireframe — connected by perspective
// struts. Layers pulse + the wireframe ceiling expands outward with
// audio energy so the room "breathes" with the reverb tail.
function IsoRoom({ size, decay, mix, energy }: { size: number; decay: number; mix: number; energy: number }) {
  const VIEW_W = 380;
  const VIEW_H = 140;
  const cx = VIEW_W / 2;
  const baseY = VIEW_H * 0.74;

  const layers = useMemo(() => {
    const n = 5;
    const out: Array<{ halfW: number; halfH: number; y: number; fillOpacity: number; strokeOpacity: number; wireframe: boolean }> = [];
    const baseHalfW = 50 + size * 90;
    const baseHalfH = 14 + size * 16;
    const vertSpacing = 12 + decay * 18;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const halfW = baseHalfW * (1 - t * 0.78);
      const halfH = baseHalfH * (1 - t * 0.78);
      const y = baseY - i * vertSpacing;
      const wireframe = i >= 3;
      const fillOpacity = wireframe ? 0 : (0.25 + (1 - t) * 0.35);
      const strokeOpacity = wireframe ? 0.22 + (1 - t) * 0.18 : 0.45 + (1 - t) * 0.20;
      out.push({ halfW, halfH, y, fillOpacity, strokeOpacity, wireframe });
    }
    return out;
  }, [size, decay]);

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
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

      <motion.ellipse
        cx={cx} cy={baseY + 8}
        rx={(layers[0]?.halfW ?? 80) * 1.5}
        ry={20}
        fill="url(#roomGlowGrad)"
        animate={{ opacity: 0.5 * mix + 0.18 + energy * 0.55, scale: 1 + energy * 0.18 }}
        transition={{ type: 'tween', duration: 0.08, ease: 'linear' }}
        style={{ originX: '50%', originY: '100%' }}
      />

      {layers[0] && (
        <motion.path
          d={`M ${cx - layers[0].halfW} ${baseY} L ${cx} ${baseY - layers[0].halfH} L ${cx + layers[0].halfW} ${baseY} L ${cx} ${baseY + layers[0].halfH} Z`}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.2}
          animate={{ opacity: energy * 0.55, scale: 1 + energy * 0.45 }}
          transition={{ type: 'tween', duration: 0.1, ease: 'easeOut' }}
          style={{ originX: `${cx}px`, originY: `${baseY}px`, transformBox: 'fill-box' as any }}
        />
      )}

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
          <line key={`strut-${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            stroke="rgba(168, 134, 255, 0.16)" strokeWidth={0.6} strokeDasharray="2 3" />
        ));
      })()}

      {layers.map((layer, i) => {
        const fillTop = layer.wireframe ? 'transparent' : 'url(#roomTopGrad)';
        const fillLeft = layer.wireframe ? 'transparent' : 'url(#roomLeftGrad)';
        const fillRight = layer.wireframe ? 'transparent' : 'url(#roomRightGrad)';
        const stroke = layer.wireframe
          ? `rgba(168, 134, 255, ${layer.strokeOpacity})`
          : `rgba(232, 213, 255, ${layer.strokeOpacity})`;
        const dash = layer.wireframe ? '2 3' : undefined;
        const t = i / Math.max(1, layers.length - 1);
        const baseOpacity = (layer.wireframe ? 1 : layer.fillOpacity / 0.6) * (0.35 + 0.65 * mix);
        const energyBoost = layer.wireframe ? energy * 0.55 : energy * 0.30;
        const scale = 1 + (layer.wireframe ? energy * 0.22 * (0.6 + t) : energy * 0.06);
        return (
          <motion.g
            key={`layer-${i}`}
            animate={{ opacity: Math.min(1, baseOpacity + energyBoost), scale }}
            transition={{ type: 'spring', stiffness: 220, damping: 20, mass: 0.6 }}
            style={{ originX: `${cx}px`, originY: `${layer.y}px`, transformBox: 'fill-box' as any }}
          >
            <PerspectivePlane
              cx={cx} y={layer.y} halfW={layer.halfW} halfH={layer.halfH}
              fillTop={fillTop} fillLeft={fillLeft} fillRight={fillRight}
              stroke={stroke} strokeDasharray={dash}
              showSides={!layer.wireframe && i > 0}
              sideHeight={i === layers.length - 1 ? 0 : (layers[i + 1]?.y ?? layer.y) - layer.y}
            />
          </motion.g>
        );
      })}
    </svg>
  );
}

// One iso box top + optional left + right side faces.
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
  const topPath = `M ${cx - halfW} ${y} L ${cx} ${y - halfH} L ${cx + halfW} ${y} L ${cx} ${y + halfH} Z`;
  const leftPath = showSides && sideHeight > 0
    ? `M ${cx - halfW} ${y} L ${cx} ${y + halfH} L ${cx} ${y + halfH + sideHeight} L ${cx - halfW} ${y + sideHeight} Z`
    : '';
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
      {!large && <span className="text-[9.5px] uppercase text-white/55 leading-none mb-[3px]" style={{ letterSpacing: '0.03em' }}>{label}</span>}
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
