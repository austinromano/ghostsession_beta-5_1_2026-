import type { SessionAction, PresenceInfo } from '@ghost/types';

export type StreamType = 'camera' | 'screen';

// ── Client → Server ──────────────────────────────────────────────────

export interface OnlineUser {
  userId: string;
  displayName: string;
  currentProjectId: string | null;
  currentProjectName: string | null;
}

export interface ChatMessagePayload {
  id?: string;
  userId: string;
  displayName: string;
  colour: string;
  text: string;
  timestamp: number;
  avatarUrl?: string | null;
}

export interface ClientToServerEvents {
  'join-project': (data: { projectId: string }) => void;
  'leave-project': (data: { projectId: string }) => void;
  'session-action': (data: {
    projectId: string;
    action: SessionAction;
  }) => void;
  'transport-sync': (data: {
    projectId: string;
    beatPosition: number;
  }) => void;
  'chat-message': (data: {
    projectId: string;
    text: string;
  }) => void;
  'delete-chat-message': (data: {
    projectId: string;
    timestamp: number;
    messageId?: string;
  }) => void;
  'webrtc-offer': (data: {
    projectId: string;
    targetUserId: string;
    offer: RTCSessionDescriptionInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-answer': (data: {
    projectId: string;
    targetUserId: string;
    answer: RTCSessionDescriptionInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-ice-candidate': (data: {
    projectId: string;
    targetUserId: string;
    candidate: RTCIceCandidateInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-leave': (data: {
    projectId: string;
    streamType?: StreamType;
  }) => void;
  'cursor-move': (data: {
    projectId: string;
    x: number;
    y: number;
  }) => void;
  'community:join': (data: { roomId: string }) => void;
  'community:leave': (data: { roomId: string }) => void;
  'community:send': (data: { roomId: string; text?: string; audioFileId?: string; audioFileName?: string }) => void;
  'community:delete': (data: { roomId: string; messageId: string }) => void;
  // Live per-user transport tick — client emits at ~10 Hz while playing so
  // collaborators see a ghost playhead following them.
  'transport:tick': (data: { projectId: string; currentTime: number; isPlaying: boolean }) => void;
  // Live clip drag: non-null liveOffset streams while the pointer is down;
  // emit one final event with liveOffset:null on pointer-up to clear.
  'clip:drag': (data: { projectId: string; trackId: string; liveOffset: number | null }) => void;
}

// ── Server → Client ──────────────────────────────────────────────────

export interface ServerToClientEvents {
  'session-action': (data: {
    action: SessionAction;
  }) => void;
  'session-state-sync': (data: {
    projectId: string;
    state: Record<string, unknown>;
  }) => void;
  'transport-sync': (data: {
    beatPosition: number;
    serverTimestamp: number;
  }) => void;
  'presence-update': (data: {
    users: PresenceInfo[];
  }) => void;
  'chat-message': (data: ChatMessagePayload) => void;
  'delete-chat-message': (data: {
    timestamp: number;
    messageId?: string;
  }) => void;
  'global:online-users': (users: OnlineUser[]) => void;
  'user-joined': (data: {
    userId: string;
    displayName: string;
    colour: string;
    avatarUrl?: string | null;
  }) => void;
  'user-left': (data: {
    userId: string;
  }) => void;
  'webrtc-offer': (data: {
    fromUserId: string;
    offer: RTCSessionDescriptionInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-answer': (data: {
    fromUserId: string;
    answer: RTCSessionDescriptionInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-ice-candidate': (data: {
    fromUserId: string;
    candidate: RTCIceCandidateInit;
    streamType?: StreamType;
  }) => void;
  'webrtc-user-left': (data: {
    userId: string;
    streamType?: StreamType;
  }) => void;
  'project-updated': (data: {
    projectId: string;
    reason: 'track-added' | 'track-updated' | 'track-deleted' | 'version-created' | 'metadata-updated' | 'member-changed';
  }) => void;
  'dm-received': (data: {
    id: string;
    fromUserId: string;
    toUserId: string;
    text: string;
    audioFileId?: string | null;
    audioFileName?: string | null;
    read: boolean;
    createdAt: string;
  }) => void;
  'booking-updated': (data: {
    kind: 'created' | 'updated' | 'deleted';
    bookingId: string;
    booking?: unknown; // Full Booking object from API (with hydrated creator/invitee). Omitted on delete.
  }) => void;
  'community:presence': (data: {
    roomId: string;
    members: Array<{ userId: string; displayName: string; avatarUrl: string | null }>;
  }) => void;
  'community:message': (data: {
    id: string;
    roomId: string;
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    text: string;
    audioFileId?: string | null;
    audioFileName?: string | null;
    createdAt: string;
  }) => void;
  'community:message-deleted': (data: { roomId: string; messageId: string }) => void;
  // Lightweight arrangement broadcast — carries just the new JSON blob so
  // clients can patch their local state without refetching the entire
  // project detail (which includes peaks and can be 200-400 KB per track).
  'arrangement-updated': (data: { projectId: string; arrangementJson: string | null }) => void;
  // Timeline-positioned comment events. Carries the full comment row so the
  // client can patch state without refetching the comment list.
  'comment-added': (data: { projectId: string; comment: unknown }) => void;
  'comment-updated': (data: { projectId: string; comment: unknown }) => void;
  'comment-deleted': (data: { projectId: string; commentId: string }) => void;
  'transport:remote-tick': (data: {
    projectId: string;
    userId: string;
    displayName: string;
    colour: string;
    currentTime: number;
    isPlaying: boolean;
  }) => void;
  'clip:remote-drag': (data: {
    projectId: string;
    userId: string;
    displayName: string;
    colour: string;
    trackId: string;
    liveOffset: number | null;
  }) => void;
  'cursor-move': (data: {
    userId: string;
    displayName: string;
    colour: string;
    x: number;
    y: number;
  }) => void;
  'error': (data: {
    message: string;
  }) => void;
}

// ── Socket data attached to each connection ──────────────────────────

export interface SocketData {
  userId: string;
  displayName: string;
  colour: string;
  avatarUrl: string | null;
}
