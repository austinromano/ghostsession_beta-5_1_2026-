import { useState } from 'react';
import { EFFECT_DRAG_MIME, EFFECT_HUE, EFFECT_LABEL, type EffectKind } from '../../stores/effectsStore';

// Sidebar dropdown listing the three available effects (EQ, Comp, Reverb).
// Each row is an HTML5 drag source that writes EFFECT_DRAG_MIME with the
// effect kind so the arrangement track lanes can pick it up as a drop.
//
// Sits above SampleLibrarySection in the sidebar — see ProjectListSidebar.

const EFFECTS: Array<{ kind: EffectKind; description: string }> = [
  { kind: 'eq', description: '3-band EQ' },
  { kind: 'comp', description: 'Compressor' },
  { kind: 'reverb', description: 'Reverb' },
];

function EffectIcon({ kind, size = 12 }: { kind: EffectKind; size?: number }) {
  if (kind === 'eq') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    );
  }
  if (kind === 'comp') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l3-7 4 14 3-7h4" />
      </svg>
    );
  }
  // reverb
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0" />
      <path d="M2 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0" />
    </svg>
  );
}

export default function EffectsSection() {
  const [open, setOpen] = useState(true);

  return (
    <div className="px-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group w-full flex items-center gap-2 px-3 pt-4 pb-2 select-none"
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="text-ghost-green shrink-0"
        >
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <circle cx="6" cy="18" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <line x1="8.5" y1="6" x2="15.5" y2="6" />
          <line x1="6" y1="8.5" x2="6" y2="15.5" />
          <line x1="18" y1="8.5" x2="18" y2="15.5" />
          <line x1="8.5" y1="18" x2="15.5" y2="18" />
        </svg>
        <span className="text-[14px] font-bold text-white tracking-tight">Effects</span>
        <span className="ml-auto text-[11px] text-white/30">{EFFECTS.length}</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`text-white/30 transition-transform ${open ? '' : '-rotate-90'}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="px-2 pb-1.5 space-y-0.5">
          {EFFECTS.map(({ kind, description }) => {
            const hue = EFFECT_HUE[kind];
            const accent = `hsl(${hue}, 80%, 65%)`;
            return (
              <div
                key={kind}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData(EFFECT_DRAG_MIME, JSON.stringify({ kind }));
                  // Plain-text fallback so DevTools / external drop targets
                  // don't show an empty drag image.
                  e.dataTransfer.setData('text/plain', `Effect: ${EFFECT_LABEL[kind]}`);
                }}
                className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/[0.04] transition-colors cursor-grab active:cursor-grabbing"
                title={`Drag onto a track to add ${EFFECT_LABEL[kind]}`}
              >
                <span
                  className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                  style={{
                    background: `hsla(${hue}, 80%, 50%, 0.15)`,
                    color: accent,
                    border: `1px solid hsla(${hue}, 80%, 50%, 0.30)`,
                  }}
                >
                  <EffectIcon kind={kind} size={12} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-white/85 truncate">{EFFECT_LABEL[kind]}</span>
                  <span className="block text-[10.5px] text-white/35 truncate">{description}</span>
                </span>
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="text-white/25 group-hover:text-white/55 transition-colors shrink-0"
                >
                  <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
                  <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
                </svg>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { EffectIcon };
