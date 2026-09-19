import type { PrismaClient } from '@prisma/client';
import { AuthenticationError, ValidationError } from '../errors';
import { buildAuthContext, type AuthContext } from './context';
import { hashPassword, needsRehash, verifyPassword } from './password';
import {
  createSession,
  FIELD_SESSION_TTL_MS,
  revokeAllUserSessions,
  revokeSession,
  SESSION_TTL_MS,
  type IssuedSession,
} from './session';

/**
 * Sign-in.
 *
 * Failures are deliberately indistinguishable: an unknown email, a wrong password, a
 * deactivated account and a locked account all produce the same message and take
 * comparable time. Anything else is a user-enumeration oracle.
 */

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_FAILURE = 'Email or password is incorrect';

/** A hash of a throwaway value, so a miss still pays the scrypt cost. */
let decoyHash: string | null = null;
async function burnTime(): Promise<void> {
  decoyHash ??= await hashPassword('decoy-password-for-timing');
  await verifyPassword('decoy-password-for-timing-x', decoyHash);
}

export interface SignInParams {
  organizationId: string;
  email: string;
  password: string;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Field devices get a long-lived session; techs cannot re-authenticate without signal. */
  isFieldDevice?: boolean;
}

export interface SignInResult {
  session: IssuedSession;
  context: AuthContext;
}

/**
 * Which organization an address belongs to, for a deployment that does not put the tenant
 * in the host name — a demo laptop, a single-company install.
 *
 * Resolved from the address rather than from "the first organization on the box", because
 * a machine that has run the seed more than once, or run the test suite, holds several.
 * Picking the oldest signs a presenter into an empty company using their own email and
 * their own password, which is indistinguishable from a broken product. The newest match
 * wins: that is the company someone most recently built.
 *
 * An address nobody holds falls back to an arbitrary organization rather than failing
 * differently, so the caller's failure stays the one generic message an unknown password
 * already produces.
 */
export async function resolveOrganizationForSignIn(
  db: PrismaClient,
  rawEmail: string,
): Promise<string> {
  const email = rawEmail.trim().toLowerCase();

  const match = await db.user.findFirst({
    where: { email, isActive: true },
    orderBy: { organization: { createdAt: 'desc' } },
    select: { organizationId: true },
  });
  if (match) return match.organizationId;

  const fallback = await db.organization.findFirstOrThrow({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return fallback.id;
}

export async function signIn(db: PrismaClient, params: SignInParams): Promise<SignInResult> {
  const email = params.email.trim().toLowerCase();

  const user = await db.user.findUnique({
    where: { organizationId_email: { organizationId: params.organizationId, email } },
    select: {
      id: true,
      passwordHash: true,
      isActive: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });

  if (!user || !user.passwordHash || !user.isActive) {
    await burnTime();
    throw new AuthenticationError(GENERIC_FAILURE);
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await burnTime();
    throw new AuthenticationError(GENERIC_FAILURE);
  }

  const ok = await verifyPassword(params.password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        lockedUntil: failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    });
    throw new AuthenticationError(GENERIC_FAILURE);
  }

  // Transparently upgrade a hash made under weaker parameters.
  const rehashed = needsRehash(user.passwordHash)
    ? await hashPassword(params.password)
    : undefined;

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(rehashed ? { passwordHash: rehashed } : {}),
    },
  });

  const session = await createSession(db, {
    userId: user.id,
    deviceId: params.deviceId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    ttlMs: params.isFieldDevice ? FIELD_SESSION_TTL_MS : SESSION_TTL_MS,
  });

  const context = await buildAuthContext(db, user.id, session.sessionId);

  await db.auditLog.create({
    data: {
      organizationId: context.organizationId,
      userId: user.id,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    },
  });

  return { session, context };
}

export async function signOut(db: PrismaClient, ctx: AuthContext): Promise<void> {
  if (ctx.sessionId) await revokeSession(db, ctx.sessionId, 'SIGN_OUT');
}

/**
 * Change password. Every other session for the user is revoked, because the usual reason
 * someone changes a password is that they think someone else has it.
 */
export async function changePassword(
  db: PrismaClient,
  ctx: AuthContext,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { passwordHash: true },
  });

  if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AuthenticationError('Current password is incorrect');
  }
  if (currentPassword === newPassword) {
    throw new ValidationError('The new password must be different from the current one');
  }

  const passwordHash = await hashPassword(newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: ctx.userId },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        action: 'PASSWORD_CHANGE',
        entityType: 'User',
        entityId: ctx.userId,
      },
    });
  });

  await revokeAllUserSessions(db, ctx.userId, 'PASSWORD_CHANGED');
}

/** Administrative deactivation. Cuts off every live session immediately. */
export async function deactivateUser(
  db: PrismaClient,
  ctx: AuthContext,
  targetUserId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: targetUserId, organizationId: ctx.organizationId },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ValidationError('User not found in this organization');

    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        action: 'DEACTIVATE',
        entityType: 'User',
        entityId: targetUserId,
      },
    });
  });

  await revokeAllUserSessions(db, targetUserId, 'USER_DEACTIVATED');
}
