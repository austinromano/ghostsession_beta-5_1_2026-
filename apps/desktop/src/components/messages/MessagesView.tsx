import { useEffect, useRef, useState, useMemo } from 'react';
import Avatar from '../common/Avatar';
import { useDmStore } from '../../stores/dmStore';
import { useAuthStore } from '../../stores/authStore';
import DmAudioBubble from './DmAudioBubble';
import MessagesCalendar from './MessagesCalendar';

interface Friend {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface Props {
  friends: Friend[];
}

const AUDIO_EXT_RE = /\.(wav|mp3|flac|aiff|ogg|m4a|aac)$/i;

function isAudioFile(f: File): boolean {
  return f.type.startsWith('audio/') || AUDIO_EXT_RE.test(f.name);
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtBubbleTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function previewLabel(lastText: string, lastHasAudio: boolean, lastFromMe: boolean): string {
  const prefix = lastFromMe ? 'You: ' : '';
  if (lastHasAudio && !lastText) return `${prefix}🎵 Audio`;
  if (lastHasAudio && lastText) return `${prefix}🎵 ${lastText}`;
  return `${prefix}${lastText}`;
}

export default function MessagesView({ friends }: Props) {
  const currentUser = useAuthStore((s) => s.user);
  const currentUserId = currentUser?.id;
  const {
    conversations, messagesByUser, activeUserId,
    bootstrap, openConversation, send, setActive,
  } = useDmStore();
  const [draft, setDraft] = useState('');
  const [pendingAudio, setPendingAudio] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!currentUserId) return;
    const cleanup = bootstrap(currentUserId);
    return cleanup;
  }, [currentUserId]);

  const activeMessages = activeUserId ? (messagesByUser.get(activeUserId) || []) : [];
  const activeFriend = useMemo(() => {
    if (!activeUserId) return null;
    const conv = conversations.find((c) => c.userId === activeUserId);
    if (conv) return { id: conv.userId, displayName: conv.displayName, avatarUrl: conv.avatarUrl };
    const f = friends.find((f) => f.id === activeUserId);
    return f ? { id: f.id, displayName: f.displayName, avatarUrl: f.avatarUrl } : null;
  }, [activeUserId, conversations, friends]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [activeMessages.length, activeUserId]);

  useEffect(() => {
    // Reset pending attachment when switching conversations.
    setPendingAudio(null);
    setDraft('');
    setError('');
  }, [activeUserId]);

  const sidebarEntries = useMemo(() => {
    const seen = new Set(conversations.map((c) => c.userId));
    const extraFriends = friends
      .filter((f) => !seen.has(f.id) && f.id !== currentUserId)
      .map((f) => ({
        userId: f.id,
        displayName: f.displayName,
        avatarUrl: f.avatarUrl,
        lastText: '',
        lastAt: '',
        lastFromMe: false,
        lastHasAudio: false,
        unread: 0,
      }));
    return [...conversations, ...extraFriends];
  }, [conversations, friends, currentUserId]);

  const pickFile = () => fileInputRef.current?.click();

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    const audio = list.find(isAudioFile);
    if (!audio) {
      setError('Only audio files are supported (wav, mp3, flac, aiff, ogg, m4a, aac)');
      setTimeout(() => setError(''), 3000);
      return;
    }
    if (audio.size > 50 * 1024 * 1024) {
      setError('File too large (50MB max)');
      setTimeout(() => setError(''), 3000);
      return;
    }
    setPendingAudio(audio);
    setError('');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleSend = async () => {
    if (!activeUserId || sending) return;
    const text = draft.trim();
    if (!text && !pendingAudio) return;
    setSending(true);
    try {
      await send(activeUserId, { text: text || undefined, audioFile: pendingAudio || undefined });
      setDraft('');
      setPendingAudio(null);
    } catch (err: any) {
      setError(err?.message || 'Send failed');
      setTimeout(() => setError(''), 3000);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden rounded-2xl glass glass-glow">
      {/* Left column */}
      <div className="w-[260px] shrink-0 flex flex-col border-r border-white/[0.06] min-h-0">
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-[17px] font-bold text-white tracking-tight">Messages</h2>
          <p className="text-[12px] text-white/40 mt-0.5">Direct producer chats</p>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 px-2">
          {sidebarEntries.length === 0 && (
            <p className="px-3 py-6 text-[13px] text-white/40 italic text-center">
              Add friends to start a conversation.
            </p>
          )}
          {sidebarEntries.map((c) => {
            const isActive = c.userId === activeUserId;
            return (
              <button
                key={c.userId}
                onClick={() => { setActive(c.userId); openConversation(c.userId); }}
                className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg transition-colors text-left mb-0.5 ${
                  isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
                }`}
              >
                <div className="shrink-0 relative">
                  <Avatar name={c.displayName} src={c.avatarUrl} size="sm" />
                  {c.unread > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                      {c.unread > 9 ? '9+' : c.unread}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className={`text-[13px] font-semibold truncate ${isActive ? 'text-white' : 'text-white/80'}`}>
                      {c.displayName}
                    </span>
                    {c.lastAt && <span className="text-[10px] text-white/30 shrink-0">{fmtDay(c.lastAt)}</span>}
                  </div>
                  <div className="text-[12px] text-white/40 truncate mt-0.5">
                    {c.lastText || c.lastHasAudio ? previewLabel(c.lastText, c.lastHasAudio, c.lastFromMe) : <span className="italic">Say hi</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right column */}
      <div
        className="flex-1 flex flex-col min-w-0 min-h-0 relative"
        onDragOver={(e) => { if (activeFriend) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {activeFriend ? (
          <>
            <div className="px-5 py-3 border-b border-white/[0.06] flex items-center gap-3 shrink-0">
              <Avatar name={activeFriend.displayName} src={activeFriend.avatarUrl} size="sm" />
              <div className="min-w-0">
                <div className="text-[14px] font-bold text-white truncate">{activeFriend.displayName}</div>
                <div className="text-[11px] text-white/40">Direct message</div>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 min-h-0">
              {activeMessages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-center">
                  <div>
                    <p className="text-[14px] font-semibold text-white/70 mb-1">No messages yet</p>
                    <p className="text-[12px] text-white/40">Send the first message — drag an audio file in to attach.</p>
                  </div>
                </div>
              ) : activeMessages.map((msg, idx) => {
                const isOwn = msg.fromUserId === currentUserId;
                const prev = idx > 0 ? activeMessages[idx - 1] : null;
                const sameAsPrev = prev && prev.fromUserId === msg.fromUserId
                  && (Date.parse(msg.createdAt) - Date.parse(prev.createdAt)) < 5 * 60 * 1000;
                return (
                  <div key={msg.id} className={`flex items-end gap-2 ${isOwn ? 'justify-end' : 'justify-start'} ${sameAsPrev ? 'mt-0.5' : 'mt-3'}`}>
                    {!isOwn && (
                      <div className={`shrink-0 w-8 ${sameAsPrev ? 'invisible' : ''}`}>
                        <Avatar name={activeFriend.displayName} src={activeFriend.avatarUrl} size="sm" />
                      </div>
                    )}
                    <div className={`flex flex-col max-w-[70%] gap-1 ${isOwn ? 'items-end' : 'items-start'}`}>
                      {msg.audioFileId && (
                        <DmAudioBubble fileId={msg.audioFileId} fileName={msg.audioFileName || 'audio.wav'} isOwn={isOwn} />
                      )}
                      {msg.text && (
                        <div
                          className={`px-3.5 py-2 text-[13px] leading-[1.4] break-words rounded-[18px] ${
                            isOwn ? 'text-white rounded-br-md' : 'text-ghost-text-primary rounded-bl-md'
                          }`}
                          style={{ background: isOwn ? '#7C3AED' : 'rgba(255,255,255,0.08)' }}
                        >
                          {msg.text}
                        </div>
                      )}
                      {!sameAsPrev && (
                        <span className="text-[10px] text-white/30 mt-1 px-2">{fmtBubbleTime(msg.createdAt)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pending attachment preview */}
            {pendingAudio && (
              <div className="mx-4 mb-2 px-3 py-2 rounded-xl flex items-center gap-3 shrink-0" style={{ background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-white truncate">{pendingAudio.name}</div>
                  <div className="text-[11px] text-white/40">{(pendingAudio.size / (1024 * 1024)).toFixed(1)} MB · ready to send</div>
                </div>
                <button onClick={() => setPendingAudio(null)} className="shrink-0 text-white/40 hover:text-white transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
            )}

            {error && (
              <div className="mx-4 mb-2 px-3 py-2 rounded-lg text-[12px] text-red-300 shrink-0" style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}>
                {error}
              </div>
            )}

            <div className="px-4 pb-4 pt-2 shrink-0">
              <div className="flex items-center bg-white/[0.04] rounded-full border border-white/[0.08] pr-1">
                <button
                  onClick={pickFile}
                  title="Attach audio"
                  className="shrink-0 w-10 h-10 flex items-center justify-center text-white/50 hover:text-ghost-green transition-colors"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.wav,.mp3,.flac,.aiff,.ogg,.m4a,.aac"
                  className="hidden"
                  onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
                />
                <input
                  className="flex-1 min-w-0 bg-transparent text-[14px] text-ghost-text-primary placeholder:text-ghost-text-muted px-2 py-2.5 outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                  placeholder={pendingAudio ? 'Add a caption (optional)...' : `Message ${activeFriend.displayName}...`}
                />
                <button
                  onClick={handleSend}
                  disabled={sending || (!draft.trim() && !pendingAudio)}
                  className="shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                  style={{ background: 'linear-gradient(135deg, #7C3AED 0%, #4C1D95 100%)' }}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </div>
              <p className="text-[10px] text-white/25 mt-2 text-center">
                Drag audio files anywhere in this pane to attach
              </p>
            </div>

            {/* Drag-over overlay */}
            {dragOver && (
              <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none" style={{ background: 'rgba(10,4,18,0.7)', backdropFilter: 'blur(4px)' }}>
                <div className="px-8 py-6 rounded-2xl border-2 border-dashed border-ghost-green/60 text-center" style={{ background: 'rgba(0,255,200,0.08)' }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#00FFC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="text-[15px] font-bold text-white">Drop audio to attach</p>
                  <p className="text-[12px] text-white/50 mt-0.5">wav, mp3, flac, aiff, ogg, m4a, aac</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center px-8">
            <div className="text-center max-w-sm">
              <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center mx-auto mb-4">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </div>
              <h3 className="text-[18px] font-bold text-white mb-1.5">Your messages</h3>
              <p className="text-[13px] text-white/50 leading-[1.5]">
                Pick a friend on the left to start a direct conversation — you can drag audio files straight into the thread.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Right column — Calendar (its own section) */}
      <div className="w-[280px] shrink-0 flex flex-col border-l border-white/[0.06] min-h-0">
        <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <h2 className="text-[15px] font-bold text-white tracking-tight">Calendar</h2>
          <p className="text-[11px] text-white/40 mt-0.5">Plan sessions together</p>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <MessagesCalendar />
        </div>
      </div>
    </div>
  );
}
