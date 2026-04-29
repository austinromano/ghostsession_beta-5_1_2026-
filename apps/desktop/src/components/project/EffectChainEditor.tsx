import { Reorder } from 'framer-motion';
import { useEffectsStore, EFFECT_HUE, EFFECT_LABEL, type Effect } from '../../stores/effectsStore';
import { EffectIcon } from '../layout/EffectsSection';

// Per-track FX chain editor. Sits above the per-clip controls in
// SampleEditorPanel whenever the selected track has at least one effect.
// Drag cards to reorder, click ⊘ to bypass, click × to remove. Controls
// inside each card are placeholders — actual DSP routing comes in a
// follow-up; the chain shape is what matters here so the visual flow
// (drop → reorder → bypass → delete) works end-to-end now.

export default function EffectChainEditor({ trackId }: { trackId: string }) {
  // Subscribe to byProject so we re-render when other components mutate
  // the chain (drop on the lane, etc.). getChain reads off currentProjectId.
  const byProject = useEffectsStore((s) => s.byProject);
  void byProject;
  const chain = useEffectsStore((s) => s.getChain(trackId));
  const setOrder = useEffectsStore((s) => s.setOrder);
  const remove = useEffectsStore((s) => s.remove);
  const toggleBypass = useEffectsStore((s) => s.toggleBypass);

  if (!chain || chain.length === 0) return null;

  return (
    <div className="shrink-0 mt-2 rounded-2xl glass flex overflow-hidden">
      {/* Identity column — same width as the per-clip / bus identity
          column so the layout reads consistently between modes. */}
      <div className="shrink-0 w-[180px] flex flex-col gap-1 px-3 py-3 border-r border-white/[0.05]">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#a855f7', boxShadow: '0 0 6px #a855f7' }} />
          <span className="text-[12px] font-semibold text-white/90 uppercase tracking-wider">Track FX</span>
        </div>
        <div className="text-[10px] text-white/45 leading-snug">
          Drag cards to reorder. ⊘ bypass, × remove. Drop more from the sidebar Effects section.
        </div>
      </div>
      {/* Chain rail */}
      <div className="flex-1 min-w-0 px-3 py-3 overflow-x-auto">
        <Reorder.Group
          axis="x"
          values={chain.map((e) => e.id)}
          onReorder={(newIds) => setOrder(trackId, newIds as string[])}
          className="flex gap-2 items-stretch"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {chain.map((fx, idx) => (
            <ChainCard
              key={fx.id}
              fx={fx}
              isLast={idx === chain.length - 1}
              onBypass={() => toggleBypass(trackId, fx.id)}
              onRemove={() => remove(trackId, fx.id)}
            />
          ))}
        </Reorder.Group>
      </div>
    </div>
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
