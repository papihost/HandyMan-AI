import type { PrismaClient } from '@prisma/client';
import { AuthorizationError } from '../errors';
import { PERMISSIONS, type AccessScope, type Permission } from './permissions';
import { SYSTEM_ROLE_BY_KEY, widestScope } from './roles';

/**
 * The single object every data-access call takes. It carries who the caller is, which
 * organization and locations they may touch, and what they are allowed to do — so no
 * query anywhere in the system has to re-derive that, and none can forget to.
 */
export interface AuthContext {
  userId: string;
  organizationId: string;
  email: string;
  displayName: string;
  roleKeys: string[];
  permissions: ReadonlySet<Permission>;
  scope: AccessScope;
  /** Empty means "not location-restricted" — only meaningful when scope !== 'ALL'. */
  locationIds: string[];
  technicianId: string | null;
  sessionId: string | null;
  /** Cached because the redaction layer consults it on every row it returns. */
  canReadCost: boolean;
  canReadMargin: boolean;
}

export async function buildAuthContext(
  db: PrismaClient,
  userId: string,
  sessionId: string | null = null,
): Promise<AuthContext> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      firstName: true,
      lastName: true,
      userRoles: { select: { role: { select: { key: true, permissions: true } } } },
      userLocations: { select: { locationId: true } },
      technician: { select: { id: true } },
    },
  });

  const permissions = new Set<Permission>();
  const scopes: AccessScope[] = [];

  for (const { role } of user.userRoles) {
    for (const p of role.permissions) permissions.add(p as Permission);
    // Scope comes from the system role definition; custom roles default to their
    // closest system ancestor, or SELF when unknown — never wider than intended.
    scopes.push(SYSTEM_ROLE_BY_KEY.get(role.key)?.scope ?? 'SELF');
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    displayName: `${user.firstName} ${user.lastName}`.trim(),
    roleKeys: user.userRoles.map((ur) => ur.role.key),
    permissions,
    scope: scopes.length ? widestScope(scopes) : 'SELF',
    locationIds: user.userLocations.map((ul) => ul.locationId),
    technicianId: user.technician?.id ?? null,
    sessionId,
    canReadCost: permissions.has(PERMISSIONS.FINANCE_READ_COST),
    canReadMargin: permissions.has(PERMISSIONS.FINANCE_READ_MARGIN),
  };
}

export function can(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function canAll(ctx: AuthContext, ...permissions: Permission[]): boolean {
  return permissions.every((p) => ctx.permissions.has(p));
}

export function canAny(ctx: AuthContext, ...permissions: Permission[]): boolean {
  return permissions.some((p) => ctx.permissions.has(p));
}

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new AuthorizationError(`Missing permission: ${permission}`);
  }
}

/** Throws unless the caller may act within the given location. */
export function requireLocation(ctx: AuthContext, locationId: string): void {
  if (ctx.scope === 'ALL') return;
  if (!ctx.locationIds.includes(locationId)) {
    throw new AuthorizationError('You do not have access to this location');
  }
}

/**
 * Authority to post, arising from a business operation the caller was already permitted
 * to perform.
 *
 * `gl:post` guards *discretionary* journal entries — someone deciding to move money
 * between accounts by hand. It is not what guards an invoice being issued or parts coming
 * off a van: those postings are consequences of the posting rules, not choices, and the
 * permission that matters was already checked on the operation itself.
 *
 * A technician must never hold `gl:post`, and must still be able to close a job. This is
 * how both are true. The original actor is carried through, so the journal entry records
 * who caused it rather than attributing it to nobody.
 */
export function postingContextFor(ctx: AuthContext): AuthContext {
  return { ...systemContext(ctx.organizationId, ctx.userId), sessionId: ctx.sessionId };
}

/**
 * A system context for seeds, migrations, scheduled jobs, and posting rules invoked by
 * the engine itself. It is deliberately explicit: nothing acquires full authority by
 * accident, it has to be asked for by name.
 */
export function systemContext(organizationId: string, actorUserId = 'system'): AuthContext {
  const all = new Set(Object.values(PERMISSIONS) as Permission[]);
  return {
    userId: actorUserId,
    organizationId,
    email: 'system@internal',
    displayName: 'System',
    roleKeys: ['SYSTEM'],
    permissions: all,
    scope: 'ALL',
    locationIds: [],
    technicianId: null,
    sessionId: null,
    canReadCost: true,
    canReadMargin: true,
  };
}
