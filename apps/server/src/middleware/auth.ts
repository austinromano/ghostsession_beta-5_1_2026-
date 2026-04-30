import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSession } from '../services/auth.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
  points: number;
  tier: 'free' | 'pro';
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  const queryToken = c.req.query('token');
  if (!header?.startsWith('Bearer ') && !queryToken) {
    throw new HTTPException(401, { message: 'Missing auth token' });
  }

  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken!;
  const user = await validateSession(token);
  if (!user) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  c.set('user', user);
  c.set('token', token);
  await next();
}
