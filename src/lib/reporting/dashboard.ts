import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { sum, ZERO, type Cents } from '../money';
import { ACCOUNTS, INCOME_STATEMENT_TYPES, naturalBalance } from '../accounting/chart-of-accounts';

/**
 * The numbers an owner and a controller actually look at.
 *
 * All of it is read from posted journal lines. Nothing here is cached in a summary table,
 * because the moment a dashboard figure can disagree with the general ledger, one of them
 * is wrong and nobody can tell which — and the first thing a prospect's controller does is
 * drill into a number.
 */

export interface Period {
  from: Date;
  to: Date;
}

export interface CompanySummary {
  revenueCents: Cents;
  cogsCents: Cents;
  grossProfitCents: Cents;
  grossMarginPercent: number;
  operatingExpenseCents: Cents;
  netIncomeCents: Cents;
  netMarginPercent: number;
  cashCents: Cents;
  receivablesCents: Cents;
  payablesCents: Cents;
  /** Completed work nobody has billed. Money sitting on the table. */
  unbilledCents: Cents;
  unbilledJobCount: number;
}

/** Account balances for a period, keyed by code. */
async function balancesByAccount(
  db: PrismaClient,
  ctx: AuthContext,
  period?: Period,
): Promise<Map<string, { code: string; type: string; balance: Cents }>> {
  const grouped = await db.journalLine.groupBy({
    by: ['accountId'],
    where: {
      journalEntry: {
        organizationId: ctx.organizationId,
        postedAt: { not: null },
        ...(period ? { entryDate: { gte: period.from, lte: period.to } } : {}),
      },
      ...(ctx.scope !== 'ALL' && ctx.locationIds.length
        ? { locationId: { in: ctx.locationIds } }
        : {}),
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const accounts = await db.account.findMany({
    where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
    select: { id: true, code: true, type: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const result = new Map<string, { code: string; type: string; balance: Cents }>();
  for (const row of grouped) {
    const account = byId.get(row.accountId);
    if (!account) continue;
    result.set(account.code, {
      code: account.code,
      type: account.type,
      balance: naturalBalance(
        account.type,
        row._sum.debitCents ?? ZERO,
        row._sum.creditCents ?? ZERO,
      ),
    });
  }
  return result;
}

export async function companySummary(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
): Promise<CompanySummary> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);

  const [forPeriod, toDate, unbilled] = await Promise.all([
    balancesByAccount(db, ctx, period),
    // Balance sheet figures are cumulative, not period movements.
    balancesByAccount(db, ctx),
    unbilledCompletedJobs(db, ctx),
  ]);

  const byType = (types: string[]) =>
    sum(
      [...forPeriod.values()].filter((row) => types.includes(row.type)).map((row) => row.balance),
    );

  const revenue = byType(['REVENUE', 'OTHER_INCOME']);
  const cogs = byType(['COGS']);
  const opex = byType(['EXPENSE', 'OTHER_EXPENSE']);
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - opex;

  const percent = (part: Cents, whole: Cents) =>
    whole === ZERO ? 0 : Number((part * 1000n) / whole) / 10;

  return {
    revenueCents: revenue,
    cogsCents: cogs,
    grossProfitCents: grossProfit,
    grossMarginPercent: percent(grossProfit, revenue),
    operatingExpenseCents: opex,
    netIncomeCents: netIncome,
    netMarginPercent: percent(netIncome, revenue),
    cashCents:
      (toDate.get(ACCOUNTS.BANK_OPERATING)?.balance ?? ZERO) +
      (toDate.get(ACCOUNTS.BANK_PAYROLL)?.balance ?? ZERO),
    receivablesCents: toDate.get(ACCOUNTS.AR)?.balance ?? ZERO,
    payablesCents: toDate.get(ACCOUNTS.AP)?.balance ?? ZERO,
    unbilledCents: unbilled.totalCents,
    unbilledJobCount: unbilled.jobs.length,
  };
}

export interface ServiceTypeMargin {
  serviceTypeId: string | null;
  name: string;
  revenueCents: Cents;
  cogsCents: Cents;
  grossProfitCents: Cents;
  grossMarginPercent: number;
  /** Well below the company's own average — the line worth asking about. */
  isOutlier: boolean;
}

/**
 * Margin by service line, and which line is quietly the problem.
 *
 * An outlier is judged against this company's own average rather than an industry figure,
 * because a shop running at 55% and a shop running at 35% have different problems and the
 * report should point at the same kind of thing in both.
 */
export async function marginByServiceType(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
  options: { locationId?: string } = {},
): Promise<ServiceTypeMargin[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);

  const grouped = await db.journalLine.groupBy({
    by: ['serviceTypeId', 'accountId'],
    where: {
      journalEntry: {
        organizationId: ctx.organizationId,
        postedAt: { not: null },
        entryDate: { gte: period.from, lte: period.to },
      },
      serviceTypeId: { not: null },
      ...(options.locationId ? { locationId: options.locationId } : {}),
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const [accounts, serviceTypes] = await Promise.all([
    db.account.findMany({
      where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
      select: { id: true, type: true },
    }),
    db.serviceType.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const typeById = new Map(accounts.map((a) => [a.id, a.type]));
  const nameById = new Map(serviceTypes.map((s) => [s.id, s.name]));
  const totals = new Map<string, { revenue: Cents; cogs: Cents }>();

  for (const row of grouped) {
    const accountType = typeById.get(row.accountId);
    if (!accountType || !INCOME_STATEMENT_TYPES.has(accountType as never)) continue;

    const bucket = totals.get(row.serviceTypeId!) ?? { revenue: ZERO, cogs: ZERO };
    const balance = naturalBalance(
      accountType as never,
      row._sum.debitCents ?? ZERO,
      row._sum.creditCents ?? ZERO,
    );

    if (accountType === 'REVENUE' || accountType === 'OTHER_INCOME') bucket.revenue += balance;
    else if (accountType === 'COGS') bucket.cogs += balance;
    totals.set(row.serviceTypeId!, bucket);
  }

  const rows = [...totals.entries()].map(([serviceTypeId, { revenue, cogs }]) => {
    const grossProfit = revenue - cogs;
    return {
      serviceTypeId,
      name: nameById.get(serviceTypeId) ?? 'Unassigned',
      revenueCents: revenue,
      cogsCents: cogs,
      grossProfitCents: grossProfit,
      grossMarginPercent: revenue === ZERO ? 0 : Number((grossProfit * 1000n) / revenue) / 10,
      isOutlier: false,
    };
  });

  const totalRevenue = sum(rows.map((r) => r.revenueCents));
  const totalProfit = sum(rows.map((r) => r.grossProfitCents));
  const companyMargin =
    totalRevenue === ZERO ? 0 : Number((totalProfit * 1000n) / totalRevenue) / 10;

  for (const row of rows) {
    // Fifteen points below the company's own average, on a line big enough to matter.
    row.isOutlier =
      row.grossMarginPercent < companyMargin - 15 && row.revenueCents > 100_00n;
  }

  return rows.sort((a, b) => a.grossMarginPercent - b.grossMarginPercent);
}

export interface TechnicianScore {
  technicianId: string;
  name: string;
  locationName: string;
  jobsCompleted: number;
  revenueCents: Cents;
  averageTicketCents: Cents;
  /** Hours costed to a job, against hours paid. The number that moves profit. */
  utilizationPercent: number;
  billableHours: number;
  paidHours: number;
  callbacks: number;
  callbackRatePercent: number;
}

/**
 * The technician scorecard.
 *
 * Utilization comes from the ledger rather than from a timesheet: labour costed to a job
 * against all labour costed for that technician. Hours nobody billed are posted with no
 * job against them, so the split is already there — and it cannot drift from the P&L,
 * because it *is* the P&L.
 */
export async function technicianScorecard(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
): Promise<TechnicianScore[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const technicians = await db.technician.findMany({
    where: { organizationId: ctx.organizationId, isActive: true },
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
      burdenRates: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { baseHourlyCents: true } },
      jobAssignments: {
        where: {
          isLead: true,
          job: {
            organizationId: ctx.organizationId,
            completedAt: { gte: period.from, lte: period.to },
          },
        },
        select: {
          job: {
            select: {
              id: true,
              isWarranty: true,
              revenueCents: true,
              location: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const labourAccount = await db.account.findFirst({
    where: { organizationId: ctx.organizationId, code: ACCOUNTS.COGS_LABOR },
    select: { id: true },
  });

  const labourLines = labourAccount
    ? await db.journalLine.groupBy({
        by: ['technicianId', 'jobId'],
        where: {
          accountId: labourAccount.id,
          technicianId: { not: null },
          journalEntry: {
            organizationId: ctx.organizationId,
            postedAt: { not: null },
            entryDate: { gte: period.from, lte: period.to },
          },
        },
        _sum: { debitCents: true },
      })
    : [];

  const wageByTech = new Map<string, { billable: Cents; total: Cents }>();
  for (const row of labourLines) {
    const bucket = wageByTech.get(row.technicianId!) ?? { billable: ZERO, total: ZERO };
    const wage = row._sum.debitCents ?? ZERO;
    bucket.total += wage;
    if (row.jobId) bucket.billable += wage;
    wageByTech.set(row.technicianId!, bucket);
  }

  return technicians
    .map((technician) => {
      const jobs = technician.jobAssignments.map((a) => a.job);
      const billed = jobs.filter((job) => !job.isWarranty);
      const callbacks = jobs.filter((job) => job.isWarranty).length;

      const revenue = sum(billed.map((job) => job.revenueCents));
      const wages = wageByTech.get(technician.id) ?? { billable: ZERO, total: ZERO };
      const rate = technician.burdenRates[0]?.baseHourlyCents ?? ZERO;

      const hours = (cents: Cents) => (rate === ZERO ? 0 : Number((cents * 100n) / rate) / 100);

      return {
        technicianId: technician.id,
        name: `${technician.user.firstName} ${technician.user.lastName}`,
        locationName: jobs[0]?.location.name ?? '—',
        jobsCompleted: billed.length,
        revenueCents: revenue,
        averageTicketCents: billed.length === 0 ? ZERO : revenue / BigInt(billed.length),
        utilizationPercent:
          wages.total === ZERO ? 0 : Number((wages.billable * 1000n) / wages.total) / 10,
        billableHours: Math.round(hours(wages.billable)),
        paidHours: Math.round(hours(wages.total)),
        callbacks,
        callbackRatePercent:
          billed.length === 0 ? 0 : Math.round((callbacks / billed.length) * 1000) / 10,
      };
    })
    .filter((row) => row.jobsCompleted > 0 || row.paidHours > 0)
    .sort((a, b) => Number(b.revenueCents - a.revenueCents));
}

/**
 * Completed work nobody has invoiced.
 *
 * The most immediately actionable number on the dashboard: it is already earned, the
 * customer is expecting the bill, and every day it sits there is a day of someone else's
 * cash flow.
 */
export async function unbilledCompletedJobs(db: PrismaClient, ctx: AuthContext) {
  const jobs = await db.job.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: 'COMPLETED',
      isBillable: true,
      invoices: { none: {} },
      lines: { some: {} },
      ...(ctx.scope !== 'ALL' && ctx.locationIds.length
        ? { locationId: { in: ctx.locationIds } }
        : {}),
    },
    orderBy: { completedAt: 'asc' },
    take: 100,
    select: {
      id: true,
      jobNo: true,
      title: true,
      completedAt: true,
      location: { select: { name: true } },
      customer: { select: { companyName: true, firstName: true, lastName: true } },
      lines: { select: { totalCents: true } },
    },
  });

  const rows = jobs.map((job) => ({
    id: job.id,
    jobNo: job.jobNo,
    title: job.title,
    completedAt: job.completedAt,
    locationName: job.location.name,
    customerName:
      job.customer.companyName ??
      [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' '),
    valueCents: sum(job.lines.map((line) => line.totalCents)),
    daysWaiting: job.completedAt
      ? Math.floor((Date.now() - job.completedAt.getTime()) / 86_400_000)
      : 0,
  }));

  return { jobs: rows, totalCents: sum(rows.map((row) => row.valueCents)) };
}

/** Today's work, by technician — the dispatch board's data. */
export async function dispatchBoard(db: PrismaClient, ctx: AuthContext, day: Date) {
  requirePermission(ctx, PERMISSIONS.JOB_READ);

  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);

  const jobs = await db.job.findMany({
    where: {
      organizationId: ctx.organizationId,
      scheduledStart: { gte: start, lt: end },
      status: { not: 'CANCELLED' },
      ...(ctx.scope !== 'ALL' && ctx.locationIds.length
        ? { locationId: { in: ctx.locationIds } }
        : {}),
    },
    orderBy: { scheduledStart: 'asc' },
    select: {
      id: true,
      jobNo: true,
      title: true,
      status: true,
      priority: true,
      isWarranty: true,
      scheduledStart: true,
      location: { select: { code: true, name: true } },
      customer: { select: { companyName: true, firstName: true, lastName: true } },
      property: { select: { city: true } },
      assignments: {
        where: { isLead: true },
        select: {
          technician: { select: { id: true, user: { select: { firstName: true, lastName: true } } } },
        },
      },
    },
  });

  const byTechnician = new Map<
    string,
    { technicianId: string | null; name: string; jobs: typeof jobs }
  >();

  for (const job of jobs) {
    const lead = job.assignments[0]?.technician;
    const key = lead?.id ?? 'unassigned';
    const existing = byTechnician.get(key) ?? {
      technicianId: lead?.id ?? null,
      // Unassigned work is a column of its own, because it is the dispatcher's next move.
      name: lead ? `${lead.user.firstName} ${lead.user.lastName}` : 'Unassigned',
      jobs: [] as typeof jobs,
    };
    existing.jobs.push(job);
    byTechnician.set(key, existing);
  }

  return [...byTechnician.values()].sort((a, b) => {
    if (a.name === 'Unassigned') return -1;
    if (b.name === 'Unassigned') return 1;
    return a.name.localeCompare(b.name);
  });
}

export interface BranchServiceMargin {
  locationId: string;
  locationName: string;
  serviceTypeId: string;
  serviceName: string;
  revenueCents: Cents;
  cogsCents: Cents;
  grossProfitCents: Cents;
  grossMarginPercent: number;
  /** How far below the same trade's margin at the other branches. */
  pointsBelowTradeAverage: number;
}

/**
 * Margin by branch and trade, worst first.
 *
 * A trade averaged across every branch hides the thing worth finding. Drywall can look
 * healthy company-wide while one branch sells it below what it costs them — the other
 * branches carry the average, and nobody notices for a year.
 *
 * Each cell is judged against the same trade elsewhere, not against the company, because
 * trades genuinely differ: a plumbing job and a painting job are not supposed to earn the
 * same margin, and comparing them produces false alarms instead of findings.
 */
export async function marginByBranchAndService(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
  options: { minimumRevenueCents?: Cents } = {},
): Promise<BranchServiceMargin[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);

  const grouped = await db.journalLine.groupBy({
    by: ['locationId', 'serviceTypeId', 'accountId'],
    where: {
      journalEntry: {
        organizationId: ctx.organizationId,
        postedAt: { not: null },
        entryDate: { gte: period.from, lte: period.to },
      },
      locationId: { not: null },
      serviceTypeId: { not: null },
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const [accounts, locations, serviceTypes] = await Promise.all([
    db.account.findMany({
      where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
      select: { id: true, type: true },
    }),
    db.location.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
    db.serviceType.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const typeById = new Map(accounts.map((a) => [a.id, a.type]));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));
  const serviceName = new Map(serviceTypes.map((s) => [s.id, s.name]));

  const cells = new Map<string, { revenue: Cents; cogs: Cents }>();
  for (const row of grouped) {
    const accountType = typeById.get(row.accountId);
    if (!accountType || !INCOME_STATEMENT_TYPES.has(accountType as never)) continue;

    const key = `${row.locationId}|${row.serviceTypeId}`;
    const bucket = cells.get(key) ?? { revenue: ZERO, cogs: ZERO };
    const balance = naturalBalance(
      accountType as never,
      row._sum.debitCents ?? ZERO,
      row._sum.creditCents ?? ZERO,
    );

    if (accountType === 'REVENUE' || accountType === 'OTHER_INCOME') bucket.revenue += balance;
    else if (accountType === 'COGS') bucket.cogs += balance;
    cells.set(key, bucket);
  }

  const minimum = options.minimumRevenueCents ?? 1_000_00n;
  const rows = [...cells.entries()]
    .map(([key, { revenue, cogs }]) => {
      const [locationId, serviceTypeId] = key.split('|');
      const grossProfit = revenue - cogs;
      return {
        locationId,
        locationName: locationName.get(locationId) ?? 'Unknown',
        serviceTypeId,
        serviceName: serviceName.get(serviceTypeId) ?? 'Unassigned',
        revenueCents: revenue,
        cogsCents: cogs,
        grossProfitCents: grossProfit,
        grossMarginPercent: revenue === ZERO ? 0 : Number((grossProfit * 1000n) / revenue) / 10,
        pointsBelowTradeAverage: 0,
      };
    })
    .filter((row) => row.revenueCents >= minimum);

  // Each trade's own average across the branches that sell it.
  const tradeAverage = new Map<string, number>();
  for (const serviceTypeId of new Set(rows.map((r) => r.serviceTypeId))) {
    const trade = rows.filter((r) => r.serviceTypeId === serviceTypeId);
    const revenue = sum(trade.map((r) => r.revenueCents));
    const profit = sum(trade.map((r) => r.grossProfitCents));
    tradeAverage.set(
      serviceTypeId,
      revenue === ZERO ? 0 : Number((profit * 1000n) / revenue) / 10,
    );
  }

  for (const row of rows) {
    row.pointsBelowTradeAverage =
      (tradeAverage.get(row.serviceTypeId) ?? 0) - row.grossMarginPercent;
  }

  return rows.sort((a, b) => b.pointsBelowTradeAverage - a.pointsBelowTradeAverage);
}

export interface BranchLabourApplication {
  locationId: string;
  locationName: string;
  revenueCents: Cents;
  /** Cost that landed on a job, and therefore on a trade. */
  appliedCostCents: Cents;
  /** Cost that landed on the branch and nothing else. Paid time nobody sold. */
  unappliedCostCents: Cents;
  unappliedPercentOfRevenue: number;
  /** How far above the best-run branch's share of unapplied cost. */
  pointsAboveBest: number;
}

/**
 * Where a branch's margin actually goes.
 *
 * Margin by trade only sees cost that reached a job. Paid hours that never reached one —
 * waiting, driving, a truck sent to a call that got cancelled — land on the branch with no
 * job and no trade against them, so a branch can price every trade exactly like its
 * siblings and still finish fifteen points behind them.
 *
 * That gap is the difference between the branch table and the trade table on the same
 * screen, and it is the more useful finding of the two: a pricing problem is a
 * conversation with a price book, an application problem is a conversation with a
 * dispatch board.
 */
export async function unappliedLabourByBranch(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
): Promise<BranchLabourApplication[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const grouped = await db.journalLine.groupBy({
    by: ['locationId', 'accountId', 'serviceTypeId'],
    where: {
      journalEntry: {
        organizationId: ctx.organizationId,
        postedAt: { not: null },
        entryDate: { gte: period.from, lte: period.to },
      },
      locationId: { not: null },
    },
    _sum: { debitCents: true, creditCents: true },
  });

  const [accounts, locations] = await Promise.all([
    db.account.findMany({
      where: { organizationId: ctx.organizationId, id: { in: grouped.map((g) => g.accountId) } },
      select: { id: true, type: true },
    }),
    db.location.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const typeById = new Map(accounts.map((a) => [a.id, a.type]));
  const nameById = new Map(locations.map((l) => [l.id, l.name]));

  const byBranch = new Map<string, { revenue: Cents; applied: Cents; unapplied: Cents }>();
  for (const row of grouped) {
    const accountType = typeById.get(row.accountId);
    if (accountType !== 'REVENUE' && accountType !== 'OTHER_INCOME' && accountType !== 'COGS') {
      continue;
    }

    const bucket = byBranch.get(row.locationId!) ?? {
      revenue: ZERO,
      applied: ZERO,
      unapplied: ZERO,
    };
    const balance = naturalBalance(
      accountType as never,
      row._sum.debitCents ?? ZERO,
      row._sum.creditCents ?? ZERO,
    );

    if (accountType === 'COGS') {
      if (row.serviceTypeId) bucket.applied += balance;
      else bucket.unapplied += balance;
    } else {
      bucket.revenue += balance;
    }
    byBranch.set(row.locationId!, bucket);
  }

  const rows = [...byBranch.entries()].map(([locationId, bucket]) => ({
    locationId,
    locationName: nameById.get(locationId) ?? 'Unknown',
    revenueCents: bucket.revenue,
    appliedCostCents: bucket.applied,
    unappliedCostCents: bucket.unapplied,
    unappliedPercentOfRevenue:
      bucket.revenue === ZERO ? 0 : Number((bucket.unapplied * 1000n) / bucket.revenue) / 10,
    pointsAboveBest: 0,
  }));

  const best = Math.min(...rows.map((row) => row.unappliedPercentOfRevenue));
  for (const row of rows) {
    row.pointsAboveBest = Math.round((row.unappliedPercentOfRevenue - best) * 10) / 10;
  }

  return rows.sort((a, b) => b.unappliedPercentOfRevenue - a.unappliedPercentOfRevenue);
}

export interface FlatRateLine {
  priceBookItemId: string;
  sku: string;
  name: string;
  serviceName: string;
  timesSold: number;
  revenueCents: Cents;
  standardCostCents: Cents;
  marginPercent: number;
  /** Branches selling it at a different price, worst margin first. */
  branches: {
    locationId: string;
    locationName: string;
    timesSold: number;
    revenueCents: Cents;
    standardCostCents: Cents;
    marginPercent: number;
  }[];
}

/**
 * The flat-rate price list, judged against what the work costs.
 *
 * This is a pricing report, not a P&L: it compares what was billed against the standard
 * cost carried on the line at the time it was billed. That is deliberately not the same
 * question as margin by trade — a trade can look healthy while one flat rate inside it
 * loses money on every call, because the profitable items in the same trade carry it.
 *
 * A price that has not moved while its cost did is invisible in revenue, invisible in
 * volume, and obvious here.
 */
export async function flatRateReview(
  db: PrismaClient,
  ctx: AuthContext,
  period: Period,
  options: { minimumTimesSold?: number } = {},
): Promise<FlatRateLine[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_OPERATIONAL);
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const rows = await db.$queryRaw<
    {
      priceBookItemId: string;
      locationId: string;
      timesSold: bigint;
      revenueCents: bigint;
      costCents: bigint;
    }[]
  >`
    SELECT il."priceBookItemId"                                            AS "priceBookItemId",
           i."locationId"                                                  AS "locationId",
           count(*)                                                        AS "timesSold",
           sum(round(il."unitPriceCents" * il."quantity") - il."discountCents")::bigint
                                                                           AS "revenueCents",
           sum(round(il."unitCostCents" * il."quantity"))::bigint          AS "costCents"
      FROM "InvoiceLine" il
      JOIN "Invoice" i ON i.id = il."invoiceId"
     WHERE i."organizationId" = ${ctx.organizationId}
       AND i."status" <> 'DRAFT'
       AND i."status" <> 'VOID'
       AND i."issueDate" >= ${period.from}
       AND i."issueDate" <= ${period.to}
       AND il."priceBookItemId" IS NOT NULL
       AND il."unitCostCents" > 0
     GROUP BY 1, 2
  `;

  const itemIds = [...new Set(rows.map((row) => row.priceBookItemId))];
  const [items, locations] = await Promise.all([
    db.priceBookItem.findMany({
      where: { organizationId: ctx.organizationId, id: { in: itemIds }, kind: 'FLAT_RATE' },
      select: { id: true, sku: true, name: true, serviceType: { select: { name: true } } },
    }),
    db.location.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  const itemById = new Map(items.map((item) => [item.id, item]));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));
  const margin = (revenue: Cents, cost: Cents) =>
    revenue === ZERO ? 0 : Number(((revenue - cost) * 1000n) / revenue) / 10;

  const byItem = new Map<string, FlatRateLine>();
  for (const row of rows) {
    const item = itemById.get(row.priceBookItemId);
    if (!item) continue;

    const line =
      byItem.get(item.id) ??
      ({
        priceBookItemId: item.id,
        sku: item.sku,
        name: item.name,
        serviceName: item.serviceType?.name ?? 'Unassigned',
        timesSold: 0,
        revenueCents: ZERO,
        standardCostCents: ZERO,
        marginPercent: 0,
        branches: [],
      } satisfies FlatRateLine);

    line.timesSold += Number(row.timesSold);
    line.revenueCents += row.revenueCents;
    line.standardCostCents += row.costCents;
    line.branches.push({
      locationId: row.locationId,
      locationName: locationName.get(row.locationId) ?? 'Unknown',
      timesSold: Number(row.timesSold),
      revenueCents: row.revenueCents,
      standardCostCents: row.costCents,
      marginPercent: margin(row.revenueCents, row.costCents),
    });
    byItem.set(item.id, line);
  }

  const minimum = options.minimumTimesSold ?? 10;
  return [...byItem.values()]
    .filter((line) => line.timesSold >= minimum)
    .map((line) => ({
      ...line,
      marginPercent: margin(line.revenueCents, line.standardCostCents),
      branches: line.branches.sort((a, b) => a.marginPercent - b.marginPercent),
    }))
    .sort((a, b) => a.marginPercent - b.marginPercent);
}
