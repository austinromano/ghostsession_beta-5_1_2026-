import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const uuid = () => text('id').$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).$defaultFn(() => new Date().toISOString());

export const users = sqliteTable('users', {
  id: uuid().primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  avatarData: text('avatar_data'),
  avatarMime: text('avatar_mime'),
  hashedPassword: text('hashed_password').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: uuid().primaryKey(),
  name: text('name').notNull(),
  description: text('description').default(''),
  ownerId: text('owner_id').notNull().references(() => users.id),
  tempo: real('tempo').default(0),
  key: text('key').default(''),
  genre: text('genre').default(''),
  projectType: text('project_type').default('project'),
  timeSignature: text('time_signature').default(''),
  // Full arrangement state as JSON: clip offsets, trims, volumes, solo/mute,
  // pitch, and parent ids for local-only split/dup clips. Lets the server
  // persist the arrangement across sessions and sync it in real time between
  // collaborators.
  arrangementJson: text('arrangement_json'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const projectMembers = sqliteTable('project_members', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull().default('editor'),
  joinedAt: timestamp('joined_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.userId] }),
}));

export const tracks = sqliteTable('tracks', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['audio', 'midi', 'drum', 'loop', 'fullmix'] }).notNull().default('audio'),
  ownerId: text('owner_id').notNull().references(() => users.id),
  fileId: text('file_id'),
  fileName: text('file_name'),
  volume: real('volume').default(0.8),
  pan: real('pan').default(0),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  soloed: integer('soloed', { mode: 'boolean' }).default(false),
  bpm: real('bpm'),
  key: text('key'),
  position: integer('position').default(0),
  createdAt: timestamp('created_at').notNull(),
});

export const versions = sqliteTable('versions', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  name: text('name').notNull(),
  description: text('description').default(''),
  createdBy: text('created_by').notNull().references(() => users.id),
  fileManifestJson: text('file_manifest_json', { mode: 'json' }).default([]),
  snapshotJson: text('snapshot_json', { mode: 'json' }),
  createdAt: timestamp('created_at').notNull(),
});

export const comments = sqliteTable('comments', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id),
  text: text('text').notNull(),
  positionBeats: real('position_beats'),
  parentId: text('parent_id'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const invitations = sqliteTable('invitations', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  inviterId: text('inviter_id').notNull().references(() => users.id),
  inviteeId: text('invitee_id').notNull().references(() => users.id),
  role: text('role', { enum: ['editor', 'viewer'] }).notNull().default('editor'),
  status: text('status', { enum: ['pending', 'accepted', 'declined'] }).notNull().default('pending'),
  createdAt: timestamp('created_at').notNull(),
});

export const files = sqliteTable('files', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  uploadedBy: text('uploaded_by').notNull().references(() => users.id),
  fileName: text('file_name').notNull(),
  fileSize: integer('file_size').notNull(),
  mimeType: text('mime_type').notNull(),
  s3Key: text('s3_key').notNull(),
  peaks: text('peaks'),
  // BPM + beat analysis (populated at upload or copied from library).
  detectedBpm: real('detected_bpm'),
  bpmConfidence: real('bpm_confidence'),
  firstBeatOffset: real('first_beat_offset'),
  beatsJson: text('beats_json'),
  createdAt: timestamp('created_at').notNull(),
});

export const trackLikes = sqliteTable('track_likes', {
  trackId: text('track_id').notNull().references(() => tracks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.trackId, table.userId] }),
}));

export const samplePacks = sqliteTable('sample_packs', {
  id: uuid().primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const samplePackItems = sqliteTable('sample_pack_items', {
  id: uuid().primaryKey(),
  packId: text('pack_id').notNull().references(() => samplePacks.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fileId: text('file_id').references(() => files.id, { onDelete: 'cascade' }),
  position: integer('position').default(0),
  createdAt: timestamp('created_at').notNull(),
});

export const sampleLibraryFolders = sqliteTable('sample_library_folders', {
  id: uuid().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const sampleLibraryFiles = sqliteTable('sample_library_files', {
  id: uuid().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  folderId: text('folder_id').references(() => sampleLibraryFolders.id, { onDelete: 'set null' }),
  fileName: text('file_name').notNull(),
  displayName: text('display_name').notNull(),
  fileSize: integer('file_size').notNull(),
  mimeType: text('mime_type').notNull(),
  s3Key: text('s3_key').notNull(),
  peaks: text('peaks'),
  // BPM + beat analysis populated at upload time for WAVs. All nullable
  // because analysis can fail / be unsupported for a given format.
  detectedBpm: real('detected_bpm'),
  bpmConfidence: real('bpm_confidence'),
  firstBeatOffset: real('first_beat_offset'),
  beatsJson: text('beats_json'),
  createdAt: timestamp('created_at').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: uuid().primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  displayName: text('display_name').notNull(),
  colour: text('colour').notNull(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const directMessages = sqliteTable('direct_messages', {
  id: uuid().primaryKey(),
  fromUserId: text('from_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toUserId: text('to_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  audioFileId: text('audio_file_id'),
  audioFileName: text('audio_file_name'),
  read: integer('read', { mode: 'boolean' }).notNull().default(false),
  createdAt: timestamp('created_at').notNull(),
});

export const socialPosts = sqliteTable('social_posts', {
  id: uuid().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  projectId: text('project_id'),
  audioFileId: text('audio_file_id'),
  createdAt: timestamp('created_at').notNull(),
});

export const socialPostLikes = sqliteTable('social_post_likes', {
  id: uuid().primaryKey(),
  postId: text('post_id').notNull().references(() => socialPosts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
});

export const socialPostComments = sqliteTable('social_post_comments', {
  id: uuid().primaryKey(),
  postId: text('post_id').notNull().references(() => socialPosts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const socialPostReactions = sqliteTable('social_post_reactions', {
  id: uuid().primaryKey(),
  postId: text('post_id').notNull().references(() => socialPosts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const follows = sqliteTable('follows', {
  followerId: text('follower_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  followingId: text('following_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
});

export const notifications = sqliteTable('notifications', {
  id: uuid().primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  message: text('message').notNull(),
  read: integer('read', { mode: 'boolean' }).default(false),
  createdAt: timestamp('created_at').notNull(),
});

// Chat history for the hard-coded community rooms. roomId is a string key
// (e.g. 'girl-producers'), not a foreign key — rooms are constants on the
// client for now; adding a communities table is a later expansion.
export const communityMessages = sqliteTable('community_messages', {
  id: uuid().primaryKey(),
  roomId: text('room_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull().default(''),
  audioFileId: text('audio_file_id'),
  audioFileName: text('audio_file_name'),
  createdAt: timestamp('created_at').notNull(),
});

// Scheduled co-working sessions ("book a session with a friend").
// scheduledAt is stored as an ISO-8601 UTC string; clients render in local TZ.
export const bookings = sqliteTable('bookings', {
  id: uuid().primaryKey(),
  creatorId: text('creator_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  inviteeId: text('invitee_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  scheduledAt: text('scheduled_at').notNull(),
  durationMin: integer('duration_min').notNull().default(60),
  status: text('status', { enum: ['pending', 'accepted', 'declined', 'canceled'] }).notNull().default('pending'),
  // Shared collab project created on acceptance so Join can route both users
  // into the same WebRTC room.
  projectId: text('project_id'),
  createdAt: timestamp('created_at').notNull(),
});
