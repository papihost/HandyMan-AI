import { cookies, headers } from 'next/headers';
import { db } from '../lib/db';
import { buildAuthContext, type AuthContext } from '../lib/auth/context';
import { AuthenticationError } from '../lib/errors';
import { resolveSession, SESSION_COOKIE, touchSession } from '../lib/auth/session';

/**
 * Resolve the caller from their session cookie.
 *
 * Every request re-reads the session rather than trusting a token's contents, so
 * revoking a device or deactivating a technician takes effect on the next request rather
 * than whenever a token happens to expire. For a field device carrying a customer list,
 * that difference matters.
 */
export async function currentContext(): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  const session = await resolveSession(db, token);
  if (!session) return null;

  // Fire-and-forget: a failed heartbeat must not fail the request it rode in on.
  void touchSession(db, session.sessionId).catch(() => {});

  return buildAuthContext(db, session.userId, session.sessionId);
}

export async function requireContext(): Promise<AuthContext> {
  const ctx = await currentContext();
  if (!ctx) throw new AuthenticationError();
  return ctx;
}

export async function requestMeta(): Promise<{ ipAddress?: string; userAgent?: string }> {
  const list = await headers();
  const forwarded = list.get('x-forwarded-for');
  return {
    ipAddress: forwarded?.split(',')[0]?.trim() || undefined,
    userAgent: list.get('user-agent') ?? undefined,
  };
}
