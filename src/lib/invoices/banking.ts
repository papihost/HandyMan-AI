import type { PrismaClient } from '@prisma/client';
import { postingContextFor, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { sum, ZERO, type Cents } from '../money';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { bankDepositLines } from '../accounting/rules/payment';

/**
 * Banking the takings.
 *
 * Cash and cheques do not go into the bank when they are received; they go into somebody's
 * pocket, then a cash box, then — eventually — a paying-in slip. That gap is what the
 * Undeposited Funds account exists to hold, and it is the only reason a bank
 * reconciliation is possible: the bank shows one line for the deposit, and the deposit
 * knows which payments it was made up of.
 *
 * Card takings are not here. They settle from the processor on its own schedule, net of
 * its fee, and nobody carries them to a bank — so they clear through their own account
 * rather than through a slip somebody fills in.
 */

const TILL_METHODS = ['CASH', 'CHECK'] as const;

/**
 * A branch manager banks their own branch's takings and nobody else's.
 *
 * The drawer is a local thing: the cash in Mesa is carried to a Mesa bank by somebody in
 * Mesa, and a slip that swept up Scottsdale's cheques as well would be a slip that cannot
 * be taken to a counter. Callers with company-wide scope see the lot.
 */
const branchFilter = (ctx: AuthContext) =>
  ctx.scope !== 'ALL' && ctx.locationIds.length > 0
    ? { locationId: { in: ctx.locationIds } }
    : {};

export interface UndepositedPayment {
  id: string;
  paymentNo: string;
  method: string;
  reference: string | null;
  receivedAt: Date;
  amountCents: Cents;
  customerName: string;
  /** The technician who took it, when it was taken at a door rather than in the office. */
  collectedByName: string | null;
  jobNo: string | null;
}

export async function undepositedPayments(
  db: PrismaClient,
  ctx: AuthContext,
): Promise<{
  payments: UndepositedPayment[];
  totalCents: Cents;
  oldest: Date | null;
  /** What the ledger says is still undeposited. */
  ledgerCents: Cents;
  /** The two agree, which they must: one is the documents, the other is the postings. */
  matches: boolean;
}> {
  requirePermission(ctx, PERMISSIONS.PAYMENT_READ);

  const rows = await db.payment.findMany({
    where: {
      organizationId: ctx.organizationId,
      depositBatchId: null,
      method: { in: [...TILL_METHODS] },
      ...branchFilter(ctx),
    },
    orderBy: { receivedAt: 'asc' },
    take: 200,
    select: {
      id: true,
      paymentNo: true,
      method: true,
      reference: true,
      receivedAt: true,
      amountCents: true,
      customer: { select: { companyName: true, firstName: true, lastName: true } },
      collectedBy: { select: { user: { select: { firstName: true, lastName: true } } } },
      job: { select: { jobNo: true } },
    },
  });

  const payments = rows.map((row) => ({
    id: row.id,
    paymentNo: row.paymentNo,
    method: row.method,
    reference: row.reference,
    receivedAt: row.receivedAt,
    amountCents: row.amountCents,
    customerName:
      row.customer.companyName ??
      [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' '),
    collectedByName: row.collectedBy
      ? `${row.collectedBy.user.firstName} ${row.collectedBy.user.lastName}`
      : null,
    jobNo: row.job?.jobNo ?? null,
  }));

  /*
   * The same assertion the inventory screen makes, for the same reason.
   *
   * The list is built from the payments that say they have not been banked; the balance is
   * built from the postings. They are two different routes to one number and they must
   * agree — and when they do not, it is because something moved the balance without going
   * through a paying-in slip, which is precisely the thing worth finding out about.
   */
  const { trialBalance } = await import('../accounting/reports');
  const tb = await trialBalance(db, ctx, {});
  const ledgerCents =
    tb.rows.find((row) => row.code === ACCOUNTS.UNDEPOSITED_FUNDS)?.balanceCents ?? ZERO;

  const totalCents = sum(payments.map((payment) => payment.amountCents));

  return {
    payments,
    totalCents,
    oldest: payments[0]?.receivedAt ?? null,
    ledgerCents,
    matches: totalCents === ledgerCents,
  };
}

export interface BankTakingsOptions {
  /** Which payments go on this slip. Omit to bank everything in hand. */
  paymentIds?: string[];
  /** When it reached the bank. */
  depositedAt?: Date;
  /**
   * Only what was taken by this date. Somebody has to carry it, so what came in this
   * morning is rarely on this afternoon's slip; a run that swept the drawer to the last
   * minute would be a run nobody has ever made.
   */
  receivedThrough?: Date;
  bankAccountCode?: string;
}

/**
 * Write the paying-in slip.
 *
 *   Dr Operating Bank Account   Cr Undeposited Funds
 *
 * The batch is the document the bank line will be matched against, and each payment it
 * carried points back at it — so "what made up the 2,480.15 that hit the account on the
 * 14th" is a question with an answer, which is the whole point of holding the money in a
 * separate account on the way there.
 */
export async function bankTakings(
  db: PrismaClient,
  ctx: AuthContext,
  options: BankTakingsOptions = {},
) {
  requirePermission(ctx, PERMISSIONS.PAYMENT_RECORD);

  const selected = options.paymentIds && options.paymentIds.length > 0;

  const payments = await db.payment.findMany({
    where: {
      organizationId: ctx.organizationId,
      depositBatchId: null,
      method: { in: [...TILL_METHODS] },
      ...branchFilter(ctx),
      ...(options.receivedThrough ? { receivedAt: { lte: options.receivedThrough } } : {}),
      ...(selected ? { id: { in: options.paymentIds } } : {}),
    },
    select: { id: true, amountCents: true, locationId: true },
  });

  if (selected && payments.length !== options.paymentIds!.length) {
    throw new ValidationError('One of those payments has already been banked — reload and try again');
  }
  if (payments.length === 0) {
    return { depositNo: null, paymentCount: 0, totalCents: ZERO, journalEntryId: null };
  }

  const total = sum(payments.map((payment) => payment.amountCents));
  if (total <= ZERO) {
    return { depositNo: null, paymentCount: 0, totalCents: ZERO, journalEntryId: null };
  }

  const depositedAt = options.depositedAt ?? new Date();
  const bankCode = options.bankAccountCode ?? ACCOUNTS.BANK_OPERATING;

  return db.$transaction(async (tx) => {
    const bank = await tx.account.findFirst({
      where: { organizationId: ctx.organizationId, code: bankCode },
      select: { id: true },
    });
    if (!bank) throw new NotFoundError('Account', bankCode);

    const depositNo = await nextDocumentNumber(tx, ctx.organizationId, 'DEPOSIT');

    // The slip exists before the posting does, so the entry can point back at it: an
    // entry whose source is a document nobody can open is half a trail.
    const batch = await tx.depositBatch.create({
      data: {
        organizationId: ctx.organizationId,
        depositNo,
        bankAccountId: bank.id,
        depositedAt,
        totalCents: total,
      },
    });

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: depositedAt,
        source: 'DEPOSIT',
        sourceType: 'DepositBatch',
        sourceId: batch.id,
        memo: `Bank deposit ${depositNo}`,
        lines: bankDepositLines({
          depositNo,
          amountCents: total,
          bankAccountCode: bankCode,
        }),
      },
      tx,
    );

    await tx.depositBatch.update({
      where: { id: batch.id },
      data: { journalEntryId: entry.id },
    });

    await tx.payment.updateMany({
      where: { id: { in: payments.map((payment) => payment.id) } },
      data: { depositBatchId: batch.id },
    });

    return {
      depositNo,
      depositBatchId: batch.id,
      paymentCount: payments.length,
      totalCents: total,
      journalEntryId: entry.id,
    };
  });
}
