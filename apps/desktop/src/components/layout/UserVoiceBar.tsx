import { useEffect, useRef, useState } from 'react';
import { animate, motion } from 'framer-motion';
import { useAuthStore } from '../../stores/authStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useVoiceStore } from '../../stores/voiceStore';
import Avatar from '../common/Avatar';

// Demo placeholder so the points chip reads as a real loyalty
// balance instead of "0" while the earning rules are still being
// designed. Falls back to the user's actual points the moment the
// real value goes non-zero, so production data takes over with no
// code change required. Numbers tuned so the level-progress bar
// renders mid-tier — visually rich, not empty.
const FAKE_POINTS = 1250;
const TIER_NEXT = 2000;
const TIER_PREV = 1000;

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
  const realPoints = user?.points ?? 0;
  const targetPoints = realPoints > 0 ? realPoints : FAKE_POINTS;
  const isPro = user?.tier === 'pro';

  // Animated count-up. Tween from the previously-displayed value to
  // the new target so subsequent point awards feel like the balance
  // is *earning*, not jumping. First mount counts up from 0 — gives
  // the chip a "loading in" feel on app launch.
  const prevRef = useRef(0);
  const [displayPoints, setDisplayPoints] = useState(0);
  useEffect(() => {
    const ctrl = animate(prevRef.current, targetPoints, {
      duration: 1.6,
      ease: [0.22, 0.9, 0.3, 1],
      onUpdate: (v) => setDisplayPoints(Math.round(v)),
      onComplete: () => { prevRef.current = targetPoints; },
    });
    return () => ctrl.stop();
  }, [targetPoints]);
  const formattedPoints = displayPoints.toLocaleString();
  const tierProgress = Math.max(0, Math.min(1, (displayPoints - TIER_PREV) / (TIER_NEXT - TIER_PREV)));

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
        {micError ? (
          <div className="flex items-center text-[10.5px] text-red-400 truncate">
            <span>{status}</span>
          </div>
        ) : (
          <PointsChip
            points={displayPoints}
            formatted={formattedPoints}
            progress={tierProgress}
          />
        )}
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

// Loyalty / points chip. Reads under the username in the voice strip.
//
// Three motion layers compose the "alive" feel:
//   1. The coin glyph itself breathes (1.0 → 1.06 → 1.0 scale loop) so
//      the chip stays subtly animated even at rest.
//   2. A faint glow ring behind the coin pulses on the same cadence
//      with a phase offset, making the breathing read as light coming
//      from the coin rather than the coin moving.
//   3. The points number is an animated count-up driven by Framer
//      Motion's `animate(...)` in the parent, and its colour fills via
//      a gradient so the digits don't read flat against the dark bar.
//
// Tier progress bar underneath shows how far the user is between the
// previous and next tier breakpoints. Width animates with a spring so
// any +X award reads as the bar advancing.
function PointsChip({ points: _points, formatted, progress }: {
  points: number;
  formatted: string;
  progress: number;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="relative shrink-0" style={{ width: 22, height: 22 }}>
        {/* Soft outer glow — sits behind the coin and pulses on its
            own loop so the rim reads as light, not motion. */}
        <motion.div
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(168,85,247,0.55) 0%, rgba(168,85,247,0) 70%)',
            filter: 'blur(2px)',
          }}
          animate={{ opacity: [0.35, 0.85, 0.35], scale: [0.95, 1.18, 0.95] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.svg
          width="22" height="22" viewBox="0 0 24 24"
          className="relative"
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))' }}
        >
          <defs>
            <linearGradient id="userPointsCoinFace" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#f5d0fe" />
              <stop offset="45%" stopColor="#a855f7" />
              <stop offset="100%" stopColor="#581c87" />
            </linearGradient>
            <radialGradient id="userPointsCoinGloss" cx="0.32" cy="0.28" r="0.45">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="12" cy="12" r="10" fill="url(#userPointsCoinFace)" />
          <circle cx="12" cy="12" r="10" fill="url(#userPointsCoinGloss)" />
          <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="0.8" />
          <circle cx="12" cy="12" r="6.5" fill="none" stroke="rgba(255,255,255,0.30)" strokeWidth="0.6" />
          {/* Ghost "G" glyph — keeps the coin on-brand instead of a
              generic dot. Y offset tuned so the cap height sits on
              the optical centre. */}
          <text
            x="12" y="16"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fontSize="12"
            fontWeight="900"
            fill="#ffffff"
            style={{ filter: 'drop-shadow(0 1px 1px rgba(76,29,149,0.8))' }}
          >
            G
          </text>
        </motion.svg>
      </div>
      <div className="min-w-0 flex-1 leading-none">
        <span
          className="text-[14px] tabular-nums font-bold tracking-tight"
          style={{
            background: 'linear-gradient(135deg, #ffffff 0%, #e9d5ff 60%, #c084fc 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            color: 'transparent',
            letterSpacing: '-0.01em',
          }}
        >
          {formatted}
        </span>
        {/* Tier-progress sliver. Springs to its width so any award
            visually advances the bar. Opacity is just-there so it
            reads as a hint, not chrome. */}
        <div
          className="mt-[3px] h-[2px] rounded-full overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.06)', maxWidth: 100 }}
        >
          <motion.div
            className="h-full rounded-full"
            style={{
              background: 'linear-gradient(90deg, #a855f7 0%, #d8b4fe 100%)',
              boxShadow: '0 0 6px rgba(168,85,247,0.6)',
            }}
            initial={false}
            animate={{ width: `${Math.round(progress * 100)}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 22 }}
          />
        </div>
      </div>
    </div>
  );
}
