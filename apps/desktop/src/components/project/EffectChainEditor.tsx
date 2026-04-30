import { Reorder, useDragControls } from 'framer-motion';
import { useEffectsStore, EFFECT_HUE, EFFECT_LABEL, type Effect } from '../../stores/effectsStore';
import { EffectIcon } from '../layout/EffectsSection';
import ChannelEqPanel from './ChannelEqPanel';
import CompressorPanel from './CompressorPanel';

// Per-track FX chain editor. Sits above the per-clip controls in
// SampleEditorPanel whenever the selected track has at least one effect.
// Drag cards to reorder, click ⊘ to bypass, click × to remove. Controls
// inside each card are placeholders — actual DSP routing comes in a
// follow-up; the chain shape is what matters here so the visual flow
// (drop → reorder → bypass → delete) works end-to-end now.

export default function EffectChainEditor({ laneKey, embedded = false }: { laneKey: string; embedded?: boolean }) {
  // Subscribe to byProject so we re-render when other components mutate
  // the chain (drop on the lane, etc.). getChain reads off currentProjectId.
  const byProject = useEffectsStore((s) => s.byProject);
  void byProject;
  const chain = useEffectsStore((s) => s.getChain(laneKey));
  const setOrder = useEffectsStore((s) => s.setOrder);
  const remove = useEffectsStore((s) => s.remove);
  const toggleBypass = useEffectsStore((s) => s.toggleBypass);

  if (!laneKey || !chain || chain.length === 0) return null;

  // When embedded, render only the inner chain rail. Caller is
  // responsible for the surrounding card / spacing. Lets the
  // SampleEditorPanel fuse the chain editor with the per-clip
  // controls into a single glass card.
  if (embedded) {
    return (
      <div className="shrink-0 px-3 py-3 overflow-x-auto">
        <Reorder.Group
          axis="x"
          values={chain.map((e) => e.id)}
          onReorder={(newIds) => setOrder(laneKey, newIds as string[])}
          className="flex gap-2 items-stretch"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {chain.map((fx, idx) => {
            const isLast = idx === chain.length - 1;
            if (fx.kind === 'eq') {
              return (
                <EqChainItem
                  key={fx.id}
                  fx={fx}
                  laneKey={laneKey}
                  isLast={isLast}
                  onClose={() => remove(laneKey, fx.id)}
                />
              );
            }
            if (fx.kind === 'comp') {
              return (
                <CompChainItem
                  key={fx.id}
                  fx={fx}
                  laneKey={laneKey}
                  isLast={isLast}
                  onClose={() => remove(laneKey, fx.id)}
                />
              );
            }
            return (
              <ChainCard
                key={fx.id}
                fx={fx}
                isLast={isLast}
                onBypass={() => toggleBypass(laneKey, fx.id)}
                onRemove={() => remove(laneKey, fx.id)}
              />
            );
          })}
        </Reorder.Group>
      </div>
    );
  }

  return (
    <div className="shrink-0 mt-2 rounded-2xl glass flex overflow-hidden">
      {/* Chain rail spans the whole panel — no separate identity column. */}
      <div className="flex-1 min-w-0 px-3 py-3 overflow-x-auto">
        <Reorder.Group
          axis="x"
          values={chain.map((e) => e.id)}
          onReorder={(newIds) => setOrder(laneKey, newIds as string[])}
          className="flex gap-2 items-stretch"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {chain.map((fx, idx) => {
            const isLast = idx === chain.length - 1;
            // EQ renders the full Channel EQ widget. The panel owns its
            // own bypass + close icons inside the header, so onBypass /
            // onRemove from this scope drive close = remove the effect.
            if (fx.kind === 'eq') {
              // EQ panel is reorderable ONLY by the header strip — the
              // body holds the band-node graph and must stay free.
              // useDragControls lets us hand the start trigger to the
              // header's pointer-down via ChannelEqPanel's prop.
              return (
                <EqChainItem
                  key={fx.id}
                  fx={fx}
                  laneKey={laneKey}
                  isLast={isLast}
                  onClose={() => remove(laneKey, fx.id)}
                />
              );
            }
            if (fx.kind === 'comp') {
              return (
                <CompChainItem
                  key={fx.id}
                  fx={fx}
                  laneKey={laneKey}
                  isLast={isLast}
                  onClose={() => remove(laneKey, fx.id)}
                />
              );
            }
            return (
              <ChainCard
                key={fx.id}
                fx={fx}
                isLast={isLast}
                onBypass={() => toggleBypass(laneKey, fx.id)}
                onRemove={() => remove(laneKey, fx.id)}
              />
            );
          })}
        </Reorder.Group>
      </div>
    </div>
  );
}

// Reorder.Item wrapper for EQ panels. dragListener={false} keeps the
// pointer-down on the body / graph from triggering reorder; the header
// strip inside ChannelEqPanel calls dragControls.start(e) when the
// user grabs it, so reorder is opt-in via that one strip only.
function EqChainItem({ fx, laneKey, isLast, onClose }: {
  fx: Effect;
  laneKey: string;
  isLast: boolean;
  onClose: () => void;
}) {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      value={fx.id}
      dragListener={false}
      dragControls={dragControls}
      style={{ listStyle: 'none' }}
      whileDrag={{ scale: 1.02, zIndex: 30, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      className="shrink-0"
    >
      <div className="flex items-stretch gap-1">
        <ChannelEqPanel
          laneKey={laneKey}
          effect={fx}
          onClose={onClose}
          onHeaderPointerDown={(e) => {
            // Hand the active pointer event to framer's drag controller
            // so reorder picks up from this gesture. The native event
            // is what framer's gesture recogniser actually inspects —
            // pass it explicitly so older browsers don't trip on the
            // SyntheticEvent wrapper.
            dragControls.start(e.nativeEvent ?? e);
          }}
        />
        {!isLast && (
          <span className="shrink-0 self-center text-[14px] font-bold text-white/30 px-0.5 select-none">→</span>
        )}
      </div>
    </Reorder.Item>
  );
}

// Same drag-handle pattern as EqChainItem — header grip is the only
// reorder trigger so curve / knob drags inside the body stay free.
function CompChainItem({ fx, laneKey, isLast, onClose }: {
  fx: Effect;
  laneKey: string;
  isLast: boolean;
  onClose: () => void;
}) {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      value={fx.id}
      dragListener={false}
      dragControls={dragControls}
      style={{ listStyle: 'none' }}
      whileDrag={{ scale: 1.02, zIndex: 30, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      className="shrink-0"
    >
      <div className="flex items-stretch gap-1">
        <CompressorPanel
          laneKey={laneKey}
          effect={fx}
          onClose={onClose}
          onHeaderPointerDown={(e) => dragControls.start(e.nativeEvent ?? e)}
        />
        {!isLast && (
          <span className="shrink-0 self-center text-[14px] font-bold text-white/30 px-0.5 select-none">→</span>
        )}
      </div>
    </Reorder.Item>
  );
}

function ChainCard({ fx, isLast, onBypass, onRemove }: { fx: Effect; isLast: boolean; onBypass: () => void; onRemove: () => void }) {
  const hue = EFFECT_HUE[fx.kind];
  const accent = `hsl(${hue}, 80%, 65%)`;
  const dimmed = fx.bypassed ? 0.45 : 1;
  return (
    <Reorder.Item
      value={fx.id}
      style={{ listStyle: 'none' }}
      whileDrag={{ scale: 1.04, zIndex: 30, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}
      className="shrink-0 cursor-grab active:cursor-grabbing"
    >
      <div className="flex items-center gap-1">
        <div
          className="w-[150px] rounded-lg flex flex-col gap-1.5 px-2.5 py-2"
          style={{
            background: `linear-gradient(180deg, hsla(${hue}, 80%, 50%, 0.10), hsla(${hue}, 80%, 50%, 0.04))`,
            border: `1px solid hsla(${hue}, 80%, 60%, ${fx.bypassed ? 0.18 : 0.36})`,
            opacity: dimmed,
            transition: 'opacity 120ms linear',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="shrink-0 w-5 h-5 rounded flex items-center justify-center"
              style={{ background: `hsla(${hue}, 80%, 50%, 0.20)`, color: accent }}
            >
              <EffectIcon kind={fx.kind} size={11} />
            </span>
            <span className="flex-1 text-[12px] font-semibold uppercase tracking-wider text-white/90">
              {EFFECT_LABEL[fx.kind]}
            </span>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onBypass(); }}
              title={fx.bypassed ? 'Enable' : 'Bypass'}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors hover:bg-white/10"
              style={{ color: fx.bypassed ? 'rgba(255,255,255,0.45)' : accent }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
            </button>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              title="Remove"
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-white/55 hover:text-red-400 hover:bg-white/10 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div
            className="flex-1 rounded text-[9.5px] uppercase tracking-wider text-white/35 px-2 py-2 flex items-center justify-center text-center leading-tight"
            style={{ background: 'rgba(0,0,0,0.18)', border: '1px dashed rgba(255,255,255,0.06)', minHeight: 38 }}
          >
            {fx.bypassed ? 'Bypassed' : 'Controls — audio routing pending'}
          </div>
        </div>
        {!isLast && (
          <span className="shrink-0 text-[14px] font-bold text-white/30 px-0.5 select-none">→</span>
        )}
      </div>
    </Reorder.Item>
  );
}
