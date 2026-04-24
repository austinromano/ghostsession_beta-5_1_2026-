import { motion } from 'framer-motion';
import Avatar from '../common/Avatar';
import type { PresenceInfo, ProjectMember } from '@ghost/types';
import { useWebrtcStore } from '../../stores/webrtcStore';

interface Props {
  members: ProjectMember[];
  onlineUsers: PresenceInfo[];
  onInvite: () => void;
}

export default function CollaboratorsBar({ members, onlineUsers, onInvite }: Props) {
  const sorted = [...members].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0));
  const owners = sorted.filter((m) => m.role === 'owner');
  const speakingUserIds = useWebrtcStore((s) => s.speakingUserIds);

  return (
    <div className="mb-4">
      <div className="flex items-center gap-4 glass-subtle px-5 h-[68px]">
        <div className="flex items-center -space-x-2">
          {sorted.map((m) => {
            const isOnline = onlineUsers.some((u) => u.userId === m.userId);
            const isSpeaking = speakingUserIds.has(m.userId);
            return (
              <div
                key={m.userId}
                className="relative group cursor-pointer transition-transform hover:scale-105 hover:z-10"
                title={isSpeaking ? `${m.displayName} (speaking)` : m.displayName}
                style={{ border: '2.5px solid #0A0A0F', borderRadius: '50%' }}
              >
                {isSpeaking && (
                  <motion.span
                    className="absolute inset-[-4px] rounded-full pointer-events-none"
                    animate={{
                      boxShadow: [
                        '0 0 0 0 rgba(34,197,94,0.55)',
                        '0 0 0 6px rgba(34,197,94,0)',
                        '0 0 0 0 rgba(34,197,94,0.55)',
                      ],
                    }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                    style={{ border: '2px solid rgba(34,197,94,0.6)' }}
                  />
                )}
                <Avatar name={m.displayName || '?'} src={m.avatarUrl} size="lg" colour={m.role === 'owner' ? '#F0B232' : '#23A559'} userId={m.userId} />
                {isOnline && (
                  <span className="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full" style={{ background: '#23A559', border: '2.5px solid #0A0A0F' }} />
                )}
              </div>
            );
          })}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {owners.map((m) => (
              <span key={m.userId} className="flex items-center gap-1.5">
                <span className="text-[15px] font-semibold text-ghost-text-primary">{m.displayName}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white bg-[#5865F2] px-2 py-0.5 rounded-md">HOST</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {onlineUsers.length > 0 && (
              <motion.span
                className="w-2 h-2 rounded-full bg-[#23A559]"
                animate={{ boxShadow: ['0 0 0px rgba(35,165,89,0)', '0 0 8px rgba(35,165,89,0.6)', '0 0 0px rgba(35,165,89,0)'] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
            <span className="text-[13px] text-ghost-text-muted">
              {onlineUsers.length} collaborator{onlineUsers.length !== 1 ? 's' : ''} online
            </span>
          </div>
        </div>
        <motion.button
          onClick={onInvite}
          className="w-[120px] h-11 rounded-full text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-all shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.15)] hover:shadow-[0_0_20px_rgba(124,58,237,0.4),0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] shrink-0"
          style={{ background: 'linear-gradient(180deg, #7C3AED 0%, #581C87 100%)' }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
          </svg>
          Invite
        </motion.button>
      </div>
    </div>
  );
}
