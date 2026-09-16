import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { ACCOUNTS, naturalBalance } from '../accounting/chart-of-accounts';
import { ZERO, type Cents } from '../money';
import { NotFoundError } from '../errors';

/**
 * Job costing, read from the general ledger.
 *
 * Not from the job's denormalized roll-up columns, and not from document totals. Those
 * exist for fast list views; this is the figure an owner makes pricing decisions on, so it
 * comes from the same posted journal lines the financial statements come from. If margin
 * and the P&L could ever disagree, one of them would be lying and nobody would know which.
 */

export interface JobCosting {
  jobId: string;
  jobNo: string;
  revenueCents: Cents;
  laborCents: Cents;
  burdenCents: Cents;
  materialCents: Cents;
  subcontractorCents: Cents;
  otherCents: Cents;
  totalCostCents: Cents;
  grossMarginCents: Cents;
  grossMarginPercent: number;
  /** True once anything at all has posted for this job. */
  hasPostings: boolean;
}

const COST_BUCKETS: Record<string, keyof Pick<
  JobCosting,
  'laborCents' | 'burdenCents' | 'materialCents' | 'subcontractorCents' | 'otherCents'
>> = {
  [ACCOUNTS.COGS_LABOR]: 'laborCents',
  [ACCOUNTS.COGS_BURDEN]: 'burdenCents',
  [ACCOUNTS.COGS_MATERIALS]: 'materialCents',
  [ACCOUNTS.COGS_SUBCONTRACTORS]: 'subcontractorCents',
  [ACCOUNTS.COGS_EQUIPMENT]: 'otherCents',
  [ACCOUNTS.COGS_PERMITS]: 'otherCents',
};

export async function jobCosting(
  db: PrismaClient,
  ctx: AuthContext,
  jobId: string,
): Promise<JobCosting> {
  // Cost and margin are the point of this report, so it is gated rather than redacted.
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const job = await db.job.findFirst({
    where: { id: jobId, organizationId: ctx.organizationId },
    select: { id: true, jobNo: true },
  });
  if (!job) throw new NotFoundError('Job', jobId);

  const grouped = await db.journalLine.groupBy({
    by: ['accountId'],
    where: { jobId, journalEntry: { organizationId: ctx.organizationId, postedAt: { not: null } } },
    _sum: { debitCents: true, creditCents: true },
  });

  const accounts = await db.account.findMany({
    where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, code: true, type: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const result: JobCosting = {
    jobId: job.id,
    jobNo: job.jobNo,
    revenueCents: ZERO,
    laborCents: ZERO,
    burdenCents: ZERO,
    materialCents: ZERO,
    subcontractorCents: ZERO,
    otherCents: ZERO,
    totalCostCents: ZERO,
    grossMarginCents: ZERO,
    grossMarginPercent: 0,
    hasPostings: grouped.length > 0,
  };

  for (const row of grouped) {
    const account = byId.get(row.accountId);
    if (!account) continue;

    const balance = naturalBalance(
      account.type,
      row._sum.debitCents ?? ZERO,
      row._sum.creditCents ?? ZERO,
    );

    if (account.type === 'REVENUE' || account.type === 'OTHER_INCOME') {
      // Contra-revenue (discounts) carries a debit balance and correctly reduces revenue.
      result.revenueCents += balance;
      continue;
    }

    const bucket = COST_BUCKETS[account.code];
    if (bucket) {
      result[bucket] += balance;
    } else if (account.type === 'COGS') {
      result.otherCents += balance;
    }
    // Work in Process is an asset, not yet a cost; it is excluded until it is relieved.
  }

  result.totalCostCents =
    result.laborCents +
    result.burdenCents +
    result.materialCents +
    result.subcontractorCents +
    result.otherCents;
  result.grossMarginCents = result.revenueCents - result.totalCostCents;
  result.grossMarginPercent =
    result.revenueCents === ZERO
      ? 0
      : Number((result.grossMarginCents * 10000n) / result.revenueCents) / 100;

  return result;
}

/**
 * Refresh a job's denormalized cost columns from the ledger. Called after each posting so
 * list views and dashboards stay fast without ever becoming a second source of truth —
 * they are a cache of the ledger, and `jobCosting` is what to trust when they disagree.
 */
export async function refreshJobRollup(
  db: PrismaClient,
  ctx: AuthContext,
  jobId: string,
): Promise<void> {
  const costing = await jobCosting(db, ctx, jobId);

  await db.job.updateMany({
    where: { id: jobId, organizationId: ctx.organizationId },
    data: {
      revenueCents: costing.revenueCents,
      laborCostCents: costing.laborCents + costing.burdenCents,
      materialCostCents: costing.materialCents,
      subCostCents: costing.subcontractorCents,
      otherCostCents: costing.otherCents,
    },
  });
}
