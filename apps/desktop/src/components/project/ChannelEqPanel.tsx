import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  EQ_BAND_LABELS,
  defaultParams,
  useEffectsStore,
  type EqParams,
  type Effect,
} from '../../stores/effectsStore';
import { getLaneAnalyser } from '../../stores/audio/trackEq';

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
  // Optional: when supplied, the panel exposes a small grip icon in
  // the header that, on pointer-down, hands the gesture to the parent
  // Reorder.Item via this callback. Typed loosely (any element) so
  // the consumer can fire it from a button, span, or div without
  // TS friction.
  onHeaderPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
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
  // Refs for the spectrum paths so the rAF loop can write `d`
  // attributes directly without triggering React re-renders. Drawing
  // 60 fps via setState would re-render the whole panel each frame.
  const spectrumFillRef = useRef<SVGPathElement | null>(null);
  const spectrumLineRef = useRef<SVGPathElement | null>(null);
  // Mirror of `bands` so the analyser rAF can read the latest positions
  // without re-subscribing. Avoids tearing down the rAF on every drag.
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  // Per-band energy (0..1) read from the FFT magnitudes around each
  // band's centre frequency. Drives the spotlight + halo motion.
  const [bandEnergies, setBandEnergies] = useState<number[]>([0, 0, 0, 0]);

  // Live spectrum visualizer. Tapped at the head of the EQ chain, so
  // the curve shows what's flowing INTO the EQ (pre-band-shaping).
  // The analyser only exists once playback has started and the per-
  // clip chain has been built — until then we draw a flat baseline.
  useEffect(() => {
    let raf = 0;
    let buf: Uint8Array | null = null;
    const STEPS = 120;
    const yBottom = PLOT_Y + PLOT_H;
    // Asymmetric smoothing for per-band energy — fast attack so hits
    // pop, slow release so the halo decays gracefully between transients.
    const smoothed = [0, 0, 0, 0];
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const fillEl = spectrumFillRef.current;
      const lineEl = spectrumLineRef.current;
      if (!fillEl || !lineEl) return;
      const analyser = getLaneAnalyser(laneKey);
      if (!analyser) {
        fillEl.setAttribute('d', '');
        lineEl.setAttribute('d', '');
        // Decay the halo state when audio stops so it eases back to rest.
        for (let i = 0; i < 4; i++) smoothed[i] *= 0.9;
        setBandEnergies([smoothed[0], smoothed[1], smoothed[2], smoothed[3]]);
        return;
      }
      const bins = analyser.frequencyBinCount;
      if (!buf || buf.length !== bins) buf = new Uint8Array(bins);
      analyser.getByteFrequencyData(buf as unknown as Uint8Array<ArrayBuffer>);
      const sampleRate = analyser.context.sampleRate;
      const nyquist = sampleRate / 2;

      const linePts: string[] = [];
      let prevLogF = LOG_MIN;
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const logF = LOG_MIN + t * (LOG_MAX - LOG_MIN);
        const fLo = Math.pow(10, prevLogF);
        const fHi = Math.pow(10, logF);
        const binLo = Math.max(0, Math.floor((fLo / nyquist) * bins));
        const binHi = Math.min(bins - 1, Math.ceil((fHi / nyquist) * bins));
        let acc = 0, count = 0;
        for (let b = binLo; b <= binHi; b++) { acc += buf[b]; count++; }
        const v = count > 0 ? (acc / count) / 255 : 0;
        const x = PLOT_X + t * PLOT_W;
        const gamma = Math.pow(v, 0.7);
        const y = yBottom - gamma * PLOT_H;
        linePts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
        prevLogF = logF;
      }
      const linePath = linePts.join(' ');
      const fillPathSpectrum = `${linePath} L ${PLOT_X + PLOT_W} ${yBottom} L ${PLOT_X} ${yBottom} Z`;
      lineEl.setAttribute('d', linePath);
      fillEl.setAttribute('d', fillPathSpectrum);

      // Per-band energy — average FFT magnitudes inside ±1/3-octave of
      // each band's centre frequency. Drives the spotlight + halo.
      const cur = bandsRef.current;
      const energies: number[] = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const f = cur[i]?.freq || 1000;
        const fLo = f / 1.4;
        const fHi = f * 1.4;
        const binLo = Math.max(0, Math.floor((fLo / nyquist) * bins));
        const binHi = Math.min(bins - 1, Math.ceil((fHi / nyquist) * bins));
        let acc = 0, count = 0;
        for (let b = binLo; b <= binHi; b++) { acc += buf[b]; count++; }
        const raw = count > 0 ? (acc / count) / 255 : 0;
        const a = raw > smoothed[i] ? 0.45 : 0.10;
        smoothed[i] = smoothed[i] * (1 - a) + raw * a;
        energies[i] = Math.min(1, smoothed[i] * 1.8);
      }
      setBandEnergies(energies);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [laneKey]);

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
        // Locked to PANEL_HEIGHT — CompressorPanel uses the same value
        // so the two panels render at the same pixel height when they
        // sit side-by-side in the chain rail.
        height: 252,
        background: 'rgba(15, 12, 32, 0.92)',
        border: '1px solid rgba(168, 134, 255, 0.18)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        opacity: dimmed,
        transition: 'opacity 120ms linear',
      }}
    >
      {/* Header — only the small grip icon at the start is the drag
          handle. Everything else (title, bypass, close) is passive so
          band-node drags below stay clean. */}
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
            {/* Vertical spotlight gradient — fades in at the centre and
                out at top/bottom so each band's frequency column glows
                from the inside, like a stage light. */}
            <linearGradient id="eqSpotlightGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity="0" />
              <stop offset="50%" stopColor={accent} stopOpacity="0.55" />
              <stop offset="100%" stopColor={accent} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Live input spectrum — tapped at the EQ chain head. Drawn
              FIRST so the response curve fill / line render on top.
              Path `d` is updated per-frame via ref to avoid React
              re-renders. */}
          <path ref={spectrumFillRef} fill="rgba(120, 90, 200, 0.18)" />
          <path
            ref={spectrumLineRef}
            fill="none"
            stroke="rgba(180, 150, 240, 0.55)"
            strokeWidth={1}
            strokeLinejoin="round"
          />

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

          {/* Per-band spotlight beams — vertical gradient strips that
              brighten with the energy at each band's centre frequency.
              Sit BEHIND the curve so they read as light spilling out
              of the EQ from the band's column. pointer-events="none"
              is set as an SVG attribute so the strips never intercept
              drags targeted at the node circles. */}
          {bands.map((band, idx) => {
            const cx = freqToX(band.freq);
            const energy = bandEnergies[idx] ?? 0;
            return (
              <motion.rect
                key={`spot-${idx}`}
                x={cx - 16}
                y={PLOT_Y}
                width={32}
                height={PLOT_H}
                fill="url(#eqSpotlightGrad)"
                animate={{ opacity: 0.04 + energy * 0.65 }}
                transition={{ type: 'tween', duration: 0.06, ease: 'linear' }}
                pointerEvents="none"
              />
            );
          })}

          {/* Filled area beneath the curve */}
          <path d={fillPath} fill="url(#eqFillGrad)" />
          {/* Curve */}
          <path d={curvePath} fill="none" stroke={accent} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />

          {/* Draggable band nodes. Two decorative layers (pulsing halo
              + soft inner ring) sit behind a plain interactive circle.
              The core stays a non-motion <circle> so its DOM cx/cy
              attributes are exact every frame — Framer's spring on cx/cy
              caused the visual position to lag the hit-test target,
              and the user couldn't grab the node. */}
          {bands.map((band, idx) => {
            const cx = freqToX(band.freq);
            const cy = gainToY(band.gain);
            const energy = bandEnergies[idx] ?? 0;
            return (
              <g key={idx}>
                <motion.circle
                  cx={cx}
                  cy={cy}
                  fill={accent}
                  stroke="none"
                  animate={{
                    r: 9 + energy * 14,
                    opacity: 0.16 + energy * 0.40,
                  }}
                  transition={{ type: 'spring', stiffness: 220, damping: 16 }}
                  pointerEvents="none"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={9}
                  fill="rgba(168,85,247,0.18)"
                  stroke="none"
                  pointerEvents="none"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={5.5}
                  fill="url(#eqNodeGrad)"
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1.2}
                  style={{
                    cursor: 'grab',
                    filter: `drop-shadow(0 0 ${4 + energy * 10}px ${accent})`,
                  }}
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
