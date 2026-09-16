import type { AccountType, PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { ZERO, type Cents } from '../money';
import { INCOME_STATEMENT_TYPES, naturalBalance } from './chart-of-accounts';

/**
 * Reporting straight off the ledger.
 *
 * Every figure any dashboard shows is produced here, from posted journal lines. Nothing
 * is cached in a summary table and nothing is computed from document totals, because the
 * moment a reported number can disagree with the general ledger, the general ledger has
 * stopped being the system of record.
 *
 * Location, job, technician and service-type segmentation are filters on the journal
 * line's own dimensions — which is why P&L by branch needs no separate data model.
 */

export interface LedgerFilter {
  from?: Date;
  to?: Date;
  locationIds?: string[];
  jobId?: string;
  technicianId?: string;
  serviceTypeId?: string;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitsCents: Cents;
  creditsCents: Cents;
  /** Signed in the account's natural direction: revenue of 10,000 reads +10,000. */
  balanceCents: Cents;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitsCents: Cents;
  totalCreditsCents: Cents;
  /** Always true for a healthy ledger; surfaced so a report can assert it rather than assume it. */
  isBalanced: boolean;
}

function lineWhere(ctx: AuthContext, filter: LedgerFilter) {
  const locationIds =
    filter.locationIds ?? (ctx.scope === 'ALL' ? undefined : ctx.locationIds.length ? ctx.locationIds : undefined);

  return {
    journalEntry: {
      organizationId: ctx.organizationId,
      postedAt: { not: null },
      ...(filter.from || filter.to
        ? {
            entryDate: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    },
    ...(locationIds ? { locationId: { in: locationIds } } : {}),
    ...(filter.jobId ? { jobId: filter.jobId } : {}),
    ...(filter.technicianId ? { technicianId: filter.technicianId } : {}),
    ...(filter.serviceTypeId ? { serviceTypeId: filter.serviceTypeId } : {}),
  };
}

export async function trialBalance(
  db: PrismaClient,
  ctx: AuthContext,
  filter: LedgerFilter = {},
): Promise<TrialBalance> {
  requirePermission(ctx, PERMISSIONS.GL_READ);

  const grouped = await db.journalLine.groupBy({
    by: ['accountId'],
    where: lineWhere(ctx, filter),
    _sum: { debitCents: true, creditCents: true },
  });

  const accounts = await db.account.findMany({
    where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, code: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const rows: TrialBalanceRow[] = grouped
    .map((g) => {
      const account = byId.get(g.accountId)!;
      const debits = g._sum.debitCents ?? ZERO;
      const credits = g._sum.creditCents ?? ZERO;
      return {
        accountId: g.accountId,
        code: account.code,
        name: account.name,
        type: account.type,
        debitsCents: debits,
        creditsCents: credits,
        balanceCents: naturalBalance(account.type, debits, credits),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebits = rows.reduce((t, r) => t + r.debitsCents, ZERO);
  const totalCredits = rows.reduce((t, r) => t + r.creditsCents, ZERO);

  return {
    rows,
    totalDebitsCents: totalDebits,
    totalCreditsCents: totalCredits,
    isBalanced: totalDebits === totalCredits,
  };
}

export interface IncomeStatementSection {
  label: string;
  rows: TrialBalanceRow[];
  totalCents: Cents;
}

export interface IncomeStatement {
  from: Date;
  to: Date;
  revenue: IncomeStatementSection;
  costOfGoodsSold: IncomeStatementSection;
  grossProfitCents: Cents;
  grossMarginPercent: number;
  operatingExpenses: IncomeStatementSection;
  netIncomeCents: Cents;
}

export async function incomeStatement(
  db: PrismaClient,
  ctx: AuthContext,
  filter: LedgerFilter & { from: Date; to: Date },
): Promise<IncomeStatement> {
  requirePermission(ctx, PERMISSIONS.REPORT_FINANCIAL);

  const tb = await trialBalance(db, ctx, filter);
  const pick = (types: AccountType[]) => tb.rows.filter((r) => types.includes(r.type));
  const total = (rows: TrialBalanceRow[]) => rows.reduce((t, r) => t + r.balanceCents, ZERO);

  const revenueRows = pick(['REVENUE', 'OTHER_INCOME']);
  const cogsRows = pick(['COGS']);
  const opexRows = pick(['EXPENSE', 'OTHER_EXPENSE']);

  const revenueTotal = total(revenueRows);
  const cogsTotal = total(cogsRows);
  const opexTotal = total(opexRows);
  const grossProfit = revenueTotal - cogsTotal;

  return {
    from: filter.from,
    to: filter.to,
    revenue: { label: 'Revenue', rows: revenueRows, totalCents: revenueTotal },
    costOfGoodsSold: { label: 'Cost of Goods Sold', rows: cogsRows, totalCents: cogsTotal },
    grossProfitCents: grossProfit,
    grossMarginPercent:
      revenueTotal === ZERO ? 0 : Number((grossProfit * 10000n) / revenueTotal) / 100,
    operatingExpenses: { label: 'Operating Expenses', rows: opexRows, totalCents: opexTotal },
    netIncomeCents: grossProfit - opexTotal,
  };
}

export interface BalanceSheet {
  asOf: Date;
  assets: IncomeStatementSection;
  liabilities: IncomeStatementSection;
  equity: IncomeStatementSection;
  /** Earnings for the current year, which have not yet been closed to retained earnings. */
  currentEarningsCents: Cents;
  totalLiabilitiesAndEquityCents: Cents;
  isBalanced: boolean;
}

export async function balanceSheet(
  db: PrismaClient,
  ctx: AuthContext,
  asOf: Date,
  filter: Omit<LedgerFilter, 'from' | 'to'> = {},
): Promise<BalanceSheet> {
  requirePermission(ctx, PERMISSIONS.REPORT_FINANCIAL);

  const tb = await trialBalance(db, ctx, { ...filter, to: asOf });
  const total = (rows: TrialBalanceRow[]) => rows.reduce((t, r) => t + r.balanceCents, ZERO);

  const assets = tb.rows.filter((r) => r.type === 'ASSET');
  const liabilities = tb.rows.filter((r) => r.type === 'LIABILITY');
  const equity = tb.rows.filter((r) => r.type === 'EQUITY');
  // Income and expense accounts have not been closed out yet; their net is this year's
  // earnings and belongs on the balance sheet under equity.
  const currentEarnings = tb.rows
    .filter((r) => INCOME_STATEMENT_TYPES.has(r.type))
    .reduce((t, r) => (r.type === 'REVENUE' || r.type === 'OTHER_INCOME' ? t + r.balanceCents : t - r.balanceCents), ZERO);

  const totalAssets = total(assets);
  const totalLiabilitiesAndEquity = total(liabilities) + total(equity) + currentEarnings;

  return {
    asOf,
    assets: { label: 'Assets', rows: assets, totalCents: totalAssets },
    liabilities: { label: 'Liabilities', rows: liabilities, totalCents: total(liabilities) },
    equity: { label: 'Equity', rows: equity, totalCents: total(equity) },
    currentEarningsCents: currentEarnings,
    totalLiabilitiesAndEquityCents: totalLiabilitiesAndEquity,
    isBalanced: totalAssets === totalLiabilitiesAndEquity,
  };
}

export interface LocationProfitRow {
  locationId: string | null;
  locationName: string;
  revenueCents: Cents;
  cogsCents: Cents;
  grossProfitCents: Cents;
  grossMarginPercent: number;
}

/** P&L by branch, straight off the location dimension on each journal line. */
export async function profitByLocation(
  db: PrismaClient,
  ctx: AuthContext,
  filter: LedgerFilter & { from: Date; to: Date },
): Promise<LocationProfitRow[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_FINANCIAL);

  const grouped = await db.journalLine.groupBy({
    by: ['locationId', 'accountId'],
    where: lineWhere(ctx, filter),
    _sum: { debitCents: true, creditCents: true },
  });

  const accounts = await db.account.findMany({
    where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, type: true },
  });
  const typeById = new Map(accounts.map((a) => [a.id, a.type]));

  const locations = await db.location.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, name: true },
  });
  const nameById = new Map(locations.map((l) => [l.id, l.name]));

  const totals = new Map<string | null, { revenue: Cents; cogs: Cents }>();

  for (const row of grouped) {
    const type = typeById.get(row.accountId);
    if (!type || !INCOME_STATEMENT_TYPES.has(type)) continue;

    const bucket = totals.get(row.locationId) ?? { revenue: ZERO, cogs: ZERO };
    const balance = naturalBalance(type, row._sum.debitCents ?? ZERO, row._sum.creditCents ?? ZERO);

    if (type === 'REVENUE' || type === 'OTHER_INCOME') bucket.revenue += balance;
    else if (type === 'COGS') bucket.cogs += balance;

    totals.set(row.locationId, bucket);
  }

  return [...totals.entries()]
    .map(([locationId, { revenue, cogs }]) => {
      const grossProfit = revenue - cogs;
      return {
        locationId,
        locationName: locationId ? (nameById.get(locationId) ?? 'Unknown') : 'Unassigned',
        revenueCents: revenue,
        cogsCents: cogs,
        grossProfitCents: grossProfit,
        grossMarginPercent: revenue === ZERO ? 0 : Number((grossProfit * 10000n) / revenue) / 100,
      };
    })
    .sort((a, b) => a.locationName.localeCompare(b.locationName));
}

/** Every posted line for one job — the audit trail behind a job-costing figure. */
export async function generalLedgerDetail(
  db: PrismaClient,
  ctx: AuthContext,
  filter: LedgerFilter = {},
) {
  requirePermission(ctx, PERMISSIONS.GL_READ);

  return db.journalLine.findMany({
    where: lineWhere(ctx, filter),
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { lineNo: 'asc' }],
    select: {
      id: true,
      debitCents: true,
      creditCents: true,
      memo: true,
      locationId: true,
      jobId: true,
      account: { select: { code: true, name: true, type: true } },
      journalEntry: {
        select: {
          entryNo: true,
          entryDate: true,
          source: true,
          sourceType: true,
          sourceId: true,
          memo: true,
          isReversal: true,
        },
      },
    },
  });
}
