import { create } from 'zustand';
import type { PresenceInfo, ChatMessage, CursorPosition } from '@ghost/types';
import { getSocket, joinProject, leaveProject, sendChat, sendSessionAction, deleteChatMessage } from '../lib/socket';
import { api } from '../lib/api';
import { useAuthStore } from './authStore';
import { useProjectStore } from './projectStore';
import { useDrumRack, getDrumSyncSnapshot } from './drumRackStore';

interface SessionState {
  isConnected: boolean;
  onlineUsers: PresenceInfo[];
  chatMessages: ChatMessage[];
  remoteCursors: Map<string, CursorPosition>;
  currentProjectId: string | null;

  join: (projectId: string) => void;
  leave: () => void;
  sendAction: (action: any) => void;
  sendMessage: (text: string) => void;
  deleteMessage: (index: number) => void;
}

// Stored references so we can remove on leave
let reconnectHandler: (() => void) | null = null;
let chatPollTimer: ReturnType<typeof setInterval> | null = null;

export const useSessionStore = create<SessionState>((set, get) => ({
  isConnected: false,
  onlineUsers: [],
  chatMessages: [],
  remoteCursors: new Map(),
  currentProjectId: null,

  join: (projectId) => {
    const socket = getSocket();
    if (!socket) return;

    // Clean up any existing listeners to prevent stacking
    if (reconnectHandler) {
      socket.off('connect', reconnectHandler);
      reconnectHandler = null;
    }
    socket.off('presence-update');
    socket.off('user-joined');
    socket.off('user-left');
    socket.off('chat-message');
    socket.off('delete-chat-message');
    socket.off('project-updated');
    socket.off('cursor-move');
    socket.off('session-action');

    joinProject(projectId);
    set({ currentProjectId: projectId, isConnected: true });

    // Load persisted chat history, merging with any real-time messages that arrived first
    api.getChatHistory(projectId).then((history) => {
      set((s) => {
        // Keep any real-time messages that arrived after the last history message
        const lastHistoryTs = history.length > 0 ? history[history.length - 1].timestamp : 0;
        const newMessages = s.chatMessages.filter((m) => m.timestamp > lastHistoryTs);
        return { chatMessages: [...history, ...newMessages] };
      });
    }).catch((err) => { if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) console.warn('[sessionStore] chat fetch failed:', err); });

    // Re-join room on reconnect (server creates a new socket, so room membership is lost)
    reconnectHandler = () => {
      const pid = get().currentProjectId;
      if (pid) joinProject(pid);
    };
    socket.on('connect', reconnectHandler);

    socket.on('presence-update', ({ users }) => {
      set({ onlineUsers: users });
    });

    socket.on('user-joined', ({ userId, displayName, colour, avatarUrl }) => {
      set((s) => ({
        onlineUsers: [...s.onlineUsers.filter((u) => u.userId !== userId), {
          userId, displayName, colour, avatarUrl, isOnline: true, lastSeen: new Date().toISOString(),
        }],
      }));
    });

    socket.on('user-left', ({ userId }) => {
      set((s) => {
        const next = new Map(s.remoteCursors);
        next.delete(userId);
        return { onlineUsers: s.onlineUsers.filter((u) => u.userId !== userId), remoteCursors: next };
      });
    });

    socket.on('cursor-move', ({ userId, displayName, colour, x, y }) => {
      set((s) => {
        const next = new Map(s.remoteCursors);
        next.set(userId, { userId, displayName, colour, x, y, timestamp: Date.now() });
        return { remoteCursors: next };
      });
    });

    socket.on('chat-message', (msg) => {
      set((s) => {
        // Deduplicate: replace optimistic local message or skip if already present
        const isDupe = s.chatMessages.some(
          (m) => (m.id && m.id === msg.id) ||
                 (m.userId === msg.userId && m.text === msg.text && Math.abs(m.timestamp - msg.timestamp) < 3000)
        );
        if (isDupe) {
          // Replace the optimistic message with the server-confirmed one
          return {
            chatMessages: s.chatMessages.map((m) =>
              m.userId === msg.userId && m.text === msg.text && (m.id?.startsWith('local-') || Math.abs(m.timestamp - msg.timestamp) < 3000)
                ? msg
                : m
            ),
          };
        }
        return { chatMessages: [...s.chatMessages, msg] };
      });
    });

    socket.on('delete-chat-message', ({ timestamp }) => {
      set((s) => ({ chatMessages: s.chatMessages.filter((m) => m.timestamp !== timestamp) }));
    });

    socket.on('project-updated', (data) => {
      const pid = get().currentProjectId;
      if (pid && data.projectId === pid) {
        useProjectStore.getState().fetchProject(pid);
        useProjectStore.getState().fetchVersions(pid);
      }
    });

    // Multiplayer drum-rack: drum.state snapshots flow through the generic
    // session-action envelope. drum.request-state lets a fresh joiner ask
    // the room for the current rack so they don't start blank.
    socket.on('session-action', ({ action }) => {
      const a = action as { type?: string; payload?: any } | undefined;
      if (!a || typeof a.type !== 'string') return;
      if (a.type === 'drum.state' && a.payload) {
        void useDrumRack.getState().applyRemoteState(a.payload);
      } else if (a.type === 'drum.request-state') {
        const snap = getDrumSyncSnapshot();
        const pid = get().currentProjectId;
        if (snap && pid) {
          sendSessionAction(pid, { type: 'drum.state', payload: snap });
        }
      }
    });

    // Lightweight arrangement patch — avoid the full project refetch. Just
    // splice the new blob into currentProject so TransportBar's live-sync
    // effect picks it up and applies it.
    socket.on('arrangement-updated', (data) => {
      const pid = get().currentProjectId;
      if (!pid || data.projectId !== pid) return;
      const store = useProjectStore.getState();
      const cur = store.currentProject;
      if (!cur || cur.id !== pid) return;
      useProjectStore.setState({
        currentProject: { ...cur, arrangementJson: data.arrangementJson },
      });
    });

    // Polling fallback: fetch new chat messages periodically in case
    // socket.io broadcasts are missed (e.g. inside plugin WebView)
    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = setInterval(() => {
      const pid = get().currentProjectId;
      if (!pid) return;
      api.getChatHistory(pid).then((history) => {
        set((s) => {
          if (history.length <= s.chatMessages.filter((m) => !m.id?.startsWith('local-')).length) return s;
          // Merge: keep confirmed messages from history, preserve any unsent optimistic ones
          const optimistic = s.chatMessages.filter((m) => m.id?.startsWith('local-'));
          const merged = [...history];
          for (const opt of optimistic) {
            const matched = history.some(
              (h) => h.userId === opt.userId && h.text === opt.text && Math.abs(h.timestamp - opt.timestamp) < 5000
            );
            if (!matched) merged.push(opt);
          }
          return { chatMessages: merged };
        });
      }).catch((err) => { if (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) console.warn('[sessionStore] chat fetch failed:', err); });
    }, 30000);
  },

  leave: () => {
    const { currentProjectId } = get();
    if (currentProjectId) leaveProject(currentProjectId);

    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }

    const socket = getSocket();
    if (reconnectHandler) {
      socket?.off('connect', reconnectHandler);
      reconnectHandler = null;
    }
    socket?.off('presence-update');
    socket?.off('user-joined');
    socket?.off('user-left');
    socket?.off('chat-message');
    socket?.off('delete-chat-message');
    socket?.off('project-updated');
    socket?.off('cursor-move');
    socket?.off('session-action');

    set({ currentProjectId: null, isConnected: false, onlineUsers: [], chatMessages: [], remoteCursors: new Map() });
  },

  sendAction: (action) => {
    const { currentProjectId } = get();
    if (currentProjectId) sendSessionAction(currentProjectId, action);
  },

  sendMessage: (text) => {
    const { currentProjectId } = get();
    if (!currentProjectId) return;

    // Optimistically add own message so it appears immediately
    const user = useAuthStore.getState().user;
    const optimisticMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      userId: user?.id || '',
      displayName: (user as any)?.displayName || (user as any)?.name || 'You',
      colour: '#8B5CF6',
      avatarUrl: (user as any)?.avatarUrl ?? null,
      text,
      timestamp: Date.now(),
    };
    set((s) => ({ chatMessages: [...s.chatMessages, optimisticMsg] }));

    sendChat(currentProjectId, text);
  },

  deleteMessage: (index) => {
    const { currentProjectId, chatMessages } = get();
    const msg = chatMessages[index];
    if (msg && currentProjectId) {
      deleteChatMessage(currentProjectId, msg.timestamp);
    }
  },
}));
