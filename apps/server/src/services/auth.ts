import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { users, authSessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const testHash = scryptSync(password, salt, 64);
  return timingSafeEqual(hashBuffer, testHash);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.insert(authSessions).values({ id: token, userId, expiresAt }).run();
  return token;
}

export async function validateSession(token: string) {
  const results = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, token))
    .limit(1)
    .all();

  const session = results[0];
  if (!session || new Date(session.expiresAt) < new Date()) {
    if (session) {
      await db.delete(authSessions).where(eq(authSessions.id, token)).run();
    }
    return null;
  }

  const userResults = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
      points: users.points,
      tier: users.tier,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1)
    .all();

  return userResults[0] || null;
}

/** Increment a user's points balance by `delta`. Negative values are
 * allowed to spend points; the caller is responsible for any clamping
 * (e.g. enforcing balance >= 0 before calling). Returns the new total. */
export async function addPoints(userId: string, delta: number): Promise<number> {
  const rows = await db.select({ points: users.points }).from(users).where(eq(users.id, userId)).limit(1).all();
  const cur = rows[0]?.points ?? 0;
  const next = Math.max(0, cur + delta);
  await db.update(users).set({ points: next }).where(eq(users.id, userId)).run();
  return next;
}

/** Set a user's tier (e.g. 'free' → 'pro'). Used by the billing flow
 * once it lands; for now exposed as a primitive that other services
 * can call. */
export async function setTier(userId: string, tier: 'free' | 'pro'): Promise<void> {
  await db.update(users).set({ tier }).where(eq(users.id, userId)).run();
}

export async function invalidateSession(token: string) {
  await db.delete(authSessions).where(eq(authSessions.id, token)).run();
}
