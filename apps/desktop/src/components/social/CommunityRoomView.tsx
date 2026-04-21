import { useEffect, useRef, useState, useMemo } from 'react';
import { useCommunityStore } from '../../stores/communityStore';
import { useAuthStore } from '../../stores/authStore';
import { ROOMS } from './CommunityRooms';
import Avatar from '../common/Avatar';

function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

export default function CommunityRoomView() {
  const activeRoomId = useCommunityStore((s) => s.activeRoomId);
  const messagesByRoom = useCommunityStore((s) => s.messagesByRoom);
  const membersByRoom = useCommunityStore((s) => s.membersByRoom);
  const send = useCommunityStore((s) => s.send);
  const deleteMessage = useCommunityStore((s) => s.deleteMessage);
  const me = useAuthStore((s) => s.user);

  const room = useMemo(() => ROOMS.find((r) => r.id === activeRoomId), [activeRoomId]);
  const messages = activeRoomId ? messagesByRoom.get(activeRoomId) || [] : [];
  const members = activeRoomId ? membersByRoom.get(activeRoomId) || [] : [];
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, activeRoomId]);

  if (!room) return null;

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden rounded-2xl glass glass-glow">
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.06] shrink-0">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-[20px] shrink-0"
            style={{ background: room.gradient, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)' }}
          >
            {room.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-white truncate">{room.name}</div>
            <div className="text-[11px] text-white/50 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#22C55E' }} />
              <span><span className="font-semibold text-white/80">{members.length}</span> online</span>
              <span className="text-white/20">·</span>
              <span className="truncate">{room.tagline}</span>
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-center">
              <div>
                <p className="text-[14px] font-semibold text-white/70 mb-1">Welcome to {room.name}</p>
                <p className="text-[12px] text-white/40">Say hi — {members.length > 0 ? `${members.length} producer${members.length === 1 ? '' : 's'} online right now` : 'be the first to post'}.</p>
              </div>
            </div>
          ) : messages.map((msg, idx) => {
            const isOwn = msg.userId === me?.id;
            const prev = idx > 0 ? messages[idx - 1] : null;
            const sameAsPrev = prev && prev.userId === msg.userId
              && (Date.parse(msg.createdAt) - Date.parse(prev.createdAt)) < 5 * 60 * 1000;
            return (
              <div key={msg.id} className={`group flex items-end gap-2 ${isOwn ? 'justify-end' : 'justify-start'} ${sameAsPrev ? 'mt-0.5' : 'mt-3'}`}>
                {!isOwn && (
                  <div className={`shrink-0 w-8 ${sameAsPrev ? 'invisible' : ''}`}>
                    <Avatar name={msg.displayName} src={msg.avatarUrl} size="sm" userId={msg.userId} />
                  </div>
                )}
                <div className={`flex flex-col max-w-[70%] gap-0.5 ${isOwn ? 'items-end' : 'items-start'}`}>
                  {!sameAsPrev && !isOwn && (
                    <span className="text-[11px] font-semibold text-white/60 px-2">{msg.displayName}</span>
                  )}
                  <div className={`flex items-center gap-1.5 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                    <div
                      className={`px-3.5 py-2 text-[13px] leading-[1.4] break-words rounded-[18px] ${isOwn ? 'text-white rounded-br-md' : 'text-ghost-text-primary rounded-bl-md'}`}
                      style={{ background: isOwn ? '#7C3AED' : 'rgba(255,255,255,0.08)' }}
                    >
                      {msg.text}
                    </div>
                    {isOwn && (
                      <button
                        onClick={() => deleteMessage(msg.id)}
                        title="Delete message"
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-white/40 hover:text-red-400 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {!sameAsPrev && (
                    <span className="text-[10px] text-white/30 px-2 mt-0.5">{fmtTime(msg.createdAt)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-4 pb-4 pt-2 shrink-0">
          <div className="flex items-center bg-white/[0.04] rounded-full border border-white/[0.08] pr-1">
            <input
              className="flex-1 min-w-0 bg-transparent text-[14px] text-ghost-text-primary placeholder:text-ghost-text-muted px-4 py-2.5 outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
              placeholder={`Message #${room.name.toLowerCase().replace(/\s+/g, '-')}…`}
              maxLength={2000}
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4C1D95 100%)' }}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Online members pane */}
      <div className="w-[220px] shrink-0 flex flex-col border-l border-white/[0.06] min-h-0">
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-[12px] font-bold text-white/55 uppercase tracking-wider">Online · {members.length}</h3>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-3 space-y-0.5">
          {members.length === 0 ? (
            <p className="px-3 py-4 text-[12px] text-white/30 italic text-center">Nobody else is here yet.</p>
          ) : members.map((m) => (
            <div key={m.userId} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors">
              <div className="relative shrink-0">
                <Avatar name={m.displayName} src={m.avatarUrl} size="sm" userId={m.userId} />
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-[9px] h-[9px] rounded-full"
                  style={{ background: '#22C55E', boxShadow: '0 0 0 1.5px #0A0412' }}
                />
              </div>
              <span className={`text-[13px] truncate ${m.userId === me?.id ? 'text-white font-semibold' : 'text-white/80'}`}>
                {m.displayName}{m.userId === me?.id ? ' (you)' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
