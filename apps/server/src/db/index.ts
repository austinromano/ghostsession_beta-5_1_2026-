import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema.js';

const isProduction = !!process.env.TURSO_DATABASE_URL;

const client = createClient(
  isProduction
    ? { url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:./ghost_session.db' }
);

export const db = drizzle(client, { schema });

// Auto-create tables on first run
export async function initDatabase() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      hashed_password TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id TEXT NOT NULL REFERENCES users(id),
      tempo REAL DEFAULT 0,
      key TEXT DEFAULT '',
      genre TEXT DEFAULT '',
      time_signature TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'audio',
      owner_id TEXT NOT NULL REFERENCES users(id),
      file_id TEXT,
      file_name TEXT,
      volume REAL DEFAULT 0.8,
      pan REAL DEFAULT 0,
      muted INTEGER DEFAULT 0,
      soloed INTEGER DEFAULT 0,
      bpm REAL,
      key TEXT,
      position INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      file_manifest_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      position_beats REAL,
      parent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      inviter_id TEXT NOT NULL REFERENCES users(id),
      invitee_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'editor',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS track_likes (
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (track_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sample_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sample_pack_items (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES sample_packs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
      position INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      display_name TEXT NOT NULL,
      colour TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      project_id TEXT,
      audio_file_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_post_likes (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_post_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_post_reactions (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, following_id)
    );
    CREATE TABLE IF NOT EXISTS direct_messages (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      audio_file_id TEXT,
      audio_file_name TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      audio_file_id TEXT,
      audio_file_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invitee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'pending',
      project_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sample_library_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sample_library_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES sample_library_folders(id) ON DELETE SET NULL,
      file_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      s3_key TEXT NOT NULL,
      peaks TEXT,
      detected_bpm REAL,
      bpm_confidence REAL,
      first_beat_offset REAL,
      beats_json TEXT,
      sample_character TEXT,
      crest_factor REAL,
      created_at TEXT NOT NULL
    );
  `);

  // Migrations for existing databases
  const migrations = [
    `ALTER TABLE projects ADD COLUMN genre TEXT DEFAULT ''`,
    `ALTER TABLE versions ADD COLUMN snapshot_json TEXT`,
    `ALTER TABLE projects ADD COLUMN project_type TEXT DEFAULT 'project'`,
    `ALTER TABLE users ADD COLUMN avatar_data TEXT`,
    `ALTER TABLE users ADD COLUMN avatar_mime TEXT`,
    `ALTER TABLE files ADD COLUMN peaks TEXT`,
    `ALTER TABLE direct_messages ADD COLUMN audio_file_id TEXT`,
    `ALTER TABLE direct_messages ADD COLUMN audio_file_name TEXT`,
    `ALTER TABLE bookings ADD COLUMN project_id TEXT`,
    `ALTER TABLE projects ADD COLUMN arrangement_json TEXT`,
    `ALTER TABLE community_messages ADD COLUMN audio_file_id TEXT`,
    `ALTER TABLE community_messages ADD COLUMN audio_file_name TEXT`,
    `ALTER TABLE files ADD COLUMN detected_bpm REAL`,
    `ALTER TABLE files ADD COLUMN bpm_confidence REAL`,
    `ALTER TABLE files ADD COLUMN first_beat_offset REAL`,
    `ALTER TABLE files ADD COLUMN beats_json TEXT`,
    `ALTER TABLE files ADD COLUMN sample_character TEXT`,
    `ALTER TABLE files ADD COLUMN crest_factor REAL`,
    `ALTER TABLE sample_library_files ADD COLUMN detected_bpm REAL`,
    `ALTER TABLE sample_library_files ADD COLUMN bpm_confidence REAL`,
    `ALTER TABLE sample_library_files ADD COLUMN first_beat_offset REAL`,
    `ALTER TABLE sample_library_files ADD COLUMN beats_json TEXT`,
    `ALTER TABLE sample_library_files ADD COLUMN sample_character TEXT`,
    `ALTER TABLE sample_library_files ADD COLUMN crest_factor REAL`,
    `ALTER TABLE projects ADD COLUMN share_token TEXT`,
    `ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`,
  ];
  // ADD COLUMN migrations are idempotent by design — "duplicate column" is expected
  // on every boot after the first. Any other error is worth surfacing.
  for (const m of migrations) {
    try { await client.execute(m); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column|already exists/i.test(msg)) console.warn('[db.migrate]', m, '→', err);
    }
  }

  // Belt-and-braces check: verify critical columns exist after migrations
  // run. If any are missing (e.g. because an earlier boot silently skipped a
  // migration for some reason), add them now with explicit logging so we can
  // see exactly what happened in Railway logs.
  const required: Array<[string, string, string]> = [
    ['projects', 'arrangement_json', 'TEXT'],
    ['bookings', 'project_id', 'TEXT'],
  ];
  for (const [table, column, type] of required) {
    try {
      const info = await client.execute(`PRAGMA table_info('${table}')`);
      const names = new Set((info.rows as any[]).map((r) => r.name as string));
      if (!names.has(column)) {
        console.warn(`[db.verify] ${table}.${column} missing — adding now`);
        await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        console.warn(`[db.verify] ${table}.${column} added`);
      }
    } catch (err) {
      console.warn(`[db.verify] failed for ${table}.${column}:`, err);
    }
  }

  // Migrate existing local avatar files into the database
  try {
    const { readFile } = await import('node:fs/promises');
    const { join, resolve } = await import('node:path');
    const AVATARS_DIR = join(process.cwd(), 'uploads', 'avatars');
    const rows = await client.execute(`SELECT id, avatar_url FROM users WHERE avatar_url IS NOT NULL AND avatar_data IS NULL`);
    for (const row of rows.rows) {
      const avatarUrl = row.avatar_url as string;
      const fileName = avatarUrl.split('/').pop();
      if (!fileName) continue;
      try {
        const filePath = resolve(AVATARS_DIR, fileName);
        const data = await readFile(filePath);
        const ext = fileName.split('.').pop() || 'jpg';
        const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
        const base64 = data.toString('base64');
        await client.execute({ sql: `UPDATE users SET avatar_data = ?, avatar_mime = ? WHERE id = ?`, args: [base64, mimeMap[ext] || 'image/jpeg', row.id as string] });
        console.log(`  Migrated avatar for user ${row.id}`);
      } catch (err) { console.warn('[db.avatarBackfill] user', row.id, err); }
    }
  } catch (err) { console.warn('[db.avatarBackfill] scan failed:', err); }

  // Performance indexes on FK columns and common query paths
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tracks_owner ON tracks(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_invitations_invitee ON invitations(invitee_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`,
    `CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_social_post_likes_post ON social_post_likes(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_social_post_likes_user ON social_post_likes(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_social_post_comments_post ON social_post_comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_social_post_reactions_post ON social_post_reactions(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id)`,
    `CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(from_user_id, to_user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_dm_inbox ON direct_messages(to_user_id, read, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sample_packs_owner ON sample_packs(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sample_pack_items_pack ON sample_pack_items(pack_id)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_creator ON bookings(creator_id, scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_bookings_invitee ON bookings(invitee_id, scheduled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_community_messages_room ON community_messages(room_id, created_at)`,
  ];
  for (const idx of indexes) {
    try { await client.execute(idx); } catch (err) { console.warn('[db.index]', idx, '→', err); }
  }

  console.log('  Database initialized (Turso/libsql)');
}

// Export client for raw queries (admin reset etc)
export { client };
