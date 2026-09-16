import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AuthenticationError } from '../errors';

/**
 * Sessions are opaque 256-bit random tokens. Only the SHA-256 hash is stored, so a
 * database disclosure does not hand an attacker usable sessions. Revocation is a column
 * on the row, checked on every request, so a compromised device can be cut off instantly.
 *
 * A token is never logged and never returned in a response body — only in a
 * Secure, HttpOnly, SameSite=Lax cookie.
 */

export const SESSION_COOKIE = 'hm_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // an office shift
/** Field devices stay signed in far longer; techs cannot re-authenticate without signal. */
export const FIELD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: PrismaClient,
  params: {
    userId: string;
    deviceId?: string;
    ipAddress?: string;
    userAgent?: string;
    ttlMs?: number;
  },
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? SESSION_TTL_MS));

  const session = await db.session.create({
    data: {
      userId: params.userId,
      tokenHash: hashToken(token),
      deviceId: params.deviceId ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      expiresAt,
    },
    select: { id: true },
  });

  return { token, sessionId: session.id, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/** Returns null rather than throwing, so callers can decide between 401 and anonymous. */
export async function resolveSession(
  db: PrismaClient,
  token: string | undefined | null,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      revokedAt: true,
      tokenHash: true,
      user: { select: { isActive: true, lockedUntil: true } },
    },
  });
  if (!session) return null;

  // Defence in depth against a future non-unique lookup path.
  const presented = Buffer.from(hashToken(token));
  const stored = Buffer.from(session.tokenHash);
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;

  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.isActive) return null;
  if (session.user.lockedUntil && session.user.lockedUntil.getTime() > Date.now()) return null;

  return { sessionId: session.id, userId: session.userId, expiresAt: session.expiresAt };
}

export async function touchSession(db: PrismaClient, sessionId: string): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: new Date() },
  });
}

export async function revokeSession(
  db: PrismaClient,
  sessionId: string,
  reason = 'SIGN_OUT',
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Used on password change and on administrative deactivation. */
export async function revokeAllUserSessions(
  db: PrismaClient,
  userId: string,
  reason: string,
): Promise<number> {
  const { count } = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

export function requireSession(session: ResolvedSession | null): ResolvedSession {
  if (!session) throw new AuthenticationError();
  return session;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}
