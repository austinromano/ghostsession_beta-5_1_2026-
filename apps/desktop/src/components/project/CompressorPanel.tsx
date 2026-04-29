import { useEffect, useMemo, useRef } from 'react';
import {
  defaultParams,
  useEffectsStore,
  type CompParams,
  type Effect,
} from '../../stores/effectsStore';
import {
  getLaneCompAnalyser,
  getLaneCompOutputAnalyser,
  getLaneCompEnvelope,
} from '../../stores/audio/trackComp';

// Compressor panel — visual-first. Mirrors the user-supplied design:
//
//   ┌──────────────────────────────────┐
//   │ ⋮⋮  ◆ Compressor          [×]    │
//   ├──────────────────────────────────┤
//   │ ▮  ┌──────────────┐ Threshold    │
//   │ ▮  │  transfer    │ -18.0 dB     │
//   │ ▮  │  curve graph │ Ratio        │
//   │ ▮  │ with 2 knees │ 4.0:1        │
//   │ ▮  └──────────────┘ Attack ...   │
//   ├──────────────────────────────────┤
//   │   ◯ knob       ◯ knob            │
//   │   10 ms        100 ms            │
//   └──────────────────────────────────┘
//
// Drag the threshold point (left knee) to retune threshold.
// Drag the ratio point (right knee) vertically to retune ratio.
// Knobs handle attack + release with vertical-drag-to-change.
//
// DSP routing not wired yet — params persist via effectsStore so the
// audio layer can mirror them once a comp worklet is ready per track.

const PANEL_W = 304;

// Transfer-curve graph dimensions. Sized so the panel ends up at the
// same overall height as ChannelEqPanel — graph is shorter than EQ's
// because the comp adds a knob row underneath, while the EQ uses the
// equivalent space for its band readouts.
const GRAPH_VIEW_W = 150;
const GRAPH_VIEW_H = 96;
const GRAPH_PAD = 6;
const GRAPH_PLOT_X = GRAPH_PAD;
const GRAPH_PLOT_Y = GRAPH_PAD;
const GRAPH_PLOT_W = GRAPH_VIEW_W - GRAPH_PAD * 2;
const GRAPH_PLOT_H = GRAPH_VIEW_H - GRAPH_PAD * 2;

// dB ranges drawn by the transfer curve.
const DB_MIN = -60;
const DB_MAX = 0;

const RATIO_MIN = 1;
const RATIO_MAX = 20;

const ATTACK_MIN = 1;
const ATTACK_MAX = 200;
const RELEASE_MIN = 10;
const RELEASE_MAX = 1000;

const ACCENT = '#a855f7';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function dbToX(dB: number): number {
  const t = (dB - DB_MIN) / (DB_MAX - DB_MIN);
  return GRAPH_PLOT_X + t * GRAPH_PLOT_W;
}
function dbToY(dB: number): number {
  // Higher dB → smaller y (top of graph).
  const t = (dB - DB_MIN) / (DB_MAX - DB_MIN);
  return GRAPH_PLOT_Y + (1 - t) * GRAPH_PLOT_H;
}
function xToDb(x: number): number {
  const t = clamp((x - GRAPH_PLOT_X) / GRAPH_PLOT_W, 0, 1);
  return DB_MIN + t * (DB_MAX - DB_MIN);
}
function yToDb(y: number): number {
  const t = clamp((y - GRAPH_PLOT_Y) / GRAPH_PLOT_H, 0, 1);
  return DB_MIN + (1 - t) * (DB_MAX - DB_MIN);
}

// Compute the output dB at input dB given threshold + ratio.
// Below threshold: output = input. Above: output = threshold + (input - threshold) / ratio.
function compress(inDb: number, threshold: number, ratio: number): number {
  if (inDb <= threshold) return inDb;
  return threshold + (inDb - threshold) / ratio;
}

function formatThreshold(dB: number): string {
  return `${dB.toFixed(1)} dB`;
}
function formatRatio(r: number): string {
  return `${r.toFixed(1)}:1`;
}
function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(0)} ms`;
}
function formatGain(dB: number): string {
  const sign = dB >= 0 ? '+' : '';
  return `${sign}${dB.toFixed(1)} dB`;
}

export default function CompressorPanel({
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
  const setCompParam = useEffectsStore((s) => s.setCompParam);
  const toggleBypass = useEffectsStore((s) => s.toggleBypass);

  const params: CompParams = useMemo(() => {
    if (effect.params && 'threshold' in effect.params) return effect.params as CompParams;
    return defaultParams('comp') as CompParams;
  }, [effect.params]);

  const { threshold, ratio, attack, release, makeup } = params;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<'threshold' | 'ratio' | null>(null);

  // Refs for the live visualizer overlay. The graph hosts:
  //   - A scrolling time-history of input + output dB (input lighter,
  //     output darker — the visible gap between them is the compression
  //     happening in real time).
  //   - The "compression dot" tracking the current (inputDb, outputDb)
  //     point on the transfer curve, with two faint guide lines.
  // All updates land via setAttribute in a single rAF loop so React
  // never re-renders this panel during playback.
  const compDotRef = useRef<SVGCircleElement | null>(null);
  const compDotHaloRef = useRef<SVGCircleElement | null>(null);
  const compInputLineRef = useRef<SVGLineElement | null>(null);
  const compOutputLineRef = useRef<SVGLineElement | null>(null);
  const inWavePathRef = useRef<SVGPathElement | null>(null);
  const outWavePathRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let inBuf: Float32Array | null = null;
    let outBuf: Float32Array | null = null;
    let smoothInDb = -60;
    let smoothOutDb = -60;
    // Ring buffer of recent dB samples for the scrolling waveform.
    // Sampled at the rAF rate (~60 Hz). 96 samples ≈ 1.6 seconds of
    // audio history across the graph width.
    const HISTORY_LEN = 96;
    const inHistory: number[] = new Array(HISTORY_LEN).fill(-60);
    const outHistory: number[] = new Array(HISTORY_LEN).fill(-60);
    let head = 0;
    const SMOOTH = 0.35; // higher = snappier dot, lower = lazier
    const yBottom = GRAPH_PLOT_Y + GRAPH_PLOT_H;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const inA = getLaneCompAnalyser(laneKey);
      const outA = getLaneCompOutputAnalyser(laneKey);
      const dot = compDotRef.current;
      const halo = compDotHaloRef.current;
      const vLine = compInputLineRef.current;
      const hLine = compOutputLineRef.current;
      const inWave = inWavePathRef.current;
      const outWave = outWavePathRef.current;
      if (!dot || !halo) return;

      const rmsDb = (analyser: AnalyserNode | null, prev: Float32Array | null): { db: number; buf: Float32Array | null } => {
        if (!analyser) return { db: -60, buf: prev };
        const bins = analyser.fftSize;
        let buf = prev;
        if (!buf || buf.length !== bins) buf = new Float32Array(bins);
        // Newer TS lib types narrow the param to Uint8Array<ArrayBuffer>;
        // runtime contract is the same so cast at the call site.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        analyser.getFloatTimeDomainData(buf as any);
        let sum = 0;
        for (let i = 0; i < bins; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / bins);
        const db = rms > 1e-5 ? 20 * Math.log10(rms) : -60;
        return { db, buf };
      };

      const inRes = rmsDb(inA, inBuf);
      const outRes = rmsDb(outA, outBuf);
      inBuf = inRes.buf; outBuf = outRes.buf;

      smoothInDb += (inRes.db - smoothInDb) * SMOOTH;
      smoothOutDb += (outRes.db - smoothOutDb) * SMOOTH;

      // Append to history. Treat head as the OLDEST slot; we overwrite
      // it with the newest value, then advance — this is the standard
      // ring-buffer trick that keeps draw order O(N) without shifting.
      inHistory[head] = smoothInDb;
      outHistory[head] = smoothOutDb;
      head = (head + 1) % HISTORY_LEN;

      // Build scrolling-waveform paths. Index 0 of the visible series
      // corresponds to the OLDEST sample (head, since head is the slot
      // just overwritten and is now the eldest in modular order — wait,
      // we just incremented head, so head now points at the slot to be
      // overwritten next frame, which is the OLDEST current sample).
      // Walk i = 0..HISTORY_LEN-1, reading from (head + i) % HISTORY_LEN.
      if (inWave && outWave) {
        const dx = GRAPH_PLOT_W / (HISTORY_LEN - 1);
        let dIn = `M ${GRAPH_PLOT_X} ${yBottom}`;
        let dOut = `M ${GRAPH_PLOT_X} ${yBottom}`;
        for (let i = 0; i < HISTORY_LEN; i++) {
          const idx = (head + i) % HISTORY_LEN;
          const x = GRAPH_PLOT_X + i * dx;
          const yI = dbToY(clamp(inHistory[idx], DB_MIN, DB_MAX));
          const yO = dbToY(clamp(outHistory[idx], DB_MIN, DB_MAX));
          dIn += ` L ${x.toFixed(2)} ${yI.toFixed(2)}`;
          dOut += ` L ${x.toFixed(2)} ${yO.toFixed(2)}`;
        }
        dIn += ` L ${GRAPH_PLOT_X + GRAPH_PLOT_W} ${yBottom} Z`;
        dOut += ` L ${GRAPH_PLOT_X + GRAPH_PLOT_W} ${yBottom} Z`;
        inWave.setAttribute('d', dIn);
        outWave.setAttribute('d', dOut);
      }

      const ix = dbToX(clamp(smoothInDb, DB_MIN, DB_MAX));
      const iy = dbToY(clamp(smoothOutDb, DB_MIN, DB_MAX));

      // Hide the dot when there's no signal, and dim under the noise
      // floor so we're not staring at a stuck point at the bottom-left.
      const visible = smoothInDb > -55;
      dot.setAttribute('cx', String(ix));
      dot.setAttribute('cy', String(iy));
      dot.setAttribute('opacity', visible ? '1' : '0');
      halo.setAttribute('cx', String(ix));
      halo.setAttribute('cy', String(iy));
      halo.setAttribute('opacity', visible ? '0.55' : '0');
      // Faint guide lines: vertical from x-axis up to the dot (input
      // level on the input axis), horizontal from dot to y-axis
      // (output level on the output axis). Together they build the
      // "where this audio sample lands on the curve" picture.
      if (vLine) {
        vLine.setAttribute('x1', String(ix));
        vLine.setAttribute('x2', String(ix));
        vLine.setAttribute('y1', String(GRAPH_PLOT_Y + GRAPH_PLOT_H));
        vLine.setAttribute('y2', String(iy));
        vLine.setAttribute('opacity', visible ? '0.35' : '0');
      }
      if (hLine) {
        hLine.setAttribute('x1', String(GRAPH_PLOT_X));
        hLine.setAttribute('x2', String(ix));
        hLine.setAttribute('y1', String(iy));
        hLine.setAttribute('y2', String(iy));
        hLine.setAttribute('opacity', visible ? '0.35' : '0');
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [laneKey]);

  // Curve path: 1:1 from -60..threshold, then sloped to (0, compress(0)).
  const curvePath = useMemo(() => {
    const x0 = dbToX(DB_MIN);
    const y0 = dbToY(DB_MIN);
    const xT = dbToX(threshold);
    const yT = dbToY(threshold);
    const x1 = dbToX(DB_MAX);
    const y1 = dbToY(compress(DB_MAX, threshold, ratio));
    return `M ${x0} ${y0} L ${xT} ${yT} L ${x1} ${y1}`;
  }, [threshold, ratio]);

  const fillPath = useMemo(() => {
    const x0 = dbToX(DB_MIN);
    const xT = dbToX(threshold);
    const yT = dbToY(threshold);
    const x1 = dbToX(DB_MAX);
    const y1 = dbToY(compress(DB_MAX, threshold, ratio));
    const yBottom = GRAPH_PLOT_Y + GRAPH_PLOT_H;
    return `M ${x0} ${yBottom} L ${x0} ${dbToY(DB_MIN)} L ${xT} ${yT} L ${x1} ${y1} L ${x1} ${yBottom} Z`;
  }, [threshold, ratio]);

  const onPointerDown = (which: 'threshold' | 'ratio') => (e: React.PointerEvent<SVGCircleElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = which;
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const which = dragRef.current;
    if (!which) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xRatio = GRAPH_VIEW_W / rect.width;
    const yRatio = GRAPH_VIEW_H / rect.height;
    const x = (e.clientX - rect.left) * xRatio;
    const y = (e.clientY - rect.top) * yRatio;

    if (which === 'threshold') {
      // Threshold knee — moves along the y=x diagonal (since at the
      // knee, output equals input). Use x to derive threshold dB,
      // clamp into range. Snap the knee to land on the diagonal.
      const newThreshold = clamp(xToDb(x), DB_MIN, DB_MAX);
      setCompParam(laneKey, effect.id, 'threshold', newThreshold);
    } else {
      // Ratio handle — at input = 0 dB on the curve. Derive ratio
      // from the y position: output(0) = threshold + (-threshold)/ratio.
      // Solve for ratio given output(0) = yToDb(y).
      const out0 = clamp(yToDb(y), DB_MIN, DB_MAX);
      // out0 = threshold + (0 - threshold) / ratio
      //      = threshold * (1 - 1/ratio)
      // → 1/ratio = 1 - out0/threshold
      // (only valid when threshold < 0; threshold == 0 is a degenerate
      //  case where any ratio yields out0 = 0, so leave ratio alone.)
      if (threshold < -0.5) {
        const inv = 1 - out0 / threshold;
        const newRatio = clamp(1 / Math.max(0.05, inv), RATIO_MIN, RATIO_MAX);
        setCompParam(laneKey, effect.id, 'ratio', newRatio);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  };

  const dimmed = effect.bypassed ? 0.5 : 1;

  return (
    <div
      className="rounded-xl select-none"
      style={{
        width: PANEL_W,
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
        <span
          className="w-3 h-3 rotate-45"
          style={{
            background: 'linear-gradient(135deg, #c084fc 0%, #7c3aed 100%)',
            borderRadius: 2,
            boxShadow: `0 0 6px ${ACCENT}`,
          }}
        />
        <span className="text-[12px] font-semibold text-white/90">Compressor</span>
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

      {/* Body: 3-meter cluster + curve + readouts */}
      <div className="flex gap-1.5 px-3 pt-1.5">
        {/* IN | GR | OUT — IN reads pre-comp, GR shows the live gain
            reduction the worklet is applying (top-down bar), OUT
            reads post-comp + makeup. Together they tell the full
            "how is the compressor working right now" story. */}
        <div className="flex items-end gap-1 shrink-0">
          <MeterColumn label="In" type="level" laneKey={laneKey} which="input" />
          <MeterColumn label="GR" type="reduction" laneKey={laneKey} which="gr" />
          <MeterColumn label="Out" type="level" laneKey={laneKey} which="output" />
        </div>

        {/* Transfer-curve graph */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${GRAPH_VIEW_W} ${GRAPH_VIEW_H}`}
          width={GRAPH_VIEW_W}
          height={GRAPH_VIEW_H}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ display: 'block', flexShrink: 0 }}
        >
          <defs>
            <linearGradient id="compFillGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity="0.36" />
              <stop offset="100%" stopColor={ACCENT} stopOpacity="0.04" />
            </linearGradient>
            <radialGradient id="compNodeGrad" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="#e9d5ff" />
              <stop offset="60%" stopColor={ACCENT} />
              <stop offset="100%" stopColor="#6d28d9" />
            </radialGradient>
          </defs>

          {/* Live time-history of input + output dB. The X-axis maps
              to time during this overlay (left = oldest, right = now);
              Y stays in dB. Input draws lighter and bigger; output
              draws darker and on top — the visible delta between the
              two filled shapes IS the compression happening, frame by
              frame. Path `d` is updated per-frame via ref so React
              never re-renders this panel. */}
          <path ref={inWavePathRef} fill="rgba(168, 134, 255, 0.22)" stroke="rgba(232, 213, 255, 0.55)" strokeWidth={0.8} />
          <path ref={outWavePathRef} fill="rgba(124, 58, 237, 0.55)" stroke="rgba(168, 85, 247, 0.85)" strokeWidth={1} />

          {/* Subtle grid lines */}
          {[-48, -36, -24, -12].map((dB) => (
            <line key={`vg-${dB}`} x1={dbToX(dB)} y1={GRAPH_PLOT_Y} x2={dbToX(dB)} y2={GRAPH_PLOT_Y + GRAPH_PLOT_H} stroke="rgba(255,255,255,0.03)" />
          ))}
          {[-48, -36, -24, -12].map((dB) => (
            <line key={`hg-${dB}`} x1={GRAPH_PLOT_X} y1={dbToY(dB)} x2={GRAPH_PLOT_X + GRAPH_PLOT_W} y2={dbToY(dB)} stroke="rgba(255,255,255,0.03)" />
          ))}

          {/* Static transfer curve (reference shape — input dB on x,
              output dB on y). No fill so the live waveform behind
              stays the dominant visual. */}
          <path d={curvePath} fill="none" stroke={ACCENT} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />

          {/* Vertical threshold marker line */}
          <line
            x1={dbToX(threshold)} y1={GRAPH_PLOT_Y}
            x2={dbToX(threshold)} y2={GRAPH_PLOT_Y + GRAPH_PLOT_H}
            stroke="rgba(168,134,255,0.18)"
            strokeDasharray="2 2"
          />

          {/* Live compression dot — rides along the transfer curve at
              (current input dB, current output dB). Drawn before the
              draggable knee circles so the knees stay on top. */}
          <line ref={compInputLineRef} stroke="rgba(232, 213, 255, 0.55)" strokeWidth={1} strokeDasharray="2 2" opacity={0} />
          <line ref={compOutputLineRef} stroke="rgba(232, 213, 255, 0.55)" strokeWidth={1} strokeDasharray="2 2" opacity={0} />
          <circle ref={compDotHaloRef} r={9} fill="rgba(232, 213, 255, 0.30)" opacity={0} pointerEvents="none" />
          <circle ref={compDotRef} r={3.5} fill="#f5e9ff" stroke="rgba(255,255,255,0.95)" strokeWidth={0.8} opacity={0} pointerEvents="none" style={{ filter: 'drop-shadow(0 0 4px #e9d5ff)' }} />

          {/* Threshold knee (left node) */}
          <circle cx={dbToX(threshold)} cy={dbToY(threshold)} r={9} fill="rgba(168,85,247,0.18)" />
          <circle
            cx={dbToX(threshold)}
            cy={dbToY(threshold)}
            r={5}
            fill="url(#compNodeGrad)"
            stroke="rgba(255,255,255,0.85)"
            strokeWidth={1.2}
            style={{ cursor: 'grab', filter: `drop-shadow(0 0 4px ${ACCENT})` }}
            onPointerDown={onPointerDown('threshold')}
          />

          {/* Ratio knee (right node, at input = 0 dB) */}
          {(() => {
            const cx = dbToX(DB_MAX);
            const cy = dbToY(compress(DB_MAX, threshold, ratio));
            return (
              <>
                <circle cx={cx} cy={cy} r={9} fill="rgba(168,85,247,0.18)" />
                <circle
                  cx={cx}
                  cy={cy}
                  r={5}
                  fill="url(#compNodeGrad)"
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1.2}
                  style={{ cursor: 'grab', filter: `drop-shadow(0 0 4px ${ACCENT})` }}
                  onPointerDown={onPointerDown('ratio')}
                />
              </>
            );
          })()}
        </svg>

        {/* Readouts column — 5 rows packed into the same vertical
            space as the graph/meters so the panel matches EQ height. */}
        <div className="flex flex-col gap-0 text-right grow shrink-0 pl-1 justify-between" style={{ minHeight: GRAPH_VIEW_H }}>
          <ReadoutRow label="Threshold" value={formatThreshold(threshold)} />
          <ReadoutRow label="Ratio" value={formatRatio(ratio)} />
          <ReadoutRow label="Attack" value={formatMs(attack)} />
          <ReadoutRow label="Release" value={formatMs(release)} />
          <ReadoutRow label="Makeup" value={formatGain(makeup)} />
        </div>
      </div>

      {/* Knob row — Attack / Release / Makeup. Drag vertically. */}
      <div className="flex items-center justify-around px-3 pt-1 pb-2">
        <Knob
          label={formatMs(attack)}
          caption="Attack"
          value={attack}
          min={ATTACK_MIN}
          max={ATTACK_MAX}
          onChange={(v) => setCompParam(laneKey, effect.id, 'attack', v)}
        />
        <Knob
          label={formatMs(release)}
          caption="Release"
          value={release}
          min={RELEASE_MIN}
          max={RELEASE_MAX}
          onChange={(v) => setCompParam(laneKey, effect.id, 'release', v)}
        />
        <Knob
          label={formatGain(makeup)}
          caption="Makeup"
          value={makeup}
          min={-20}
          max={20}
          onChange={(v) => setCompParam(laneKey, effect.id, 'makeup', v)}
        />
      </div>
    </div>
  );
}

function ReadoutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end" style={{ lineHeight: 1 }}>
      <span className="text-[8.5px] uppercase tracking-wider text-white/50">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums text-white/90 mt-[2px]">{value}</span>
    </div>
  );
}

// Three-mode meter column. type='level' fills BOTTOM-UP from the
// analyser's RMS (with peak-decay), gradient green→yellow→red.
// type='reduction' fills TOP-DOWN from the worklet's reported gain-
// reduction envelope (always negative dB), violet, so the user sees
// the comp pulling the signal down. Both share the same column shape
// so the IN / GR / OUT triplet reads as a unified strip.
function MeterColumn({
  label,
  type,
  laneKey,
  which,
}: {
  label: string;
  type: 'level' | 'reduction';
  laneKey: string;
  which: 'input' | 'output' | 'gr';
}) {
  const SEGMENTS = 14;
  const segRefs = useRef<Array<HTMLDivElement | null>>([]);
  const peakRef = useRef<number>(0);

  useEffect(() => {
    let raf = 0;
    let buf: Float32Array | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      let lit = 0;
      let topDown = false;
      let hueFor = (i: number) => 120 - (i / (SEGMENTS - 1)) * 120;
      if (type === 'level') {
        const analyser = which === 'output'
          ? getLaneCompOutputAnalyser(laneKey)
          : getLaneCompAnalyser(laneKey);
        let level = 0;
        if (analyser) {
          const bins = analyser.fftSize;
          if (!buf || buf.length !== bins) buf = new Float32Array(bins);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          analyser.getFloatTimeDomainData(buf as any);
          let sum = 0;
          for (let i = 0; i < bins; i++) sum += buf[i] * buf[i];
          level = Math.sqrt(sum / bins);
        }
        const decay = 0.92;
        peakRef.current = Math.max(level, peakRef.current * decay);
        const dB = peakRef.current > 1e-5 ? 20 * Math.log10(peakRef.current) : -60;
        const t = clamp((dB + 60) / 60, 0, 1);
        lit = Math.round(t * SEGMENTS);
      } else {
        // GR meter — invert envelope so larger reduction = taller bar.
        // Map 0..-30 dB onto the SEGMENTS range. Top-down fill (the
        // first segment lit is the topmost one).
        topDown = true;
        const env = getLaneCompEnvelope(laneKey); // ≤ 0
        const reduction = -env; // 0..30+ dB of reduction
        // Smooth slightly so jittery worklet posts don't make the
        // meter strobe.
        peakRef.current = Math.max(reduction, peakRef.current * 0.85);
        const t = clamp(peakRef.current / 30, 0, 1);
        lit = Math.round(t * SEGMENTS);
        // Solid violet for GR — bypass the green/yellow/red ladder
        // since reduction isn't a "danger" axis.
        hueFor = () => 270;
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const el = segRefs.current[i];
        if (!el) continue;
        // For top-down fill, lit segments are the TOP `lit` ones.
        // For bottom-up, lit segments are the BOTTOM `lit` ones.
        const isLit = topDown
          ? i >= SEGMENTS - lit
          : i < lit;
        const hue = hueFor(i);
        el.style.background = isLit
          ? (type === 'reduction' ? '#a855f7' : `hsl(${hue}, 85%, 55%)`)
          : 'rgba(255,255,255,0.04)';
        el.style.boxShadow = isLit
          ? (type === 'reduction' ? '0 0 4px rgba(168,85,247,0.7)' : `0 0 4px hsl(${hue}, 85%, 55%)`)
          : 'none';
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [laneKey, type, which]);

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0" style={{ width: 18 }}>
      <span className="text-[8px] font-semibold text-white/55 uppercase tracking-wider">{label}</span>
      <div
        className="rounded-sm overflow-hidden flex flex-col-reverse items-stretch gap-[1px] py-[1px] px-[1px]"
        style={{ width: 9, height: 80, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}
      >
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <div
            key={i}
            ref={(el) => { segRefs.current[i] = el; }}
            style={{ flex: 1, background: 'rgba(255,255,255,0.04)', borderRadius: 1, transition: 'box-shadow 80ms linear' }}
          />
        ))}
      </div>
    </div>
  );
}

// Round purple knob — drag vertically to change the value. Used for
// Attack and Release. Visual style: outer ring with a value-arc inside,
// label below.
function Knob({ label, caption, value, min, max, onChange }: { label: string; caption?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const dragStartRef = useRef<{ y: number; v: number } | null>(null);

  // Map value → arc end angle. -135° (bottom-left) to +135° (bottom-right).
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
    const dy = dragStartRef.current.y - e.clientY; // up = increase
    const SENS = 0.005; // value range / pixel of drag
    const range = max - min;
    const next = clamp(dragStartRef.current.v + dy * range * SENS, min, max);
    onChange(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    dragStartRef.current = null;
  };

  // SVG-arc path from startAngle to angle. Sized to match the EQ
  // panel's overall height — bigger knobs would push the panel taller.
  const SIZE = 38;
  const RADIUS = 16;
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

  // Indicator tick from center toward the angle.
  const [tickX, tickY] = toXY(angle);
  const tickInner = (() => {
    const r = (angle - 90) * (Math.PI / 180);
    return [cx + (RADIUS - 8) * Math.cos(r), cy + (RADIUS - 8) * Math.sin(r)];
  })();

  return (
    <div className="flex flex-col items-center gap-0.5 select-none">
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
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -2px 4px rgba(0,0,0,0.3), 0 0 8px rgba(168,85,247,0.16)',
          border: '1px solid rgba(168, 134, 255, 0.20)',
        }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ display: 'block' }}>
          <path d={arcBg} stroke="rgba(255,255,255,0.08)" strokeWidth={2} fill="none" strokeLinecap="round" />
          <path d={arcFg} stroke={ACCENT} strokeWidth={2} fill="none" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 2px ${ACCENT})` }} />
          <line
            x1={tickInner[0]} y1={tickInner[1]}
            x2={tickX} y2={tickY}
            stroke="#ffffff"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <span className="text-[9.5px] font-semibold tabular-nums text-white/85 leading-none">{label}</span>
      {caption && <span className="text-[7.5px] uppercase tracking-wider text-white/45 leading-none">{caption}</span>}
    </div>
  );
}
