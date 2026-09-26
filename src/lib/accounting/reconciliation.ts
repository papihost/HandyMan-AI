import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { sum, ZERO, type Cents } from '../money';

/**
 * Bank reconciliation.
 *
 * Everything else in this system agrees with itself by construction: the reports are
 * queries over the postings, so they cannot disagree with the ledger. This is the one
 * place the books are checked against something outside them, and it is the only real
 * evidence that the cash is real — a company can post a year of beautifully balanced
 * entries and still be missing the money.
 *
 * The method is the one every bookkeeper knows. Start from the balance the last statement
 * ended on, tick off what the bank has also seen, and the difference between that and the
 * statement's closing balance must be nothing. What is left unticked is not an error: it
 * is a cheque somebody has not cashed and a deposit that has not landed, which is why
 * they are listed rather than hidden.
 */

/*
 * Only accounts a statement actually arrives for.
 *
 * Undeposited funds is not one of them, tempting as it looks: nobody posts a statement
 * for a cash drawer, and it is already cleared by the paying-in slip that banks it. Listing
 * it here would bury the handful of postings that genuinely have not reached a bank under
 * a thousand that were never going to.
 */
const BANK_SUBTYPES = ['BANK'] as const;

export interface BankAccountSummary {
  accountId: string;
  code: string;
  name: string;
  /** What the books say is in it, today. */
  ledgerCents: Cents;
  lastStatementDate: Date | null;
  lastReconciledCents: Cents | null;
  /** Postings no statement has accounted for yet. */
  unclearedCount: number;
  unclearedCents: Cents;
  openReconciliationId: string | null;
}

/** The accounts a statement arrives for, and how far behind each one is. */
export async function bankAccounts(
  db: PrismaClient,
  ctx: AuthContext,
): Promise<BankAccountSummary[]> {
  requirePermission(ctx, PERMISSIONS.BANK_RECONCILE);

  const accounts = await db.account.findMany({
    where: {
      organizationId: ctx.organizationId,
      isActive: true,
      subtype: { in: [...BANK_SUBTYPES] },
    },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true },
  });

  const summaries: BankAccountSummary[] = [];

  for (const account of accounts) {
    const [lines, last, open] = await Promise.all([
      db.journalLine.findMany({
        where: {
          accountId: account.id,
          journalEntry: { postedAt: { not: null } },
        },
        select: { id: true, debitCents: true, creditCents: true, cleared: { select: { id: true } } },
      }),
      db.bankReconciliation.findFirst({
        where: { organizationId: ctx.organizationId, accountId: account.id, status: 'COMPLETE' },
        orderBy: { statementDate: 'desc' },
        select: { statementDate: true, closingBalanceCents: true },
      }),
      db.bankReconciliation.findFirst({
        where: {
          organizationId: ctx.organizationId,
          accountId: account.id,
          status: 'IN_PROGRESS',
        },
        orderBy: { statementDate: 'desc' },
        select: { id: true },
      }),
    ]);

    const uncleared = lines.filter((line) => line.cleared.length === 0);

    summaries.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      ledgerCents: sum(lines.map((line) => line.debitCents - line.creditCents)),
      lastStatementDate: last?.statementDate ?? null,
      lastReconciledCents: last?.closingBalanceCents ?? null,
      unclearedCount: uncleared.length,
      unclearedCents: sum(uncleared.map((line) => line.debitCents - line.creditCents)),
      openReconciliationId: open?.id ?? null,
    });
  }

  return summaries;
}

export interface OpenReconciliationInput {
  accountId: string;
  statementDate: Date;
  /** What the statement says was in the account when it was printed. */
  closingBalanceCents: Cents;
}

export async function openReconciliation(
  db: PrismaClient,
  ctx: AuthContext,
  input: OpenReconciliationInput,
) {
  requirePermission(ctx, PERMISSIONS.BANK_RECONCILE);

  const account = await db.account.findFirst({
    where: { id: input.accountId, organizationId: ctx.organizationId },
    select: { id: true, code: true, subtype: true },
  });
  if (!account) throw new NotFoundError('Account', input.accountId);

  const alreadyOpen = await db.bankReconciliation.findFirst({
    where: {
      organizationId: ctx.organizationId,
      accountId: account.id,
      status: 'IN_PROGRESS',
    },
    select: { id: true, statementDate: true },
  });
  if (alreadyOpen) {
    throw new ValidationError(
      `A reconciliation for this account is already open to ${alreadyOpen.statementDate.toISOString().slice(0, 10)}`,
    );
  }

  const previous = await db.bankReconciliation.findFirst({
    where: { organizationId: ctx.organizationId, accountId: account.id, status: 'COMPLETE' },
    orderBy: { statementDate: 'desc' },
    select: { statementDate: true, closingBalanceCents: true },
  });

  if (previous && input.statementDate <= previous.statementDate) {
    throw new ValidationError(
      `This account is reconciled to ${previous.statementDate.toISOString().slice(0, 10)}; a statement cannot go backwards`,
    );
  }

  /*
   * The opening balance is not a number anyone types.
   *
   * It is what the last statement closed on, because that is the only figure both sides
   * already agree about. Letting somebody enter it would let them make the difference
   * come out at zero by adjusting the wrong end.
   */
  return db.bankReconciliation.create({
    data: {
      organizationId: ctx.organizationId,
      accountId: account.id,
      statementDate: input.statementDate,
      openingBalanceCents: previous?.closingBalanceCents ?? ZERO,
      closingBalanceCents: input.closingBalanceCents,
      status: 'IN_PROGRESS',
    },
  });
}

export interface WorksheetLine {
  journalLineId: string;
  entryId: string;
  entryNo: string;
  entryDate: Date;
  memo: string;
  source: string;
  /** Positive is money in, negative is money out, as a statement reads. */
  amountCents: Cents;
  cleared: boolean;
}

export interface Worksheet {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  statementDate: Date;
  status: string;
  openingBalanceCents: Cents;
  closingBalanceCents: Cents;
  /** Opening plus everything ticked. */
  clearedBalanceCents: Cents;
  /** What the statement says, less what has been ticked. Zero is the finish line. */
  differenceCents: Cents;
  lines: WorksheetLine[];
  clearedCount: number;
}

export async function reconciliationWorksheet(
  db: PrismaClient,
  ctx: AuthContext,
  reconciliationId: string,
): Promise<Worksheet> {
  requirePermission(ctx, PERMISSIONS.BANK_RECONCILE);

  const rec = await db.bankReconciliation.findFirst({
    where: { id: reconciliationId, organizationId: ctx.organizationId },
    include: { account: { select: { id: true, code: true, name: true } } },
  });
  if (!rec) throw new NotFoundError('Bank reconciliation', reconciliationId);

  /*
   * What can appear on this statement.
   *
   * Everything posted to the account on or before the statement date that no statement has
   * accounted for, plus whatever this one has already ticked. Postings dated after the
   * statement are not shown: a statement cannot have seen them, and offering them invites
   * somebody to tick one to make the difference disappear.
   */
  const rows = await db.journalLine.findMany({
    where: {
      accountId: rec.accountId,
      journalEntry: { postedAt: { not: null }, entryDate: { lte: rec.statementDate } },
      OR: [{ cleared: { none: {} } }, { cleared: { some: { bankReconciliationId: rec.id } } }],
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { entryNo: 'asc' } }],
    take: 500,
    select: {
      id: true,
      debitCents: true,
      creditCents: true,
      memo: true,
      cleared: { select: { bankReconciliationId: true } },
      journalEntry: { select: { id: true, entryNo: true, entryDate: true, memo: true, source: true } },
    },
  });

  const lines: WorksheetLine[] = rows.map((row) => ({
    journalLineId: row.id,
    entryId: row.journalEntry.id,
    entryNo: row.journalEntry.entryNo,
    entryDate: row.journalEntry.entryDate,
    memo: row.memo ?? row.journalEntry.memo ?? '',
    source: row.journalEntry.source,
    amountCents: row.debitCents - row.creditCents,
    cleared: row.cleared.some((mark) => mark.bankReconciliationId === rec.id),
  }));

  const clearedMovement = sum(
    lines.filter((line) => line.cleared).map((line) => line.amountCents),
  );
  const clearedBalance = rec.openingBalanceCents + clearedMovement;

  return {
    id: rec.id,
    accountId: rec.accountId,
    accountCode: rec.account.code,
    accountName: rec.account.name,
    statementDate: rec.statementDate,
    status: rec.status,
    openingBalanceCents: rec.openingBalanceCents,
    closingBalanceCents: rec.closingBalanceCents,
    clearedBalanceCents: clearedBalance,
    differenceCents: rec.closingBalanceCents - clearedBalance,
    lines,
    clearedCount: lines.filter((line) => line.cleared).length,
  };
}

/** Tick or untick. Nothing posts; a statement is evidence, not a transaction. */
export async function setCleared(
  db: PrismaClient,
  ctx: AuthContext,
  reconciliationId: string,
  input: { journalLineIds: string[]; cleared: boolean },
) {
  requirePermission(ctx, PERMISSIONS.BANK_RECONCILE);

  const rec = await db.bankReconciliation.findFirst({
    where: { id: reconciliationId, organizationId: ctx.organizationId },
    select: { id: true, status: true, accountId: true, statementDate: true },
  });
  if (!rec) throw new NotFoundError('Bank reconciliation', reconciliationId);
  if (rec.status !== 'IN_PROGRESS') {
    throw new ValidationError('That reconciliation is finished; start a new one');
  }
  if (input.journalLineIds.length === 0) return reconciliationWorksheet(db, ctx, reconciliationId);

  const eligible = await db.journalLine.findMany({
    where: {
      id: { in: input.journalLineIds },
      accountId: rec.accountId,
      journalEntry: { postedAt: { not: null }, entryDate: { lte: rec.statementDate } },
    },
    select: { id: true },
  });
  if (eligible.length !== input.journalLineIds.length) {
    throw new ValidationError('Some of those postings do not belong on this statement');
  }

  if (input.cleared) {
    await db.bankReconciliationLine.createMany({
      data: eligible.map((line) => ({
        bankReconciliationId: rec.id,
        journalLineId: line.id,
      })),
      // A line already ticked on this statement is not an error worth stopping for; one
      // ticked on another statement is, and the unique index says so.
      skipDuplicates: true,
    });
  } else {
    await db.bankReconciliationLine.deleteMany({
      where: { bankReconciliationId: rec.id, journalLineId: { in: eligible.map((l) => l.id) } },
    });
  }

  return reconciliationWorksheet(db, ctx, reconciliationId);
}

/**
 * Finish it.
 *
 * Only when the difference is nothing. A reconciliation that is allowed to complete while
 * it is out by eleven dollars is worse than none at all: it says the cash was checked when
 * it was not, and the eleven dollars is never looked for again.
 */
export async function completeReconciliation(
  db: PrismaClient,
  ctx: AuthContext,
  reconciliationId: string,
) {
  requirePermission(ctx, PERMISSIONS.BANK_RECONCILE);

  const sheet = await reconciliationWorksheet(db, ctx, reconciliationId);
  if (sheet.status !== 'IN_PROGRESS') {
    throw new ValidationError('That reconciliation is already finished');
  }
  if (sheet.differenceCents !== ZERO) {
    throw new ValidationError(
      `Still out by ${sheet.differenceCents}. A reconciliation that does not agree is not a reconciliation.`,
    );
  }

  const updated = await db.bankReconciliation.update({
    where: { id: reconciliationId },
    data: {
      status: 'COMPLETE',
      clearedBalanceCents: sheet.clearedBalanceCents,
      differenceCents: ZERO,
      completedAt: new Date(),
      completedByUserId: ctx.userId === 'system' ? null : ctx.userId,
    },
  });

  const outstanding = sheet.lines.filter((line) => !line.cleared);

  return {
    reconciliation: updated,
    clearedCount: sheet.clearedCount,
    /** Still in transit: these carry forward to the next statement. */
    outstandingCount: outstanding.length,
    outstandingCents: sum(outstanding.map((line) => line.amountCents)),
  };
}
