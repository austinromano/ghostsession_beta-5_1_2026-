import type {
  ApiResponse, AuthResponse, LoginRequest, RegisterRequest,
  CreateProjectRequest, AddTrackRequest, CreateVersionRequest, AddCommentRequest,
  Project, ProjectDetail, Track, Version, Comment, User,
} from '@ghost/types';

import { API_BASE } from './constants';

const BASE_URL = API_BASE;

let authToken: string | null = null;

export function setToken(token: string | null) {
  authToken = token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

export const api = {
  // Auth
  login: (data: LoginRequest) => request<AuthResponse>('POST', '/auth/login', data),
  register: (data: RegisterRequest) => request<AuthResponse>('POST', '/auth/register', data),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<User>('GET', '/auth/me'),
  addPoints: (delta: number) => request<{ points: number }>('POST', '/auth/me/points', { delta }),
  deleteAccount: () => request<void>('DELETE', '/auth/account'),
  uploadAvatar: async (file: File): Promise<{ avatarUrl: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/auth/avatar`, {
      method: 'POST', headers, body: formData,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    return json.data;
  },

  // Projects
  listProjects: () => request<Project[]>('GET', '/projects'),
  createProject: (data: CreateProjectRequest) => request<Project>('POST', '/projects', data),
  getProject: (id: string) => request<ProjectDetail>('GET', `/projects/${id}`),
  updateProject: (id: string, data: Partial<CreateProjectRequest>) =>
    request<Project>('PATCH', `/projects/${id}`, data),
  deleteProject: (id: string) => request<void>('DELETE', `/projects/${id}`),
  inviteMember: (id: string, email: string, name?: string, role = 'editor') =>
    request<void>('POST', `/projects/${id}/members`, { email: email || undefined, name: name || undefined, role }),
  removeMember: (id: string, userId: string) =>
    request<void>('DELETE', `/projects/${id}/members/${userId}`),
  leaveProject: (id: string) =>
    request<void>('POST', `/projects/${id}/leave`),

  // Chat
  getChatHistory: (projectId: string) =>
    request<{ userId: string; displayName: string; colour: string; text: string; timestamp: number }[]>('GET', `/projects/${projectId}/chat`),

  // Tracks
  listTracks: (projectId: string) => request<Track[]>('GET', `/projects/${projectId}/tracks`),
  addTrack: (projectId: string, data: AddTrackRequest) =>
    request<Track>('POST', `/projects/${projectId}/tracks`, data),
  updateTrack: (projectId: string, trackId: string, data: Partial<Track>) =>
    request<Track>('PATCH', `/projects/${projectId}/tracks/${trackId}`, data),
  deleteTrack: (projectId: string, trackId: string) =>
    request<void>('DELETE', `/projects/${projectId}/tracks/${trackId}`),
  reorderTracks: (projectId: string, trackIds: string[]) =>
    request<void>('PUT', `/projects/${projectId}/tracks/reorder`, { trackIds }),

  // Versions
  listVersions: (projectId: string) => request<Version[]>('GET', `/projects/${projectId}/versions`),
  createVersion: (projectId: string, data: CreateVersionRequest) =>
    request<Version>('POST', `/projects/${projectId}/versions`, data),
  revertToVersion: (projectId: string, versionId: string) =>
    request<{ message: string }>('POST', `/projects/${projectId}/versions/${versionId}/revert`),

  // Comments
  listComments: (projectId: string) => request<Comment[]>('GET', `/projects/${projectId}/comments`),
  addComment: (projectId: string, data: AddCommentRequest) =>
    request<Comment>('POST', `/projects/${projectId}/comments`, data),
  updateComment: (projectId: string, commentId: string, text: string) =>
    request<Comment>('PATCH', `/projects/${projectId}/comments/${commentId}`, { text }),
  deleteComment: (projectId: string, commentId: string) =>
    request<void>('DELETE', `/projects/${projectId}/comments/${commentId}`),

  // Notifications
  getNotifications: () =>
    request<{ id: string; type: string; message: string; createdAt: string }[]>('GET', '/notifications'),
  markNotificationsRead: () =>
    request<void>('POST', '/notifications/read'),
  sendNotification: (toUserId: string, message: string, type?: string) =>
    request<void>('POST', '/notifications/send', { toUserId, message, type: type || 'loop' }),

  // Users
  listUsers: () => request<{ id: string; displayName: string; email: string; avatarUrl: string | null }[]>('GET', '/users'),
  listFriends: () => request<{ id: string; displayName: string; email: string; avatarUrl: string | null }[]>('GET', '/users/friends'),
  addFriend: (userId: string) => request<{ message: string }>('POST', `/users/${userId}/friend`),
  removeFriend: (userId: string) => request<{ message: string }>('DELETE', `/users/${userId}/friend`),

  // Likes
  toggleLike: (trackId: string) => request<{ liked: boolean; count: number }>('POST', `/tracks/${trackId}/like`),
  getLike: (trackId: string) => request<{ liked: boolean; count: number }>('GET', `/tracks/${trackId}/like`),

  // Files
  getUploadUrl: (projectId: string, fileName: string, fileSize: number, mimeType: string) =>
    request<{ fileId: string; uploadUrl: string }>('POST', `/projects/${projectId}/files/upload-url`, {
      fileName, fileSize, mimeType,
    }),
  getDownloadUrl: (projectId: string, fileId: string) =>
    request<{ downloadUrl: string }>('GET', `/projects/${projectId}/files/${fileId}/download-url`),

  // Direct file upload (local storage)
  uploadFile: async (projectId: string, file: File): Promise<{ fileId: string; fileName: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/projects/${projectId}/files/upload`, {
      method: 'POST', headers, body: formData,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    return json.data;
  },

  // Direct file download URL (local storage) — includes token for drag-to-desktop
  getDirectDownloadUrl: (projectId: string, fileId: string) =>
    `${BASE_URL}/projects/${projectId}/files/${fileId}/download${authToken ? `?token=${authToken}` : ''}`,

  // Fetch pre-computed peaks from the server (tiny JSON, renders instantly)
  getPeaks: async (projectId: string, fileId: string, bins = 1024): Promise<{ peaks: number[]; rms: number[]; duration: number; sampleRate: number; channels: number; bins: number } | null> => {
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const res = await fetch(`${BASE_URL}/projects/${projectId}/files/${fileId}/peaks?bins=${bins}`, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  // Download file as ArrayBuffer (for audio decoding)
  downloadFile: async (projectId: string, fileId: string): Promise<ArrayBuffer> => {
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/projects/${projectId}/files/${fileId}/download`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download failed: HTTP ${res.status} — ${text}`);
    }
    return res.arrayBuffer();
  },

  // Public sharing — read-only project links anyone can open without an account
  enableShare: (projectId: string) =>
    request<{ shareToken: string }>('POST', `/projects/${projectId}/share`),
  disableShare: (projectId: string) =>
    request<void>('DELETE', `/projects/${projectId}/share`),
  getPublicProject: async (token: string): Promise<ProjectDetail> => {
    const res = await fetch(`${BASE_URL}/public/projects/${token}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  },
  downloadPublicFile: async (token: string, fileId: string): Promise<ArrayBuffer> => {
    const res = await fetch(`${BASE_URL}/public/projects/${token}/files/${fileId}/download`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Download failed: HTTP ${res.status} — ${text}`);
    }
    return res.arrayBuffer();
  },

  // Sample Packs
  listSamplePacks: () => request<any[]>('GET', '/sample-packs'),
  createSamplePack: (data: { name: string }) => request<any>('POST', '/sample-packs', data),
  getSamplePack: (id: string) => request<any>('GET', `/sample-packs/${id}`),
  updateSamplePack: (id: string, data: { name?: string }) => request<any>('PATCH', `/sample-packs/${id}`, data),
  deleteSamplePack: (id: string) => request<void>('DELETE', `/sample-packs/${id}`),
  addSamplePackItem: (packId: string, data: { name: string; fileId?: string }) =>
    request<any>('POST', `/sample-packs/${packId}/items`, data),
  removeSamplePackItem: (packId: string, itemId: string) =>
    request<void>('DELETE', `/sample-packs/${packId}/items/${itemId}`),

  getStorageUsage: () => request<{ usedBytes: number; limitBytes: number; projectBytes: number; libraryBytes: number }>('GET', '/storage'),

  // Direct messages
  listDmConversations: () =>
    request<{ userId: string; displayName: string; avatarUrl: string | null; lastText: string; lastAt: string; lastFromMe: boolean; lastHasAudio: boolean; unread: number }[]>(
      'GET', '/dm/conversations'),
  getDmHistory: (userId: string) =>
    request<{ id: string; fromUserId: string; toUserId: string; text: string; audioFileId: string | null; audioFileName: string | null; read: boolean; createdAt: string }[]>(
      'GET', `/dm/${userId}`),
  sendDm: (userId: string, data: { text?: string; audioFileId?: string; audioFileName?: string }) =>
    request<{ id: string; fromUserId: string; toUserId: string; text: string; audioFileId: string | null; audioFileName: string | null; read: boolean; createdAt: string }>(
      'POST', `/dm/${userId}`, data),
  uploadDmAudio: async (file: File): Promise<{ fileId: string; fileName: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/dm/upload`, { method: 'POST', headers, body: formData });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    return json.data;
  },
  markDmRead: (userId: string) => request<void>('POST', `/dm/${userId}/read`),
  getDmUnreadTotal: () => request<{ count: number }>('GET', '/dm/unread-count/total'),

  // Arrangement — full clip layout blob, synced across collaborators
  saveArrangement: (projectId: string, state: { clips: any[] }) =>
    request<void>('PUT', `/projects/${projectId}/arrangement`, state),

  // Same endpoint, but flagged with `keepalive: true` so the browser
  // is required to complete the request even if the page is unloading.
  // Use this from pagehide / beforeunload handlers — a normal fetch()
  // can be aborted before the request reaches the server, which was
  // the root cause of recent pitch / mix changes failing to persist
  // on quick refreshes. keepalive bodies are capped at 64 KB by spec
  // so the caller is responsible for keeping the payload small (the
  // arrangement blob is well under that ceiling in practice).
  saveArrangementKeepalive: (projectId: string, state: { clips: any[] }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      return fetch(`${BASE_URL}/projects/${projectId}/arrangement`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(state),
        keepalive: true,
      });
    } catch {
      return Promise.resolve();
    }
  },

  // Bookings — scheduled co-working sessions with friends
  listBookings: () => request<Booking[]>('GET', '/bookings'),
  createBooking: (data: { inviteeId: string; title?: string; scheduledAt: string; durationMin: number }) =>
    request<Booking>('POST', '/bookings', data),
  updateBooking: (id: string, data: { status?: 'accepted' | 'declined' | 'canceled'; scheduledAt?: string; durationMin?: number; title?: string }) =>
    request<Booking>('PATCH', `/bookings/${id}`, data),
  deleteBooking: (id: string) => request<void>('DELETE', `/bookings/${id}`),

  // Community rooms — chat history for a hard-coded room id
  getCommunityHistory: (roomId: string) =>
    request<CommunityMessage[]>('GET', `/communities/${roomId}/messages`),
  uploadCommunityAudio: async (file: File): Promise<{ fileId: string; fileName: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/communities/upload`, { method: 'POST', headers, body: formData });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    return json.data;
  },

  // Sample Library
  listSampleLibrary: () => request<{ folders: SampleLibraryFolder[]; files: SampleLibraryFile[] }>('GET', '/sample-library'),
  createSampleLibraryFolder: (name: string) => request<SampleLibraryFolder>('POST', '/sample-library/folders', { name }),
  deleteSampleLibraryFolder: (id: string) => request<void>('DELETE', `/sample-library/folders/${id}`),
  uploadSampleLibraryFile: async (file: File, folderId: string | null): Promise<SampleLibraryFile> => {
    const formData = new FormData();
    formData.append('file', file);
    if (folderId) formData.append('folderId', folderId);
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/sample-library/upload`, { method: 'POST', headers, body: formData });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Upload failed');
    return json.data;
  },
  deleteSampleLibraryFile: (id: string) => request<void>('DELETE', `/sample-library/files/${id}`),
  getSampleLibraryPeaks: async (fileId: string, bins = 1024) => {
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const res = await fetch(`${BASE_URL}/sample-library/files/${fileId}/peaks?bins=${bins}`, { headers });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as { peaks: number[]; rms: number[]; duration: number; sampleRate: number; channels: number; bins: number };
    } catch { return null; }
  },
  copySampleLibraryFileToProject: (fileId: string, projectId: string) =>
    request<{ trackId: string; fileId: string }>('POST', `/sample-library/files/${fileId}/copy-to-project/${projectId}`),
  downloadSampleLibraryAudio: async (fileId: string): Promise<ArrayBuffer> => {
    const headers: Record<string, string> = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${BASE_URL}/sample-library/files/${fileId}/audio`, { headers });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return res.arrayBuffer();
  },
};

export interface SampleLibraryFolder {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
}

export type SampleCharacter = 'percussive' | 'tonal' | 'mixed' | 'ambient';

export interface SampleLibraryFile {
  id: string;
  userId: string;
  folderId: string | null;
  fileName: string;
  displayName: string;
  fileSize: number;
  mimeType: string;
  peaks: string | null;
  // BPM + character analysis — populated at upload time for WAVs, null otherwise.
  detectedBpm: number | null;
  bpmConfidence: number | null;
  firstBeatOffset: number | null;
  beats: number[] | null;
  sampleCharacter: SampleCharacter | null;
  crestFactor: number | null;
  createdAt: string;
}

export interface CommunityMessage {
  id: string;
  roomId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  text: string;
  audioFileId?: string | null;
  audioFileName?: string | null;
  createdAt: string;
}

export interface CommunityMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Booking {
  id: string;
  creatorId: string;
  inviteeId: string;
  title: string;
  scheduledAt: string;
  durationMin: number;
  status: 'pending' | 'accepted' | 'declined' | 'canceled';
  projectId: string | null;
  createdAt: string;
  creator: { id: string; displayName: string; avatarUrl: string | null } | null;
  invitee: { id: string; displayName: string; avatarUrl: string | null } | null;
}
