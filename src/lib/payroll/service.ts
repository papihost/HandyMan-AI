import type { PrismaClient } from '@prisma/client';
import { postingContextFor, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { applyRate, sum, ZERO, type Cents } from '../money';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';

/**
 * Time approval and payroll.
 *
 * Every costed hour in this system credits Payroll Liabilities at the technician's loaded
 * rate — that is what makes job margin honest. Nothing ever relieved it, so the account
 * grew all year and the balance sheet claimed the company owed its technicians a fortune.
 * A payroll run is what settles that, and the residue left in the account afterwards is
 * the most useful number in here: it is the loaded rate being wrong, measured.
 *
 * This is a register and an entry, not a payroll processor. Withholding, filings and
 * year-end forms belong to whoever the shop pays to do them; what a field service system
 * owes that provider is the hours — approved, attributable to a person and a day, and
 * never paid twice.
 */

const OVERTIME_THRESHOLD_HOURS = 40;
const OVERTIME_MULTIPLIER = 1.5;

const hoursOf = (entry: { minutes: number | null; startedAt: Date; endedAt: Date | null }) => {
  if (entry.minutes !== null) return entry.minutes / 60;
  if (!entry.endedAt) return 0;
  return (entry.endedAt.getTime() - entry.startedAt.getTime()) / 3_600_000;
};

/** Monday of the week a moment falls in, in UTC. */
export function weekStartOf(date: Date): Date {
  const day = date.getUTCDay();
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

export interface TimesheetRow {
  technicianId: string;
  technicianName: string;
  locationName: string | null;
  entryCount: number;
  hours: number;
  billableHours: number;
  approvedHours: number;
  /** Hours already paid by a run, which cannot be un-approved. */
  paidHours: number;
  entries: {
    id: string;
    startedAt: Date;
    hours: number;
    kind: string;
    jobNo: string | null;
    isBillable: boolean;
    isApproved: boolean;
    paid: boolean;
  }[];
}

/**
 * A week of everyone's time, ready to be looked at.
 *
 * Grouped by person rather than by day, because approving time is a conversation about a
 * technician — "Marcus has forty-six hours and eleven of them are drive time" — and not
 * about a Tuesday.
 */
export async function weeklyTimesheets(
  db: PrismaClient,
  ctx: AuthContext,
  weekStart: Date,
): Promise<TimesheetRow[]> {
  requirePermission(ctx, PERMISSIONS.TIME_APPROVE);

  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const entries = await db.timeEntry.findMany({
    where: {
      technician: {
        organizationId: ctx.organizationId,
        ...(ctx.scope !== 'ALL' && ctx.locationIds.length
          ? { user: { userLocations: { some: { locationId: { in: ctx.locationIds } } } } }
          : {}),
      },
      startedAt: { gte: weekStart, lt: weekEnd },
    },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      technicianId: true,
      startedAt: true,
      endedAt: true,
      minutes: true,
      kind: true,
      isBillable: true,
      isApproved: true,
      payrollRunId: true,
      job: { select: { jobNo: true, location: { select: { name: true } } } },
      technician: {
        select: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  const byTechnician = new Map<string, TimesheetRow>();

  for (const entry of entries) {
    const hours = hoursOf(entry);
    const row = byTechnician.get(entry.technicianId) ?? {
      technicianId: entry.technicianId,
      technicianName: `${entry.technician.user.firstName} ${entry.technician.user.lastName}`,
      locationName: entry.job?.location?.name ?? null,
      entryCount: 0,
      hours: 0,
      billableHours: 0,
      approvedHours: 0,
      paidHours: 0,
      entries: [],
    };

    row.entryCount += 1;
    row.hours += hours;
    if (entry.isBillable) row.billableHours += hours;
    if (entry.isApproved) row.approvedHours += hours;
    if (entry.payrollRunId) row.paidHours += hours;
    row.entries.push({
      id: entry.id,
      startedAt: entry.startedAt,
      hours,
      kind: entry.kind,
      jobNo: entry.job?.jobNo ?? null,
      isBillable: entry.isBillable,
      isApproved: entry.isApproved,
      paid: entry.payrollRunId !== null,
    });

    byTechnician.set(entry.technicianId, row);
  }

  return [...byTechnician.values()].sort((a, b) =>
    a.technicianName.localeCompare(b.technicianName),
  );
}

/**
 * Approve, or take an approval back.
 *
 * Time that a run has already paid cannot be touched: the money has gone, and the way to
 * fix a mistake in it is an adjustment on the next run, not a quiet edit to what was paid.
 */
export async function approveTime(
  db: PrismaClient,
  ctx: AuthContext,
  input: { entryIds: string[]; approved: boolean },
) {
  requirePermission(ctx, PERMISSIONS.TIME_APPROVE);
  if (input.entryIds.length === 0) return { changed: 0 };

  const entries = await db.timeEntry.findMany({
    where: {
      id: { in: input.entryIds },
      technician: { organizationId: ctx.organizationId },
    },
    select: { id: true, payrollRunId: true },
  });
  if (entries.length !== input.entryIds.length) {
    throw new ValidationError('Some of that time does not belong to this company');
  }

  const paid = entries.filter((entry) => entry.payrollRunId !== null);
  if (paid.length > 0) {
    throw new ValidationError(
      `${paid.length} of those hours have already been paid — correct them on the next run instead`,
    );
  }

  const { count } = await db.timeEntry.updateMany({
    where: { id: { in: entries.map((entry) => entry.id) } },
    data: input.approved
      ? {
          isApproved: true,
          approvedAt: new Date(),
          approvedByUserId: ctx.userId === 'system' ? null : ctx.userId,
        }
      : { isApproved: false, approvedAt: null, approvedByUserId: null },
  });

  return { changed: count };
}

export interface PayrollLine {
  technicianId: string;
  technicianName: string;
  regularHours: number;
  overtimeHours: number;
  baseHourlyCents: Cents;
  grossCents: Cents;
  employerTaxCents: Cents;
  benefitsCents: Cents;
  totalCostCents: Cents;
  entryIds: string[];
}

export interface PayrollPreview {
  periodStart: Date;
  periodEnd: Date;
  lines: PayrollLine[];
  regularHours: number;
  overtimeHours: number;
  grossCents: Cents;
  employerTaxCents: Cents;
  benefitsCents: Cents;
  totalCostCents: Cents;
  /** What the jobs accrued into Payroll Liabilities, all time. */
  accruedCents: Cents;
  unapprovedHours: number;
}

/**
 * What a run would pay.
 *
 * Overtime is counted per week rather than across the period, because that is how it is
 * owed: two forty-five hour weeks are ten hours of overtime, not five, and a fortnightly
 * run that adds the hours up first quietly underpays everybody.
 */
export async function payrollPreview(
  db: PrismaClient,
  ctx: AuthContext,
  input: { periodStart: Date; periodEnd: Date },
): Promise<PayrollPreview> {
  requirePermission(ctx, PERMISSIONS.PAYROLL_READ);

  const entries = await db.timeEntry.findMany({
    where: {
      technician: { organizationId: ctx.organizationId },
      startedAt: { gte: input.periodStart, lt: input.periodEnd },
      isApproved: true,
      payrollRunId: null,
    },
    select: {
      id: true,
      technicianId: true,
      startedAt: true,
      endedAt: true,
      minutes: true,
      technician: {
        select: {
          user: { select: { firstName: true, lastName: true } },
          burdenRates: {
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
            select: {
              baseHourlyCents: true,
              payrollTaxRate: true,
              workersCompRate: true,
              benefitsRate: true,
            },
          },
        },
      },
    },
  });

  const unapproved = await db.timeEntry.findMany({
    where: {
      technician: { organizationId: ctx.organizationId },
      startedAt: { gte: input.periodStart, lt: input.periodEnd },
      isApproved: false,
    },
    select: { minutes: true, startedAt: true, endedAt: true },
  });

  interface Bucket {
    name: string;
    rate: (typeof entries)[number]['technician']['burdenRates'][number] | undefined;
    weeks: Map<number, number>;
    entryIds: string[];
  }

  const buckets = new Map<string, Bucket>();

  for (const entry of entries) {
    const bucket = buckets.get(entry.technicianId) ?? {
      name: `${entry.technician.user.firstName} ${entry.technician.user.lastName}`,
      rate: entry.technician.burdenRates[0],
      weeks: new Map<number, number>(),
      entryIds: [],
    };
    const week = weekStartOf(entry.startedAt).getTime();
    bucket.weeks.set(week, (bucket.weeks.get(week) ?? 0) + hoursOf(entry));
    bucket.entryIds.push(entry.id);
    buckets.set(entry.technicianId, bucket);
  }

  const lines: PayrollLine[] = [];

  for (const [technicianId, bucket] of buckets) {
    if (!bucket.rate || bucket.rate.baseHourlyCents <= ZERO) continue;

    let regular = 0;
    let overtime = 0;
    for (const hours of bucket.weeks.values()) {
      regular += Math.min(hours, OVERTIME_THRESHOLD_HOURS);
      overtime += Math.max(0, hours - OVERTIME_THRESHOLD_HOURS);
    }

    const base = bucket.rate.baseHourlyCents;
    const payableHours = regular + overtime * OVERTIME_MULTIPLIER;
    const gross = (base * BigInt(Math.round(payableHours * 100))) / 100n;
    const employerTax =
      applyRate(gross, bucket.rate.payrollTaxRate.toString()) +
      applyRate(gross, bucket.rate.workersCompRate.toString());
    const benefits = applyRate(gross, bucket.rate.benefitsRate.toString());

    lines.push({
      technicianId,
      technicianName: bucket.name,
      regularHours: Math.round(regular * 100) / 100,
      overtimeHours: Math.round(overtime * 100) / 100,
      baseHourlyCents: base,
      grossCents: gross,
      employerTaxCents: employerTax,
      benefitsCents: benefits,
      totalCostCents: gross + employerTax + benefits,
      entryIds: bucket.entryIds,
    });
  }

  lines.sort((a, b) => a.technicianName.localeCompare(b.technicianName));

  const accrued = await db.journalLine.aggregate({
    where: {
      account: { organizationId: ctx.organizationId, code: ACCOUNTS.PAYROLL_LIABILITIES },
      journalEntry: { postedAt: { not: null } },
    },
    _sum: { creditCents: true, debitCents: true },
  });

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines,
    regularHours: lines.reduce((total, line) => total + line.regularHours, 0),
    overtimeHours: lines.reduce((total, line) => total + line.overtimeHours, 0),
    grossCents: sum(lines.map((line) => line.grossCents)),
    employerTaxCents: sum(lines.map((line) => line.employerTaxCents)),
    benefitsCents: sum(lines.map((line) => line.benefitsCents)),
    totalCostCents: sum(lines.map((line) => line.totalCostCents)),
    accruedCents: (accrued._sum.creditCents ?? ZERO) - (accrued._sum.debitCents ?? ZERO),
    unapprovedHours:
      Math.round(unapproved.reduce((total, entry) => total + hoursOf(entry), 0) * 100) / 100,
  };
}

/**
 * Run it.
 *
 *   Dr  Payroll Liabilities        what this period actually cost
 *     Cr  Payroll Bank Account     the money that leaves for it
 *
 * The debit relieves what the jobs accrued. It will not match exactly and is not meant to:
 * the accrual is a loaded rate applied to costed hours, and this is what the people were
 * actually owed. What stays behind in the account is the gap between the two, which is the
 * only honest measure of whether the loaded rate is right.
 */
export async function runPayroll(
  db: PrismaClient,
  ctx: AuthContext,
  input: { periodStart: Date; periodEnd: Date; payDate?: Date; bankAccountCode?: string },
) {
  requirePermission(ctx, PERMISSIONS.PAYROLL_MANAGE);

  // Order matters: a period that overlaps a finished run has had its hours stamped already,
  // so the preview would come back empty and report the wrong reason for the refusal.
  const overlapping = await db.payrollRun.findFirst({
    where: {
      organizationId: ctx.organizationId,
      periodStart: { lt: input.periodEnd },
      periodEnd: { gt: input.periodStart },
    },
    select: { runNo: true },
  });
  if (overlapping) {
    throw new ValidationError(`${overlapping.runNo} already covers part of that period`);
  }

  const preview = await payrollPreview(db, ctx, input);
  if (preview.lines.length === 0) {
    throw new ValidationError('No approved hours in that period');
  }

  const payDate = input.payDate ?? input.periodEnd;
  const bankCode = input.bankAccountCode ?? ACCOUNTS.BANK_PAYROLL;

  const run = await db.$transaction(async (tx) => {
    const runNo = await nextDocumentNumber(tx, ctx.organizationId, 'PAYROLL_RUN');

    const created = await tx.payrollRun.create({
      data: {
        organizationId: ctx.organizationId,
        runNo,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payDate,
        regularHours: preview.regularHours.toFixed(2),
        overtimeHours: preview.overtimeHours.toFixed(2),
        grossCents: preview.grossCents,
        employerTaxCents: preview.employerTaxCents,
        benefitsCents: preview.benefitsCents,
        totalCostCents: preview.totalCostCents,
        status: 'POSTED',
        createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
        lines: {
          create: preview.lines.map((line) => ({
            technicianId: line.technicianId,
            regularHours: line.regularHours.toFixed(2),
            overtimeHours: line.overtimeHours.toFixed(2),
            baseHourlyCents: line.baseHourlyCents,
            grossCents: line.grossCents,
            employerTaxCents: line.employerTaxCents,
            benefitsCents: line.benefitsCents,
            totalCostCents: line.totalCostCents,
          })),
        },
      },
    });

    // Stamped before the posting, so an hour cannot be picked up by a second run even if
    // two people press the button at the same moment.
    await tx.timeEntry.updateMany({
      where: { id: { in: preview.lines.flatMap((line) => line.entryIds) } },
      data: { payrollRunId: created.id },
    });

    return created;
  });

  const entry = await postJournalEntry(db, postingContextFor(ctx), {
    entryDate: payDate,
    source: 'PAYROLL',
    sourceType: 'PayrollRun',
    sourceId: run.id,
    memo: `Payroll ${run.runNo} — ${input.periodStart.toISOString().slice(0, 10)} to ${input.periodEnd.toISOString().slice(0, 10)}`,
    lines: [
      { accountCode: ACCOUNTS.PAYROLL_LIABILITIES, debitCents: preview.totalCostCents },
      { accountCode: bankCode, creditCents: preview.totalCostCents },
    ],
  });

  const posted = await db.payrollRun.update({
    where: { id: run.id },
    data: { journalEntryId: entry.id },
    include: { lines: true },
  });

  return { run: posted, journalEntryId: entry.id, preview };
}

export async function payrollRuns(db: PrismaClient, ctx: AuthContext, take = 24) {
  requirePermission(ctx, PERMISSIONS.PAYROLL_READ);

  return db.payrollRun.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { payDate: 'desc' },
    take,
    include: { _count: { select: { lines: true } } },
  });
}

/** The gap between what the jobs accrued and what payroll actually paid. */
export async function accrualVariance(db: PrismaClient, ctx: AuthContext) {
  requirePermission(ctx, PERMISSIONS.PAYROLL_READ);

  const [accrual, runs] = await Promise.all([
    db.journalLine.aggregate({
      where: {
        account: { organizationId: ctx.organizationId, code: ACCOUNTS.PAYROLL_LIABILITIES },
        journalEntry: { postedAt: { not: null } },
      },
      _sum: { creditCents: true, debitCents: true },
    }),
    db.payrollRun.aggregate({
      where: { organizationId: ctx.organizationId, status: 'POSTED' },
      _sum: { totalCostCents: true },
    }),
  ]);

  const accruedCents = accrual._sum.creditCents ?? ZERO;
  const paidCents = runs._sum.totalCostCents ?? ZERO;
  const outstandingCents = accruedCents - (accrual._sum.debitCents ?? ZERO);

  return {
    accruedCents,
    paidCents,
    /** What Payroll Liabilities is still holding. */
    outstandingCents,
    percentOff:
      accruedCents === ZERO
        ? 0
        : Math.round(Number(((accruedCents - paidCents) * 1000n) / accruedCents)) / 10,
  };
}

/**
 * The period a run would cover if nobody said otherwise.
 *
 * Fortnightly from wherever the last run stopped, because that is the only boundary that
 * cannot leave a gap: picking "the last two weeks" instead would silently skip any hours
 * approved late, and those are exactly the hours somebody is waiting to be paid for.
 */
export async function nextPayrollPeriod(
  db: PrismaClient,
  ctx: AuthContext,
): Promise<{ periodStart: Date; periodEnd: Date }> {
  requirePermission(ctx, PERMISSIONS.PAYROLL_READ);

  const last = await db.payrollRun.findFirst({
    where: { organizationId: ctx.organizationId },
    orderBy: { periodEnd: 'desc' },
    select: { periodEnd: true },
  });

  if (last) {
    const periodStart = last.periodEnd;
    return {
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 14 * 86_400_000),
    };
  }

  const earliest = await db.timeEntry.findFirst({
    where: {
      technician: { organizationId: ctx.organizationId },
      isApproved: true,
      payrollRunId: null,
    },
    orderBy: { startedAt: 'asc' },
    select: { startedAt: true },
  });

  const periodStart = weekStartOf(earliest?.startedAt ?? new Date());
  return { periodStart, periodEnd: new Date(periodStart.getTime() + 14 * 86_400_000) };
}
