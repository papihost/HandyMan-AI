import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { buildAuthContext, can, requireLocation, requirePermission } from '../src/lib/auth/context';
import { PERMISSIONS } from '../src/lib/auth/permissions';
import { hashPassword, needsRehash, verifyPassword, WeakPasswordError } from '../src/lib/auth/password';
import { redactRecord, redactedFieldsFor } from '../src/lib/auth/redaction';
import { scopedDb } from '../src/lib/auth/scoped-db';
import { resolveSession, revokeSession } from '../src/lib/auth/session';
import { changePassword, deactivateUser, signIn, signOut } from '../src/lib/auth/service';
import { createTestJob, createTestOrg, createTestUser, type TestOrg } from './factory';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('Auth');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(await verifyPassword('correct-horse-battery-stapl', hash)).toBe(false);
  });

  it('salts, so the same password never produces the same hash', async () => {
    const a = await hashPassword('correct-horse-battery-staple');
    const b = await hashPassword('correct-horse-battery-staple');
    expect(a).not.toBe(b);
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).not.toContain('correct-horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a short password', async () => {
    await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
  });

  it('flags a hash made with weaker parameters for rehashing', () => {
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});

describe('sign-in', () => {
  it('issues a session and resolves it', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });

    const { session, context } = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });

    expect(session.token).toHaveLength(43); // 32 random bytes, base64url
    const resolved = await resolveSession(db, session.token);
    expect(resolved?.userId).toBe(user.userId);
    expect(context.roleKeys).toEqual(['DISPATCHER']);
  });

  it('stores only the hash of the session token', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });
    const { session } = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });

    const row = await db.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    expect(row.tokenHash).not.toBe(session.token);
    expect(row.tokenHash).toHaveLength(64); // sha256 hex
  });

  it('gives the same message for an unknown email and a wrong password', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });

    const unknown = signIn(db, {
      organizationId: org.organizationId,
      email: 'nobody@test.local',
      password: 'whatever-long-enough',
    });
    const wrong = signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: 'wrong-password-here',
    });

    await expect(unknown).rejects.toThrow('Email or password is incorrect');
    await expect(wrong).rejects.toThrow('Email or password is incorrect');
  });

  it('locks the account after repeated failures', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });

    for (let i = 0; i < 8; i++) {
      await expect(
        signIn(db, {
          organizationId: org.organizationId,
          email: user.email,
          password: 'wrong-password-here',
        }),
      ).rejects.toThrow();
    }

    const locked = await db.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(locked.lockedUntil).not.toBeNull();

    // Even the correct password is refused while the lock holds.
    await expect(
      signIn(db, {
        organizationId: org.organizationId,
        email: user.email,
        password: user.password,
      }),
    ).rejects.toThrow();
  });

  it('revoking a session stops resolving it immediately', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });
    const { session, context } = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });

    expect(await resolveSession(db, session.token)).not.toBeNull();
    await signOut(db, context);
    expect(await resolveSession(db, session.token)).toBeNull();
  });

  it('changing a password revokes every other session', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });
    const phone = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });
    const laptop = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });

    await changePassword(db, phone.context, user.password, 'a-brand-new-passphrase');

    expect(await resolveSession(db, phone.session.token)).toBeNull();
    expect(await resolveSession(db, laptop.session.token)).toBeNull();
    await expect(
      signIn(db, {
        organizationId: org.organizationId,
        email: user.email,
        password: 'a-brand-new-passphrase',
      }),
    ).resolves.toBeTruthy();
  });

  it('deactivating a user cuts off their live sessions', async () => {
    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });
    const target = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });
    const { session } = await signIn(db, {
      organizationId: org.organizationId,
      email: target.email,
      password: target.password,
    });

    await deactivateUser(db, owner.ctx, target.userId);
    expect(await resolveSession(db, session.token)).toBeNull();
  });

  it('refuses an expired session', async () => {
    const user = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });
    const { session } = await signIn(db, {
      organizationId: org.organizationId,
      email: user.email,
      password: user.password,
    });

    await db.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await resolveSession(db, session.token)).toBeNull();
  });
});

describe('role capabilities', () => {
  it('a technician cannot read cost, post to the ledger, or dispatch', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });

    expect(tech.ctx.canReadCost).toBe(false);
    expect(tech.ctx.canReadMargin).toBe(false);
    expect(can(tech.ctx, PERMISSIONS.GL_POST)).toBe(false);
    expect(can(tech.ctx, PERMISSIONS.JOB_DISPATCH)).toBe(false);
    expect(can(tech.ctx, PERMISSIONS.FIELD_APP)).toBe(true);
    expect(tech.ctx.scope).toBe('SELF');
  });

  it('a dispatcher quotes at sell price with no cost visibility', async () => {
    const dispatcher = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });

    expect(can(dispatcher.ctx, PERMISSIONS.QUOTE_WRITE)).toBe(true);
    expect(dispatcher.ctx.canReadCost).toBe(false);
    expect(can(dispatcher.ctx, PERMISSIONS.GL_READ)).toBe(false);
  });

  it('a controller has the ledger; a bookkeeper does not get to close the period', async () => {
    const controller = await createTestUser(org.organizationId, { roleKey: 'CONTROLLER' });
    const bookkeeper = await createTestUser(org.organizationId, { roleKey: 'BOOKKEEPER' });

    expect(can(controller.ctx, PERMISSIONS.PERIOD_CLOSE)).toBe(true);
    expect(can(controller.ctx, PERMISSIONS.GL_REVERSE)).toBe(true);

    expect(can(bookkeeper.ctx, PERMISSIONS.BILL_WRITE)).toBe(true);
    expect(can(bookkeeper.ctx, PERMISSIONS.PERIOD_CLOSE)).toBe(false);
    expect(can(bookkeeper.ctx, PERMISSIONS.GL_REVERSE)).toBe(false);
    expect(can(bookkeeper.ctx, PERMISSIONS.COA_MANAGE)).toBe(false);
    expect(can(bookkeeper.ctx, PERMISSIONS.PAYROLL_READ)).toBe(false);
  });

  it('requirePermission throws for a missing capability', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });
    expect(() => requirePermission(tech.ctx, PERMISSIONS.GL_POST)).toThrow(/Missing permission/);
  });

  it('a branch manager is confined to their own locations', async () => {
    const manager = await createTestUser(org.organizationId, {
      roleKey: 'BRANCH_MANAGER',
      locationIds: [org.locationId],
    });

    expect(manager.ctx.scope).toBe('LOCATION');
    expect(() => requireLocation(manager.ctx, org.locationId)).not.toThrow();
    expect(() => requireLocation(manager.ctx, org.otherLocationId)).toThrow(/do not have access/);
  });

  it('an owner reaches every location', async () => {
    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });
    expect(owner.ctx.scope).toBe('ALL');
    expect(() => requireLocation(owner.ctx, org.otherLocationId)).not.toThrow();
  });
});

describe('cost redaction', () => {
  it('names the fields to strip for a technician and none for a controller', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });
    const controller = await createTestUser(org.organizationId, { roleKey: 'CONTROLLER' });

    expect(redactedFieldsFor('PriceBookItem', tech.ctx)).toContain('costCents');
    expect(redactedFieldsFor('Job', tech.ctx)).toContain('laborCostCents');
    expect(redactedFieldsFor('PriceBookItem', controller.ctx)).toEqual([]);
  });

  it('removes the key entirely rather than nulling it', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });
    const item = { id: 'x', name: 'Wax ring', priceCents: 1800n, costCents: 420n };

    const redacted = redactRecord('PriceBookItem', item, tech.ctx) as Record<string, unknown>;
    expect('costCents' in redacted).toBe(false);
    expect(redacted.priceCents).toBe(1800n);
  });

  it('never fetches cost for a technician, even when the query asks for it', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });
    const controller = await createTestUser(org.organizationId, { roleKey: 'CONTROLLER' });

    await db.priceBookItem.create({
      data: {
        organizationId: org.organizationId,
        sku: `SKU-${Date.now()}`,
        name: 'Wax ring',
        kind: 'PART',
        costCents: 420n,
        priceCents: 1800n,
      },
    });

    const asTech = await scopedDb(db, tech.ctx).priceBookItem.findMany({
      where: { name: 'Wax ring' },
    });
    expect(asTech.length).toBeGreaterThan(0);
    expect('costCents' in asTech[0]).toBe(false);
    expect(asTech[0].priceCents).toBe(1800n);

    const asController = await scopedDb(db, controller.ctx).priceBookItem.findMany({
      where: { name: 'Wax ring' },
    });
    expect(asController[0].costCents).toBe(420n);
  });

  it('strips cost from an explicit select instead of honouring it', async () => {
    const tech = await createTestUser(org.organizationId, { roleKey: 'TECHNICIAN' });

    const rows = await scopedDb(db, tech.ctx).priceBookItem.findMany({
      where: { name: 'Wax ring' },
      select: { id: true, name: true, costCents: true, priceCents: true },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect('costCents' in rows[0]).toBe(false);
    expect(rows[0].name).toBe('Wax ring');
  });

  it('hides job cost roll-ups from a dispatcher but not a branch manager', async () => {
    const dispatcher = await createTestUser(org.organizationId, { roleKey: 'DISPATCHER' });
    const manager = await createTestUser(org.organizationId, { roleKey: 'BRANCH_MANAGER' });
    const job = await createTestJob(org.organizationId, org.locationId);

    await db.job.update({
      where: { id: job.jobId },
      data: { laborCostCents: 10140n, materialCostCents: 8742n, revenueCents: 65000n },
    });

    const asDispatcher = await scopedDb(db, dispatcher.ctx).job.findFirst({
      where: { id: job.jobId },
    });
    expect('laborCostCents' in asDispatcher!).toBe(false);
    expect('materialCostCents' in asDispatcher!).toBe(false);
    expect(asDispatcher!.revenueCents).toBe(65000n);

    const asManager = await scopedDb(db, manager.ctx).job.findFirst({ where: { id: job.jobId } });
    expect(asManager!.laborCostCents).toBe(10140n);
  });
});

describe('tenant isolation', () => {
  it('cannot read another organization rows, even asking for them by id', async () => {
    const other = await createTestOrg('Other Co');
    const otherJob = await createTestJob(other.organizationId, other.locationId);

    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });
    const scoped = scopedDb(db, owner.ctx);

    expect(await scoped.job.findFirst({ where: { id: otherJob.jobId } })).toBeNull();
    expect(await scoped.job.findUnique({ where: { id: otherJob.jobId } })).toBeNull();
    expect(await scoped.customer.findFirst({ where: { id: otherJob.customerId } })).toBeNull();
  });

  it('a query with no where clause still only returns this organization', async () => {
    const other = await createTestOrg('Neighbour Co');
    await createTestJob(other.organizationId, other.locationId);
    await createTestJob(org.organizationId, org.locationId);

    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });
    const jobs = await scopedDb(db, owner.ctx).job.findMany();

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.organizationId === org.organizationId)).toBe(true);
  });

  it('stamps the caller organization onto a create, ignoring any supplied value', async () => {
    const other = await createTestOrg('Impostor Co');
    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });

    const created = await scopedDb(db, owner.ctx).serviceType.create({
      data: {
        organizationId: other.organizationId, // attempt to write into another tenant
        name: 'Plumbing',
        code: `PLB-${Date.now()}`,
      },
    });

    expect(created.organizationId).toBe(org.organizationId);
  });

  it('cannot update or delete across organizations', async () => {
    const other = await createTestOrg('Target Co');
    const otherJob = await createTestJob(other.organizationId, other.locationId);
    const owner = await createTestUser(org.organizationId, { roleKey: 'OWNER' });
    const scoped = scopedDb(db, owner.ctx);

    const { count } = await scoped.job.updateMany({
      where: { id: otherJob.jobId },
      data: { title: 'Hijacked' },
    });
    expect(count).toBe(0);

    const stillThere = await db.job.findUniqueOrThrow({ where: { id: otherJob.jobId } });
    expect(stillThere.title).toBe('Repair drywall');
  });
});
