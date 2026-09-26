import type { PrismaClient } from '@prisma/client';
import { postingContextFor, requireLocation, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { sum, ZERO, type Cents } from '../money';
import { postJournalEntry, reverseJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { creditMemoLines } from '../accounting/rules/invoice';

/**
 * Undoing a sale, the two honest ways.
 *
 * A **void** says the invoice should never have existed: the wrong customer, the wrong
 * job, a duplicate. The original posting is reversed, the work goes back to unbilled, and
 * the invoice keeps its number so the gap in the sequence is explained rather than
 * mysterious. Nothing was owed and nothing was earned.
 *
 * A **credit memo** says the invoice was right and something is being given back
 * afterwards: a part returned, a price argued down, a goodwill gesture after a callback.
 * The sale stands; a second document reduces it, with its own date and its own reason.
 *
 * Which one applies is not a preference. Once a customer has paid, voiding would erase
 * the revenue their money is sitting against, so anything paid is a credit — and the code
 * refuses rather than letting somebody choose the tidier-looking option.
 */

/** Everything credited against an invoice so far, from the memos themselves. */
async function creditedTotal(
  db: PrismaClient,
  organizationId: string,
  invoiceId: string,
): Promise<Cents> {
  const memos = await db.creditMemo.findMany({
    where: { organizationId, invoiceId },
    select: { amountCents: true },
  });
  return sum(memos.map((memo) => memo.amountCents));
}

export interface VoidInvoiceInput {
  reason: string;
  /** When the reversal posts. Today, unless somebody is correcting the record late. */
  voidedAt?: Date;
}

export async function voidInvoice(
  db: PrismaClient,
  ctx: AuthContext,
  invoiceId: string,
  input: VoidInvoiceInput,
) {
  requirePermission(ctx, PERMISSIONS.INVOICE_VOID);

  if (!input.reason?.trim()) {
    throw new ValidationError('Voiding an invoice needs a reason');
  }

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, organizationId: ctx.organizationId },
    select: {
      id: true,
      invoiceNo: true,
      status: true,
      locationId: true,
      jobId: true,
      paidCents: true,
      depositAppliedCents: true,
      journalEntryId: true,
      memo: true,
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);
  requireLocation(ctx, invoice.locationId);

  if (invoice.status === 'VOID') {
    throw new ValidationError(`Invoice ${invoice.invoiceNo} is already void`);
  }
  if (invoice.status === 'DRAFT') {
    throw new ValidationError(
      `Invoice ${invoice.invoiceNo} was never issued; delete the draft rather than voiding it`,
    );
  }
  if (invoice.paidCents > ZERO) {
    throw new ValidationError(
      `Invoice ${invoice.invoiceNo} has been paid. Credit it instead — voiding would remove revenue the customer's money is sitting against.`,
    );
  }
  const credited = await creditedTotal(db, ctx.organizationId, invoice.id);
  if (credited > ZERO) {
    throw new ValidationError(
      `Invoice ${invoice.invoiceNo} has already been credited; there is nothing left to void`,
    );
  }
  if (!invoice.journalEntryId) {
    throw new ValidationError(`Invoice ${invoice.invoiceNo} has no posting to reverse`);
  }

  const voidedAt = input.voidedAt ?? new Date();

  // The reversal posts first: if the period is closed it will refuse, and the invoice
  // must not be marked void by a correction the ledger would not accept.
  const reversal = await reverseJournalEntry(db, postingContextFor(ctx), invoice.journalEntryId, {
    entryDate: voidedAt,
    memo: `Void ${invoice.invoiceNo} — ${input.reason.trim()}`,
  });

  return db.$transaction(async (tx) => {
    /*
     * The work goes back on the shelf.
     *
     * Its lines were claimed by this invoice when it was drafted, and if they stayed
     * claimed the job would be uninvoiceable for ever — finished, unbilled, and invisible
     * to the screen that finds finished unbilled work.
     */
    await tx.jobLine.updateMany({
      where: { invoiceId: invoice.id },
      data: { isBilled: false, invoiceId: null },
    });

    if (invoice.jobId) {
      const job = await tx.job.findUniqueOrThrow({
        where: { id: invoice.jobId },
        select: { status: true },
      });
      if (job.status === 'INVOICED' || job.status === 'PAID') {
        await tx.job.update({ where: { id: invoice.jobId }, data: { status: 'COMPLETED' } });
      }
    }

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'VOID',
        voidedAt,
        balanceCents: ZERO,
        depositAppliedCents: ZERO,
        memo: [invoice.memo, `Voided: ${input.reason.trim()}`].filter(Boolean).join(' · '),
      },
    });

    return { invoice: updated, reversalEntryId: reversal.id, reversalEntryNo: reversal.entryNo };
  });
}

export interface CreditMemoInput {
  invoiceId: string;
  /** Omit to credit whatever is left on the invoice. */
  amountCents?: Cents;
  reason: string;
  issuedAt?: Date;
}

/**
 * Credit an invoice, in whole or in part.
 *
 * The credit is an amount rather than a set of lines, because that is how the argument
 * actually goes — "take fifty off" — and it is apportioned across the invoice's revenue
 * and tax exactly as the invoice was composed. Crediting half a bill credits half its
 * labour, half its materials and half its tax, which is the only split that leaves the
 * revenue accounts and the tax liability telling the same story afterwards.
 */
export async function issueCreditMemo(
  db: PrismaClient,
  ctx: AuthContext,
  input: CreditMemoInput,
) {
  requirePermission(ctx, PERMISSIONS.INVOICE_WRITE_OFF);

  if (!input.reason?.trim()) throw new ValidationError('A credit memo needs a reason');

  const invoice = await db.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: ctx.organizationId },
    include: {
      lines: true,
      taxLines: true,
      job: { select: { serviceTypeId: true } },
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', input.invoiceId);
  requireLocation(ctx, invoice.locationId);

  if (invoice.status === 'DRAFT') {
    throw new ValidationError(`Invoice ${invoice.invoiceNo} has not been issued yet`);
  }
  if (invoice.status === 'VOID') {
    throw new ValidationError(`Invoice ${invoice.invoiceNo} is void; there is nothing to credit`);
  }

  const alreadyCredited = await creditedTotal(db, ctx.organizationId, invoice.id);
  const creditable = invoice.totalCents - alreadyCredited;
  if (creditable <= ZERO) {
    throw new ValidationError(`Invoice ${invoice.invoiceNo} has already been credited in full`);
  }

  // Left unsaid, the credit is for what the customer still owes; on a paid invoice that is
  // nothing, so it falls back to what is left creditable — the case where money comes back.
  const amountCents =
    input.amountCents ?? (invoice.balanceCents > ZERO ? invoice.balanceCents : creditable);

  if (amountCents <= ZERO) throw new ValidationError('A credit memo needs an amount');
  if (amountCents > creditable) {
    throw new ValidationError(
      `Only ${creditable} is left to credit on ${invoice.invoiceNo}`,
    );
  }

  /*
   * Apportioning, to the cent.
   *
   * Tax first, because the tax liability is a filed number and must come back out in the
   * proportion it went in; revenue takes the remainder, so the entry balances exactly
   * rather than leaving a rounding penny for the trial balance to carry.
   */
  const taxTotal = invoice.taxCents;
  const grossTotal = invoice.totalCents;
  const taxShare = grossTotal === ZERO ? ZERO : (taxTotal * amountCents) / grossTotal;
  const revenueShare = amountCents - taxShare;

  const netTotal = invoice.totalCents - invoice.taxCents;
  const revenueLines = invoice.lines
    .map((line) => {
      const lineNet = line.totalCents - line.taxCents;
      const share = netTotal === ZERO ? ZERO : (revenueShare * lineNet) / netTotal;
      return {
        category: line.category,
        amountCents: share,
        serviceTypeId: invoice.job?.serviceTypeId ?? null,
        description: line.description,
      };
    })
    .filter((line) => line.amountCents > ZERO);

  // Whatever the per-line rounding dropped goes on the largest line, so the credit posts
  // for exactly what was promised.
  const allocated = sum(revenueLines.map((line) => line.amountCents));
  if (revenueLines.length > 0 && allocated !== revenueShare) {
    const largest = revenueLines.reduce((a, b) => (b.amountCents > a.amountCents ? b : a));
    largest.amountCents += revenueShare - allocated;
  }

  const taxLines = invoice.taxLines
    .map((line) => ({
      taxCents: taxTotal === ZERO ? ZERO : (taxShare * line.taxCents) / taxTotal,
      jurisdictionName: undefined,
    }))
    .filter((line) => line.taxCents > ZERO);
  const allocatedTax = sum(taxLines.map((line) => line.taxCents));
  if (taxLines.length > 0 && allocatedTax !== taxShare) {
    taxLines[0].taxCents += taxShare - allocatedTax;
  }

  const issuedAt = input.issuedAt ?? new Date();

  return db.$transaction(async (tx) => {
    const creditMemoNo = await nextDocumentNumber(tx, ctx.organizationId, 'CREDIT_MEMO');

    const memo = await tx.creditMemo.create({
      data: {
        organizationId: ctx.organizationId,
        creditMemoNo,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        reason: input.reason.trim(),
        amountCents,
        appliedCents: amountCents,
        issuedAt,
      },
    });

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: issuedAt,
        source: 'CREDIT_MEMO',
        sourceType: 'CreditMemo',
        sourceId: memo.id,
        memo: `Credit ${creditMemoNo} — ${input.reason.trim()}`,
        lines: creditMemoLines({
          creditMemoNo,
          invoiceNo: invoice.invoiceNo,
          locationId: invoice.locationId,
          customerId: invoice.customerId,
          jobId: invoice.jobId,
          revenueLines,
          taxes: taxLines,
        }),
      },
      tx,
    );

    await tx.creditMemo.update({ where: { id: memo.id }, data: { journalEntryId: entry.id } });

    /*
     * "Paid" here means the balance is zero — by cash, by a deposit, or by a credit. It is
     * the convention every accountant recognises from every other system, and the memo
     * beside it says which of the three it was.
     */
    const balance = invoice.totalCents - invoice.paidCents - (alreadyCredited + amountCents);
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        balanceCents: balance > ZERO ? balance : ZERO,
        status: balance <= ZERO ? 'PAID' : invoice.paidCents > ZERO ? 'PARTIALLY_PAID' : 'OPEN',
      },
    });

    if (balance <= ZERO && invoice.jobId) {
      const job = await tx.job.findUniqueOrThrow({
        where: { id: invoice.jobId },
        select: { status: true },
      });
      if (job.status === 'INVOICED') {
        await tx.job.update({ where: { id: invoice.jobId }, data: { status: 'PAID' } });
      }
    }

    return {
      creditMemoNo,
      creditMemoId: memo.id,
      amountCents,
      revenueCents: revenueShare,
      taxCents: taxShare,
      journalEntryId: entry.id,
      invoice: updated,
    };
  });
}
