import { Server as SocketServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '@ghost/protocol';
import { validateSession } from '../services/auth.js';
import { registerSessionHandlers } from './session.js';
import { registerPresenceHandlers } from './presence.js';
import { registerChatHandlers } from './chat.js';
import { registerWebRTCHandlers } from './webrtc.js';
import { registerCursorHandlers } from './cursor.js';
import { registerCommunityHandlers } from './community.js';

// Collaborator colour palette
const COLLAB_COLOURS = [
  '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6',
  '#E91E63', '#F1C40F', '#E67E22', '#E74C3C',
  '#00BCD4', '#FF6B6B', '#A29BFE', '#FD79A8',
  '#00CEC9', '#6C5CE7', '#FDCB6E', '#55EFC4',
];

/** Deterministic colour based on user ID */
export function userColour(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return COLLAB_COLOURS[Math.abs(hash) % COLLAB_COLOURS.length];
}

export function setupWebSocket(httpServer: HTTPServer) {
  const io = new SocketServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware for Socket.IO
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const user = await validateSession(token);
    if (!user) {
      return next(new Error('Invalid token'));
    }

    socket.data.userId = user.id;
    socket.data.displayName = user.displayName;
    socket.data.colour = userColour(user.id);
    socket.data.avatarUrl = user.avatarUrl || null;
    next();
  });

  // Track globally online users with activity
  const globalOnline = new Map<string, { userId: string; displayName: string; currentProjectId: string | null; currentProjectName: string | null }>();

  function broadcastOnlineUsers() {
    const list = Array.from(globalOnline.values());
    io.emit('global:online-users', list);
  }

  io.on('connection', (socket) => {
    console.log(`[WS] ${socket.data.displayName} connected`);

    // Personal room for DMs and any other user-targeted events.
    socket.join(`user:${socket.data.userId}`);

    globalOnline.set(socket.data.userId, { userId: socket.data.userId, displayName: socket.data.displayName, currentProjectId: null, currentProjectName: null });
    broadcastOnlineUsers();

    registerSessionHandlers(io, socket);
    registerPresenceHandlers(io, socket, globalOnline, broadcastOnlineUsers);
    registerChatHandlers(io, socket);
    registerWebRTCHandlers(io, socket);
    registerCursorHandlers(io, socket);
    registerCommunityHandlers(io, socket);

    socket.on('disconnect', () => {
      console.log(`[WS] ${socket.data.displayName} disconnected`);
      globalOnline.delete(socket.data.userId);
      broadcastOnlineUsers();
    });
  });

  ioInstance = io;
  return io;
}

let ioInstance: SocketServer | null = null;

export function getIO() {
  return ioInstance;
}

/** Emit project-updated to all clients in a project room */
export function emitProjectUpdated(projectId: string, reason: 'track-added' | 'track-updated' | 'track-deleted' | 'version-created' | 'metadata-updated' | 'member-changed') {
  ioInstance?.to(`project:${projectId}`).emit('project-updated', { projectId, reason });
}

/** Emit a direct message to a specific user's personal room (all their open tabs). */
export function emitDm(userId: string, msg: { id: string; fromUserId: string; toUserId: string; text: string; read: boolean; createdAt: string }) {
  ioInstance?.to(`user:${userId}`).emit('dm-received', msg);
}

/** Notify both participants of a booking change (create/update/delete). */
export function emitBookingUpdated(userIds: string[], kind: 'created' | 'updated' | 'deleted', bookingId: string, booking?: unknown) {
  for (const uid of userIds) {
    ioInstance?.to(`user:${uid}`).emit('booking-updated', { kind, bookingId, booking });
  }
}

/** Broadcast an arrangement change to every socket in a project room,
 *  carrying just the JSON blob so clients avoid a full project refetch. */
export function emitArrangementUpdated(projectId: string, arrangementJson: string | null) {
  ioInstance?.to(`project:${projectId}`).emit('arrangement-updated', { projectId, arrangementJson });
}

/** Comment thread events — broadcast to everyone in the project room so a
 *  newly-dropped pin appears for collaborators without a refetch. */
export function emitCommentAdded(projectId: string, comment: unknown) {
  ioInstance?.to(`project:${projectId}`).emit('comment-added', { projectId, comment });
}
export function emitCommentDeleted(projectId: string, commentId: string) {
  ioInstance?.to(`project:${projectId}`).emit('comment-deleted', { projectId, commentId });
}
export function emitCommentUpdated(projectId: string, comment: unknown) {
  ioInstance?.to(`project:${projectId}`).emit('comment-updated', { projectId, comment });
}
