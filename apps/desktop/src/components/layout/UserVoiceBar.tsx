import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceStore } from '../../stores/voiceStore';
import Avatar from '../common/Avatar';

/**
 * Discord-style user-voice strip. Sits in the sidebar above the
 * storage bar. Shows the signed-in user's avatar + name + status,
 * with mic / headphones / settings controls on the right.
 *
 * Mic is auto-acquired the moment the user joins a project session
 * (handled inside useVoiceMic). Click the mic to mute / unmute.
 * Click the headphones to deafen — Discord behavior: deafening also
 * mutes the mic, un-deafening preserves the prior state.
 *
 * The settings gear is a stub pointer — opens the existing settings
 * popup in PluginLayout, which the parent wires through onSettings.
 */
export default function UserVoiceBar({ onSettings }: { onSettings?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const currentProjectId = useSessionStore((s) => s.currentProjectId);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const micError = useVoiceStore((s) => s.micError);
  const toggleMuted = useVoiceStore((s) => s.toggleMuted);
  const toggleDeafened = useVoiceStore((s) => s.toggleDeafened);

  const inSession = !!currentProjectId;
  const status = micError ? 'Mic blocked' : inSession ? 'In session' : 'Invisible';
  const points = user?.points ?? 0;
  const isPro = user?.tier === 'pro';
  const formattedPoints = points.toLocaleString();

  return (
    <div
      className="shrink-0 flex items-center gap-2 px-2 py-2"
      style={{
        background: 'rgba(0,0,0,0.25)',
        borderTop: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <Avatar name={user?.displayName || '?'} src={user?.avatarUrl} size="sm" />
      <div className="flex-1 min-w-0 leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-semibold text-white truncate" title={status}>
            {user?.displayName || 'Guest'}
          </span>
          {isPro && (
            <span
              className="shrink-0 px-1.5 py-[1px] rounded text-[8.5px] font-bold tracking-wide text-white"
              style={{
                background: 'linear-gradient(135deg, #a855f7 0%, #6d28d9 100%)',
                letterSpacing: '0.04em',
              }}
            >
              PRO
            </span>
          )}
        </div>
        <div className={`flex items-center gap-1 text-[10.5px] truncate ${micError ? 'text-red-400' : 'text-white/65'}`}>
          {micError ? (
            <span>{status}</span>
          ) : (
            <>
              {/* Coin glyph for the points balance — purple ring with a
                  inner highlight so it reads as a token, matching the
                  reference Discord-loyalty chip. */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="2.2">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4.5" stroke="#c084fc" strokeWidth="1.6" />
              </svg>
              <span className="tabular-nums font-medium text-white/85">{formattedPoints}</span>
            </>
          )}
        </div>
      </div>
      <button
        onClick={toggleMuted}
        title={muted ? 'Unmute mic' : 'Mute mic'}
        className={`shrink-0 w-7 h-7 flex items-center justify-center rounded transition-colors ${muted ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20' : 'text-white/65 hover:text-white hover:bg-white/[0.06]'}`}
      >
        {muted ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )}
      </button>
      <button
        onClick={toggleDeafened}
        title={deafened ? 'Undeafen' : 'Deafen'}
        className={`shrink-0 w-7 h-7 flex items-center justify-center rounded transition-colors ${deafened ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20' : 'text-white/65 hover:text-white hover:bg-white/[0.06]'}`}
      >
        {deafened ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M3 18v-6a9 9 0 0 1 14.16-7.36" />
            <path d="M21 12v6a2 2 0 0 1-2 2h-1v-7" />
            <path d="M5 19v-7a7 7 0 0 1 .55-2.74" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
          </svg>
        )}
      </button>
      <button
        onClick={onSettings}
        title="User settings"
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  );
}
