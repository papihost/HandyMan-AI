import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { buildAuthContext, systemContext, type AuthContext } from '../src/lib/auth/context';
import { hashPassword } from '../src/lib/auth/password';
import { provisionOrganization } from '../src/lib/accounting/setup';

/**
 * Integration tests run against a real Postgres, because the guarantees under test are
 * database guarantees: deferred balance constraints, immutability triggers, and row
 * locks on the document sequence. A mock would prove nothing about any of them.
 *
 * Each test file gets its own organization, so the shared database stays usable without
 * cross-test interference.
 */

export interface TestOrg {
  db: PrismaClient;
  organizationId: string;
  locationId: string;
  otherLocationId: string;
  systemCtx: AuthContext;
  accountIdByCode: Map<string, string>;
}

export async function createTestOrg(name = 'Test Co'): Promise<TestOrg> {
  const org = await db.organization.create({
    data: {
      name: `${name} ${randomUUID().slice(0, 8)}`,
      dataMode: 'DEMO',
      fiscalYearStartMo: 1,
      timezone: 'UTC',
    },
  });

  const [locationId, otherLocationId] = await Promise.all([
    db.location
      .create({ data: { organizationId: org.id, code: 'MES', name: 'Mesa' } })
      .then((l) => l.id),
    db.location
      .create({ data: { organizationId: org.id, code: 'PHX', name: 'Phoenix' } })
      .then((l) => l.id),
  ]);

  await provisionOrganization(db, org.id, { fiscalYears: [2025, 2026], fiscalYearStartMonth: 1 });

  const accounts = await db.account.findMany({
    where: { organizationId: org.id },
    select: { id: true, code: true },
  });

  return {
    db,
    organizationId: org.id,
    locationId,
    otherLocationId,
    systemCtx: systemContext(org.id),
    accountIdByCode: new Map(accounts.map((a) => [a.code, a.id])),
  };
}

export async function createTestUser(
  organizationId: string,
  opts: {
    roleKey: string;
    email?: string;
    password?: string;
    locationIds?: string[];
  },
): Promise<{ userId: string; email: string; password: string; ctx: AuthContext }> {
  const email = opts.email ?? `${opts.roleKey.toLowerCase()}.${randomUUID().slice(0, 8)}@test.local`;
  const password = opts.password ?? 'correct-horse-battery-staple';

  const role = await db.role.findUniqueOrThrow({
    where: { organizationId_key: { organizationId, key: opts.roleKey } },
  });

  const user = await db.user.create({
    data: {
      organizationId,
      email,
      passwordHash: await hashPassword(password),
      firstName: opts.roleKey,
      lastName: 'User',
      userRoles: { create: { roleId: role.id } },
      ...(opts.locationIds?.length
        ? { userLocations: { create: opts.locationIds.map((locationId) => ({ locationId })) } }
        : {}),
    },
  });

  return { userId: user.id, email, password, ctx: await buildAuthContext(db, user.id) };
}

/** UTC date helper so period boundaries don't shift under the runner's timezone. */
export function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

/**
 * A real customer, property and job. Journal lines carry a foreign key to Job, so the
 * dimension on a posting is guaranteed to point at something that exists — which is the
 * reason job costing can never drift from the ledger.
 */
export async function createTestJob(
  organizationId: string,
  locationId: string,
  title = 'Repair drywall',
): Promise<{ jobId: string; customerId: string; propertyId: string }> {
  const suffix = randomUUID().slice(0, 8);

  const customer = await db.customer.create({
    data: {
      organizationId,
      customerNo: `C-${suffix}`,
      type: 'RESIDENTIAL',
      firstName: 'Test',
      lastName: 'Customer',
      properties: {
        create: {
          addressLine1: '123 Test St',
          city: 'Mesa',
          state: 'AZ',
          postalCode: '85201',
        },
      },
    },
    include: { properties: true },
  });

  const property = customer.properties[0];

  const job = await db.job.create({
    data: {
      organizationId,
      locationId,
      jobNo: `J-${suffix}`,
      customerId: customer.id,
      propertyId: property.id,
      title,
    },
  });

  return { jobId: job.id, customerId: customer.id, propertyId: property.id };
}
