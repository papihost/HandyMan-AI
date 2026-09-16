import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../db';
import { SYSTEM_ROLES } from '../auth/roles';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts';
import { ensureFiscalYear } from './periods';

/**
 * Idempotent provisioning for a new organization: the chart of accounts, the system
 * roles, and the fiscal years that postings will need. Safe to re-run — used by the
 * seed, by the import wizard, and by customer onboarding.
 */
export async function ensureChartOfAccounts(
  db: PrismaClient | Tx,
  organizationId: string,
): Promise<number> {
  const { count } = await db.account.createMany({
    data: CHART_OF_ACCOUNTS.map((a) => ({
      organizationId,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      isSystem: a.isSystem ?? false,
      description: a.description ?? null,
    })),
    skipDuplicates: true,
  });
  return count;
}

export async function ensureSystemRoles(
  db: PrismaClient | Tx,
  organizationId: string,
): Promise<number> {
  const { count } = await db.role.createMany({
    data: SYSTEM_ROLES.map((r) => ({
      organizationId,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: true,
      permissions: r.permissions as string[],
    })),
    skipDuplicates: true,
  });

  // Keep existing system roles in step with code changes, without disturbing the
  // customer's own custom roles.
  for (const role of SYSTEM_ROLES) {
    await db.role.updateMany({
      where: { organizationId, key: role.key, isSystem: true },
      data: { permissions: role.permissions as string[], description: role.description },
    });
  }

  return count;
}

export async function provisionOrganization(
  db: PrismaClient,
  organizationId: string,
  opts: { fiscalYears?: number[]; fiscalYearStartMonth?: number } = {},
): Promise<void> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { fiscalYearStartMo: true },
  });

  const startMonth = opts.fiscalYearStartMonth ?? org.fiscalYearStartMo;
  const thisYear = new Date().getUTCFullYear();
  const years = opts.fiscalYears ?? [thisYear - 1, thisYear, thisYear + 1];

  await ensureChartOfAccounts(db, organizationId);
  await ensureSystemRoles(db, organizationId);
  for (const year of years) {
    await ensureFiscalYear(db, organizationId, year, startMonth);
  }
}
