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

/** A jurisdiction that taxes labor and materials at 8.3%, the way Arizona does. */
export async function createTaxJurisdiction(
  organizationId: string,
  opts: { rate?: string; taxLabor?: boolean; name?: string } = {},
): Promise<string> {
  const jurisdiction = await db.taxJurisdiction.create({
    data: {
      organizationId,
      name: opts.name ?? 'AZ — Maricopa — Mesa',
      level: 'CITY',
      state: 'AZ',
      city: 'Mesa',
      rules: {
        create: {
          rate: opts.rate ?? '0.0830',
          effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
          taxLabor: opts.taxLabor ?? true,
          taxMaterials: true,
          taxServiceAgreements: false,
          taxFees: false,
        },
      },
    },
  });
  return jurisdiction.id;
}

export async function createPriceBookItem(
  organizationId: string,
  opts: {
    sku?: string;
    name: string;
    category: 'LABOR' | 'MATERIAL' | 'AGREEMENT' | 'FEE' | 'SUBCONTRACT';
    kind?: 'PART' | 'MATERIAL' | 'LABOR' | 'FLAT_RATE' | 'FEE' | 'SUBCONTRACT';
    costCents: bigint;
    priceCents: bigint;
    isTaxExempt?: boolean;
  },
): Promise<string> {
  const item = await db.priceBookItem.create({
    data: {
      organizationId,
      sku: opts.sku ?? `SKU-${randomUUID().slice(0, 8)}`,
      name: opts.name,
      kind: opts.kind ?? (opts.category === 'LABOR' ? 'LABOR' : 'PART'),
      category: opts.category,
      costCents: opts.costCents,
      priceCents: opts.priceCents,
      isTaxExempt: opts.isTaxExempt ?? false,
      isStocked: opts.category === 'MATERIAL',
    },
  });
  return item.id;
}

export async function createTestTechnician(
  organizationId: string,
  locationId: string,
): Promise<{ technicianId: string; userId: string }> {
  const user = await createTestUser(organizationId, {
    roleKey: 'TECHNICIAN',
    locationIds: [locationId],
  });

  const technician = await db.technician.create({
    data: {
      organizationId,
      userId: user.userId,
      payType: 'HOURLY',
      burdenRates: {
        create: {
          effectiveFrom: new Date(Date.UTC(2020, 0, 1)),
          baseHourlyCents: 2800n,
          payrollTaxRate: '0.0765',
          workersCompRate: '0.08',
          benefitsRate: '0.06',
          vehicleMonthlyCents: 85000n,
          phoneMonthlyCents: 6000n,
          billableHoursPerMonth: '140',
          loadedHourlyCents: 4056n,
        },
      },
    },
  });

  return { technicianId: technician.id, userId: user.userId };
}

/** Attach a jurisdiction to a property so tax resolves on the service address. */
export async function setPropertyJurisdiction(
  propertyId: string,
  taxJurisdictionId: string,
): Promise<void> {
  await db.property.update({ where: { id: propertyId }, data: { taxJurisdictionId } });
}
