import type { AccountingPeriod, PrismaClient } from '@prisma/client';
import type { Tx } from '../db';
import { ClosedPeriodError, NotFoundError, ValidationError } from '../errors';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';

/**
 * Accounting periods.
 *
 * A period is a month of the organization's fiscal year. Postings are only accepted into
 * an OPEN period; CLOSED and LOCKED reject them. This is what stops someone editing June
 * in September after the return has been filed.
 *
 * CLOSED can be reopened by a user holding `period:reopen`, and that reopening is audited.
 * LOCKED is permanent — used after a tax filing or an external audit.
 */

/** Generate the twelve periods of a fiscal year. `fiscalYearStartMonth` is 1-12. */
export async function ensureFiscalYear(
  db: PrismaClient | Tx,
  organizationId: string,
  fiscalYear: number,
  fiscalYearStartMonth: number,
): Promise<void> {
  if (fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
    throw new ValidationError('fiscalYearStartMonth must be between 1 and 12');
  }

  const periods = [];
  for (let periodNumber = 1; periodNumber <= 12; periodNumber++) {
    // Month 1 of FY2026 starting in July is July 2025 only if the fiscal year is named
    // for its ending year; we name it for its starting calendar year, so FY2026 P1 is
    // July 2026. This keeps period math independent of naming convention debates.
    const monthOffset = fiscalYearStartMonth - 1 + (periodNumber - 1);
    const calendarYear = fiscalYear + Math.floor(monthOffset / 12);
    const calendarMonth = monthOffset % 12; // 0-indexed for Date.UTC

    const startDate = new Date(Date.UTC(calendarYear, calendarMonth, 1));
    const endDate = new Date(Date.UTC(calendarYear, calendarMonth + 1, 0, 23, 59, 59, 999));

    periods.push({ organizationId, fiscalYear, periodNumber, startDate, endDate });
  }

  await db.accountingPeriod.createMany({ data: periods, skipDuplicates: true });
}

/** The period containing `entryDate`, or null when no fiscal year covers it yet. */
export async function findPeriodFor(
  db: PrismaClient | Tx,
  organizationId: string,
  entryDate: Date,
): Promise<AccountingPeriod | null> {
  return db.accountingPeriod.findFirst({
    where: {
      organizationId,
      startDate: { lte: entryDate },
      endDate: { gte: entryDate },
    },
  });
}

/**
 * Resolve the period a posting belongs to and refuse it if that period is not open.
 * Every posting path calls this — it is the single choke point for the lock.
 */
export async function assertPostingAllowed(
  db: PrismaClient | Tx,
  organizationId: string,
  entryDate: Date,
): Promise<AccountingPeriod> {
  const period = await findPeriodFor(db, organizationId, entryDate);
  if (!period) {
    throw new ValidationError(
      `No accounting period covers ${entryDate.toISOString().slice(0, 10)}. Open the fiscal year first.`,
    );
  }
  if (period.status !== 'OPEN') {
    throw new ClosedPeriodError(entryDate, period.status);
  }
  return period;
}

export async function closePeriod(
  db: PrismaClient,
  ctx: AuthContext,
  periodId: string,
): Promise<AccountingPeriod> {
  requirePermission(ctx, PERMISSIONS.PERIOD_CLOSE);

  return db.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findFirst({
      where: { id: periodId, organizationId: ctx.organizationId },
    });
    if (!period) throw new NotFoundError('Accounting period', periodId);
    if (period.status === 'LOCKED') {
      throw new ValidationError('This period is locked and cannot be modified');
    }
    if (period.status === 'CLOSED') return period;

    // Earlier periods must be closed first, or a correction could be posted behind a
    // closed month and silently restate a reported figure.
    const earlierOpen = await tx.accountingPeriod.findFirst({
      where: {
        organizationId: ctx.organizationId,
        endDate: { lt: period.startDate },
        status: 'OPEN',
      },
      orderBy: { startDate: 'asc' },
    });
    if (earlierOpen) {
      throw new ValidationError(
        `Period ${earlierOpen.fiscalYear}-${String(earlierOpen.periodNumber).padStart(2, '0')} is still open and must be closed first`,
      );
    }

    const closed = await tx.accountingPeriod.update({
      where: { id: periodId },
      data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: ctx.userId },
    });

    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId === 'system' ? null : ctx.userId,
        action: 'CLOSE_PERIOD',
        entityType: 'AccountingPeriod',
        entityId: periodId,
        before: { status: period.status },
        after: { status: 'CLOSED' },
      },
    });

    return closed;
  });
}

export async function reopenPeriod(
  db: PrismaClient,
  ctx: AuthContext,
  periodId: string,
  reason: string,
): Promise<AccountingPeriod> {
  requirePermission(ctx, PERMISSIONS.PERIOD_REOPEN);
  if (!reason?.trim()) {
    throw new ValidationError('A reason is required to reopen a closed period');
  }

  return db.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findFirst({
      where: { id: periodId, organizationId: ctx.organizationId },
    });
    if (!period) throw new NotFoundError('Accounting period', periodId);
    if (period.status === 'LOCKED') {
      throw new ValidationError('This period is locked and can never be reopened');
    }

    const reopened = await tx.accountingPeriod.update({
      where: { id: periodId },
      data: { status: 'OPEN', reopenedAt: new Date(), reopenedByUserId: ctx.userId },
    });

    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId === 'system' ? null : ctx.userId,
        action: 'REOPEN_PERIOD',
        entityType: 'AccountingPeriod',
        entityId: periodId,
        before: { status: period.status },
        after: { status: 'OPEN', reason },
      },
    });

    return reopened;
  });
}

export async function lockPeriod(
  db: PrismaClient,
  ctx: AuthContext,
  periodId: string,
): Promise<AccountingPeriod> {
  requirePermission(ctx, PERMISSIONS.PERIOD_CLOSE);

  const period = await db.accountingPeriod.findFirst({
    where: { id: periodId, organizationId: ctx.organizationId },
  });
  if (!period) throw new NotFoundError('Accounting period', periodId);
  if (period.status === 'OPEN') {
    throw new ValidationError('Close the period before locking it');
  }

  const locked = await db.accountingPeriod.update({
    where: { id: periodId },
    data: { status: 'LOCKED' },
  });

  await db.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId === 'system' ? null : ctx.userId,
      action: 'LOCK_PERIOD',
      entityType: 'AccountingPeriod',
      entityId: periodId,
      before: { status: period.status },
      after: { status: 'LOCKED' },
    },
  });

  return locked;
}
