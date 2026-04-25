import { useEffect, useMemo, useRef, useState } from 'react';
import { useArrangementComments, type ArrangementComment } from '../../hooks/useArrangementComments';
import { useAuthStore } from '../../stores/authStore';
import Avatar from '../common/Avatar';
import { TRACK_HEADER_WIDTH, useArrangement } from './ArrangementComponents';

// Figma-style timeline comments. Click the speech-bubble button (or press C)
// to enter comment mode; click anywhere on the timeline to drop a pin and
// type. Pins persist server-side via the existing comments table — they
// already have positionBeats + parentId so threads work natively.

type PendingPin = { x: number; rect: DOMRect; positionBeats: number };

interface Props {
  projectId: string;
}

export default function ArrangementComments({ projectId }: Props) {
  const { bpm: projectBpm, arrangementDur } = useArrangement();
  const { comments, addComment, deleteComment } = useArrangementComments(projectId);
  const me = useAuthStore((s) => s.user);
  const [commentMode, setCommentMode] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPin | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Group comments into threads: top-level pins + replies hanging off them.
  const { topLevel, repliesByParent } = useMemo(() => {
    const top: ArrangementComment[] = [];
    const replies = new Map<string, ArrangementComment[]>();
    for (const c of comments) {
      if (c.parentId) {
        if (!replies.has(c.parentId)) replies.set(c.parentId, []);
        replies.get(c.parentId)!.push(c);
      } else if (c.positionBeats != null) {
        top.push(c);
      }
    }
    // Replies oldest-first within a thread; top-level has no canonical order.
    for (const arr of replies.values()) arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { topLevel: top, repliesByParent: replies };
  }, [comments]);

  // Hotkey: C toggles comment mode (when not typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setCommentMode((v) => !v);
      } else if (e.key === 'Escape') {
        setPending(null);
        setOpenThreadId(null);
        setCommentMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cursor swap when in comment mode so the user can see the active state.
  useEffect(() => {
    if (!commentMode) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    return () => { document.body.style.cursor = prev; };
  }, [commentMode]);

  const beatsPerSec = projectBpm > 0 ? projectBpm / 60 : 2;
  const arrangementBeats = arrangementDur * beatsPerSec;

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!commentMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const positionBeats = ratio * arrangementBeats;
    setPending({ x: e.clientX, rect, positionBeats });
    setOpenThreadId(null);
    e.stopPropagation();
  };

  const submitPending = async (text: string) => {
    if (!pending || !text.trim()) return;
    await addComment(text.trim(), pending.positionBeats);
    setPending(null);
  };

  const submitReply = async (parentId: string, text: string) => {
    if (!text.trim()) return;
    const parent = comments.find((c) => c.id === parentId);
    const positionBeats = parent?.positionBeats ?? 0;
    await addComment(text.trim(), positionBeats, parentId);
  };

  const pctForBeats = (beats: number) => arrangementBeats > 0 ? (beats / arrangementBeats) * 100 : 0;

  return (
    <>
      {/* Floating toggle in the corner of the arrangement area. */}
      <button
        onClick={() => setCommentMode((v) => !v)}
        className={`absolute right-2 top-1 z-30 w-7 h-7 flex items-center justify-center rounded-full transition-all ${
          commentMode
            ? 'bg-ghost-green/20 text-ghost-green ring-1 ring-ghost-green/60'
            : 'bg-black/40 text-white/60 hover:bg-white/[0.08] hover:text-white'
        }`}
        title={commentMode ? 'Exit comment mode (Esc)' : 'Comment (C)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {/* Click-capture overlay for dropping pins (only active in comment mode).
          Offset by the track-header column so x maps to clip-area time. */}
      <div
        ref={containerRef}
        onClick={handleTimelineClick}
        className={`absolute pointer-events-${commentMode ? 'auto' : 'none'}`}
        style={{
          left: TRACK_HEADER_WIDTH, top: 0, bottom: 0, right: 0,
          zIndex: commentMode ? 25 : 14,
          cursor: commentMode ? 'crosshair' : 'default',
        }}
      >
        {/* Existing comment pins */}
        {topLevel.map((c) => {
          const left = pctForBeats(c.positionBeats || 0);
          const isOpen = openThreadId === c.id;
          return (
            <div
              key={c.id}
              className="absolute top-0 pointer-events-auto"
              style={{ left: `${left}%`, transform: 'translateX(-50%)', zIndex: isOpen ? 30 : 24 }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenThreadId(isOpen ? null : c.id);
                  setPending(null);
                }}
                className="relative w-6 h-6 flex items-center justify-center rounded-full ring-2 ring-black/40 hover:ring-ghost-green/70 transition-all"
                style={{ background: '#FFEB3B' }}
                title={`${c.authorName}: ${c.text.slice(0, 60)}`}
              >
                <Avatar name={c.authorName} src={c.authorAvatarUrl} size="xs" userId={c.authorId} />
              </button>
              {isOpen && (
                <ThreadPopover
                  thread={c}
                  replies={repliesByParent.get(c.id) || []}
                  meUserId={me?.id}
                  onClose={() => setOpenThreadId(null)}
                  onReply={(text) => submitReply(c.id, text)}
                  onDelete={async (id) => { await deleteComment(id); if (id === c.id) setOpenThreadId(null); }}
                />
              )}
            </div>
          );
        })}

        {/* Pending pin compose */}
        {pending && (
          <div
            className="absolute top-0 pointer-events-auto"
            style={{ left: `${pctForBeats(pending.positionBeats)}%`, transform: 'translateX(-50%)', zIndex: 35 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="w-6 h-6 flex items-center justify-center rounded-full ring-2 ring-black/40 animate-pulse"
              style={{ background: '#FFEB3B' }}
            >
              <Avatar name={me?.displayName || '?'} src={me?.avatarUrl ?? null} size="xs" userId={me?.id ?? null} />
            </div>
            <ComposePopover
              onSubmit={submitPending}
              onCancel={() => setPending(null)}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ── Thread popover ────────────────────────────────────────────────────────

function ThreadPopover({ thread, replies, meUserId, onClose, onReply, onDelete }: {
  thread: ArrangementComment;
  replies: ArrangementComment[];
  meUserId: string | undefined;
  onClose: () => void;
  onReply: (text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close on outside click. Pointer-down inside the popover stops propagation.
  useEffect(() => {
    const onDown = () => onClose();
    const id = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    return () => { clearTimeout(id); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute top-7 left-1/2 -translate-x-1/2 w-[280px] rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md"
      style={{ background: 'rgba(20,12,30,0.97)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="p-2 max-h-[260px] overflow-y-auto space-y-2">
        <CommentItem c={thread} canDelete={thread.authorId === meUserId} onDelete={() => onDelete(thread.id)} />
        {replies.map((r) => (
          <CommentItem key={r.id} c={r} canDelete={r.authorId === meUserId} onDelete={() => onDelete(r.id)} />
        ))}
      </div>
      <div className="border-t border-white/[0.06] p-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onReply(text);
              setText('');
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
          placeholder="Reply…"
          className="w-full px-2 py-1.5 text-[12px] rounded bg-black/30 border border-white/[0.08] text-white placeholder-white/30 focus:outline-none focus:border-ghost-green/50"
        />
      </div>
    </div>
  );
}

function CommentItem({ c, canDelete, onDelete }: { c: ArrangementComment; canDelete: boolean; onDelete: () => void }) {
  return (
    <div className="flex gap-2 group">
      <div className="shrink-0 mt-0.5">
        <Avatar name={c.authorName} src={c.authorAvatarUrl} size="sm" userId={c.authorId} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-white/85 truncate">{c.authorName}</span>
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-[10px] text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity ml-auto"
              title="Delete"
            >
              ×
            </button>
          )}
        </div>
        <p className="text-[12px] text-white/80 break-words whitespace-pre-wrap leading-snug">{c.text}</p>
      </div>
    </div>
  );
}

// ── Compose popover (new pin) ────────────────────────────────────────────

function ComposePopover({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute top-7 left-1/2 -translate-x-1/2 w-[260px] rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-md p-2"
      style={{ background: 'rgba(20,12,30,0.97)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        placeholder="Comment…"
        className="w-full px-2 py-1.5 text-[12px] rounded bg-black/30 border border-white/[0.08] text-white placeholder-white/30 focus:outline-none focus:border-ghost-green/50"
      />
      <div className="flex justify-end gap-1 mt-1.5">
        <button
          onClick={onCancel}
          className="px-2 py-0.5 text-[11px] text-white/50 hover:text-white"
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(text)}
          disabled={!text.trim()}
          className="px-2.5 py-0.5 text-[11px] font-semibold rounded text-white disabled:opacity-30"
          style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}
        >
          Comment
        </button>
      </div>
    </div>
  );
}
