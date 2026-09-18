import type { PaymentMethod, PrismaClient } from '@prisma/client';
import {
  postingContextFor,
  requireLocation,
  requirePermission,
  systemContext,
  type AuthContext,
} from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { scopedDb } from '../auth/scoped-db';
import { NotFoundError, ValidationError } from '../errors';
import { sum, ZERO, type Cents } from '../money';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { invoiceIssuedLines } from '../accounting/rules/invoice';
import { paymentReceivedLines } from '../accounting/rules/payment';
import { computeDocumentTotals, revenueByCategory } from '../documents/line-totals';
import { resolveTaxRuleForProperty } from '../pricing/tax';
import { refreshJobRollup } from '../jobs/costing';

/**
 * Invoicing and receivables.
 *
 * This is where the field and the books meet. A technician closes a job on a tablet and
 * the invoice, its sales tax, its journal entry, the customer's balance and the job's
 * margin all follow from that one act — nobody in the office re-keys anything, and there
 * is no second system to reconcile against.
 */

export interface CreateInvoiceInput {
  jobId: string;
  issueDate?: Date;
  /** Falls back to the customer's payment terms. */
  dueDate?: Date;
  memo?: string;
  poNumber?: string;
  percentComplete?: number;
}

/**
 * Draft an invoice from a job's unbilled lines.
 *
 * Lines are claimed by the draft as it is created, so a second invoice cannot pick up the
 * same work. Progress billing is just an invoice that claims some of the lines and leaves
 * the rest for later.
 */
export async function createInvoiceFromJob(
  db: PrismaClient,
  ctx: AuthContext,
  input: CreateInvoiceInput,
) {
  requirePermission(ctx, PERMISSIONS.INVOICE_WRITE);

  return db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: input.jobId, organizationId: ctx.organizationId },
      select: {
        id: true,
        jobNo: true,
        status: true,
        locationId: true,
        customerId: true,
        propertyId: true,
        isBillable: true,
        isWarranty: true,
        customer: { select: { paymentTermsDays: true, isTaxExempt: true } },
        location: { select: { code: true } },
      },
    });
    if (!job) throw new NotFoundError('Job', input.jobId);
    requireLocation(ctx, job.locationId);

    if (!job.isBillable) {
      throw new ValidationError(
        `Job ${job.jobNo} is ${job.isWarranty ? 'warranty rework' : 'marked non-billable'} and cannot be invoiced`,
      );
    }

    const jobLines = await tx.jobLine.findMany({
      where: { jobId: job.id, isBilled: false, invoiceId: null },
      orderBy: { sortOrder: 'asc' },
    });
    if (jobLines.length === 0) {
      throw new ValidationError(`Job ${job.jobNo} has no unbilled lines to invoice`);
    }

    const issueDate = input.issueDate ?? new Date();
    const taxRule = await resolveTaxRuleForProperty(tx, ctx.organizationId, job.propertyId, issueDate);

    const totals = computeDocumentTotals(
      jobLines.map((l) => ({
        category: l.category,
        description: l.description,
        quantity: l.quantity.toString(),
        unitPriceCents: l.unitPriceCents,
        unitCostCents: l.unitCostCents,
        discountCents: l.discountCents,
        priceBookItemId: l.priceBookItemId,
        sortOrder: l.sortOrder,
      })),
      taxRule,
      { customerIsTaxExempt: job.customer.isTaxExempt },
    );

    const invoiceNo = await nextDocumentNumber(tx, ctx.organizationId, 'INVOICE', job.location.code);
    const dueDate =
      input.dueDate ??
      new Date(issueDate.getTime() + job.customer.paymentTermsDays * 24 * 60 * 60 * 1000);

    const invoice = await tx.invoice.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: job.locationId,
        invoiceNo,
        customerId: job.customerId,
        jobId: job.id,
        status: 'DRAFT',
        issueDate,
        dueDate,
        memo: input.memo ?? null,
        poNumber: input.poNumber ?? null,
        percentComplete: input.percentComplete ?? null,
        isProgressBilling: input.percentComplete !== undefined,
        subtotalCents: totals.subtotalCents,
        discountCents: totals.discountCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        balanceCents: totals.totalCents,
        lines: {
          create: totals.lines.map((line, index) => ({
            priceBookItemId: line.priceBookItemId ?? null,
            sortOrder: index,
            category: line.category,
            description: line.description,
            quantity: line.quantity.toString(),
            unitPriceCents: line.unitPriceCents,
            unitCostCents: line.unitCostCents ?? ZERO,
            discountCents: line.discountCents ?? ZERO,
            isTaxable: line.taxCents > ZERO,
            taxCents: line.taxCents,
            totalCents: line.totalCents,
          })),
        },
        taxLines: {
          create: totals.taxAllocations.map((a) => ({
            taxJurisdictionId: a.jurisdictionId,
            taxableCents: a.taxableCents,
            rate: a.rate,
            taxCents: a.taxCents,
          })),
        },
      },
      include: { lines: true, taxLines: true },
    });

    // Claim the lines so a second draft cannot bill the same work.
    await tx.jobLine.updateMany({
      where: { id: { in: jobLines.map((l) => l.id) } },
      data: { invoiceId: invoice.id },
    });

    return invoice;
  });
}

export interface IssueInvoiceOptions {
  /** Deposit held for this customer to consume. Validated against what is actually unapplied. */
  applyDepositCents?: Cents;
}

/**
 * Issue a draft invoice: post it to the general ledger and open the receivable.
 *
 * The posting and the status change happen in one transaction. There is no window in
 * which an invoice is issued but unposted, or posted but still a draft.
 */
export async function issueInvoice(
  db: PrismaClient,
  ctx: AuthContext,
  invoiceId: string,
  options: IssueInvoiceOptions = {},
) {
  requirePermission(ctx, PERMISSIONS.INVOICE_WRITE);

  const result = await db.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organizationId: ctx.organizationId },
      include: { lines: { orderBy: { sortOrder: 'asc' } }, taxLines: true },
    });
    if (!invoice) throw new NotFoundError('Invoice', invoiceId);
    requireLocation(ctx, invoice.locationId);

    if (invoice.status !== 'DRAFT') {
      throw new ValidationError(`Invoice ${invoice.invoiceNo} has already been issued`);
    }

    const depositToApply = options.applyDepositCents ?? ZERO;
    if (depositToApply > ZERO) {
      const available = await unappliedDepositTotal(tx, ctx.organizationId, invoice.customerId);
      if (depositToApply > available) {
        throw new ValidationError(
          `Only ${available} of customer deposit is unapplied; cannot apply ${depositToApply}`,
        );
      }
      if (depositToApply > invoice.totalCents) {
        throw new ValidationError('Applied deposit exceeds the invoice total');
      }
    }

    const revenue = revenueByCategory(
      invoice.lines.map((l) => ({
        category: l.category,
        description: l.description,
        quantity: l.quantity.toString(),
        unitPriceCents: l.unitPriceCents,
        extendedCents: l.unitPriceCents,
        netCents: l.totalCents - l.taxCents,
        taxCents: l.taxCents,
        totalCents: l.totalCents,
        costCents: ZERO,
      })),
    );

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: invoice.issueDate,
        source: 'INVOICE',
        sourceType: 'Invoice',
        sourceId: invoice.id,
        memo: `Invoice ${invoice.invoiceNo}`,
        lines: invoiceIssuedLines({
          invoiceNo: invoice.invoiceNo,
          locationId: invoice.locationId,
          customerId: invoice.customerId,
          jobId: invoice.jobId,
          revenueLines: revenue.map((r) => ({
            category: r.category,
            amountCents: r.amountCents,
            serviceTypeId: r.serviceTypeId,
          })),
          discountCents: invoice.discountCents,
          taxes: invoice.taxLines.map((t) => ({ taxCents: t.taxCents })),
          depositAppliedCents: depositToApply,
        }),
      },
      tx,
    );

    if (depositToApply > ZERO) {
      await consumeDeposits(tx, ctx.organizationId, invoice.customerId, depositToApply);
    }

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: depositToApply >= invoice.totalCents ? 'PAID' : 'OPEN',
        journalEntryId: entry.id,
        depositAppliedCents: depositToApply,
        paidCents: depositToApply,
        balanceCents: invoice.totalCents - depositToApply,
        sentAt: new Date(),
      },
    });

    await tx.jobLine.updateMany({
      where: { invoiceId: invoice.id },
      data: { isBilled: true },
    });

    if (invoice.jobId) {
      const job = await tx.job.findUniqueOrThrow({
        where: { id: invoice.jobId },
        select: { status: true },
      });
      // A progress invoice on a job still in the field must not mark it invoiced.
      if (job.status === 'COMPLETED') {
        await tx.job.update({
          where: { id: invoice.jobId },
          data: { status: updated.status === 'PAID' ? 'PAID' : 'INVOICED' },
        });
      }
    }

    return { invoice: updated, journalEntryId: entry.id, jobId: invoice.jobId };
  });

  // Roll-up refresh reads the ledger, so it runs after the posting has committed.
  if (result.jobId) await refreshJobRollup(db, systemContext(ctx.organizationId, ctx.userId), result.jobId);
  return result;
}

export interface RecordPaymentInput {
  customerId: string;
  locationId: string;
  method: PaymentMethod;
  amountCents: Cents;
  receivedAt?: Date;
  reference?: string;
  feeCents?: Cents;
  cardLast4?: string;
  cardBrand?: string;
  processorToken?: string;
  /** Money taken before the work is earned. Credits the deposit liability, not revenue. */
  isDeposit?: boolean;
  /** Invoices to settle, oldest first when omitted. */
  invoiceId?: string;
}

/**
 * Record a customer payment and post it.
 *
 * Card and ACH land in the processor clearing account, cash and cheques in undeposited
 * funds. Neither touches the bank account until the money actually arrives there, which is
 * what makes the bank reconciliation able to find anything.
 */
export async function recordPayment(
  db: PrismaClient,
  ctx: AuthContext,
  input: RecordPaymentInput,
) {
  requirePermission(ctx, PERMISSIONS.PAYMENT_RECORD);
  requireLocation(ctx, input.locationId);

  if (input.amountCents <= ZERO) throw new ValidationError('Payment must be a positive amount');

  return db.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError('Customer', input.customerId);

    const receivedAt = input.receivedAt ?? new Date();
    const isDeposit = input.isDeposit ?? false;
    const paymentNo = await nextDocumentNumber(tx, ctx.organizationId, 'PAYMENT');

    const targets = isDeposit
      ? []
      : await openInvoicesFor(tx, ctx.organizationId, input.customerId, input.invoiceId);

    const payment = await tx.payment.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: input.locationId,
        paymentNo,
        customerId: input.customerId,
        method: input.method,
        amountCents: input.amountCents,
        unappliedCents: input.amountCents,
        isDeposit,
        receivedAt,
        reference: input.reference ?? null,
        feeCents: input.feeCents ?? ZERO,
        // Only the processor's token and the display digits. Never a card number.
        processorToken: input.processorToken ?? null,
        cardLast4: input.cardLast4 ?? null,
        cardBrand: input.cardBrand ?? null,
      },
    });

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: receivedAt,
        source: 'PAYMENT',
        sourceType: 'Payment',
        sourceId: payment.id,
        memo: `Payment ${paymentNo}`,
        lines: paymentReceivedLines({
          paymentNo,
          locationId: input.locationId,
          customerId: input.customerId,
          method: input.method,
          amountCents: input.amountCents,
          feeCents: input.feeCents,
          isDeposit,
        }),
      },
      tx,
    );

    let remaining = input.amountCents;
    for (const invoice of targets) {
      if (remaining <= ZERO) break;
      const applied = remaining < invoice.balanceCents ? remaining : invoice.balanceCents;
      if (applied <= ZERO) continue;

      await tx.paymentApplication.create({
        data: { paymentId: payment.id, invoiceId: invoice.id, amountCents: applied },
      });

      const paid = invoice.paidCents + applied;
      const balance = invoice.totalCents - paid;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidCents: paid,
          balanceCents: balance,
          status: balance <= ZERO ? 'PAID' : 'PARTIALLY_PAID',
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

      remaining -= applied;
    }

    const settled = await tx.payment.update({
      where: { id: payment.id },
      data: { unappliedCents: remaining, journalEntryId: entry.id },
    });

    return { payment: settled, journalEntryId: entry.id, unappliedCents: remaining };
  });
}

type TxLike = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function openInvoicesFor(
  tx: TxLike,
  organizationId: string,
  customerId: string,
  invoiceId?: string,
) {
  return tx.invoice.findMany({
    where: {
      organizationId,
      customerId,
      ...(invoiceId ? { id: invoiceId } : {}),
      status: { in: ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'] },
      balanceCents: { gt: 0 },
    },
    // Oldest first: paying down the oldest receivable is what an aging report assumes.
    orderBy: { dueDate: 'asc' },
    select: {
      id: true,
      totalCents: true,
      paidCents: true,
      balanceCents: true,
      jobId: true,
    },
  });
}

async function unappliedDepositTotal(
  tx: TxLike,
  organizationId: string,
  customerId: string,
): Promise<Cents> {
  const deposits = await tx.payment.findMany({
    where: { organizationId, customerId, isDeposit: true, unappliedCents: { gt: 0 } },
    select: { unappliedCents: true },
  });
  return sum(deposits.map((d) => d.unappliedCents));
}

/** Draw down deposit payments oldest first, mirroring how the liability was built up. */
async function consumeDeposits(
  tx: TxLike,
  organizationId: string,
  customerId: string,
  amount: Cents,
): Promise<void> {
  let remaining = amount;

  const deposits = await tx.payment.findMany({
    where: { organizationId, customerId, isDeposit: true, unappliedCents: { gt: 0 } },
    orderBy: { receivedAt: 'asc' },
    select: { id: true, unappliedCents: true },
  });

  for (const deposit of deposits) {
    if (remaining <= ZERO) break;
    const used = remaining < deposit.unappliedCents ? remaining : deposit.unappliedCents;
    await tx.payment.update({
      where: { id: deposit.id },
      data: { unappliedCents: deposit.unappliedCents - used },
    });
    remaining -= used;
  }

  if (remaining > ZERO) {
    throw new ValidationError('Customer deposits were consumed concurrently; retry the posting');
  }
}

/** AR aging, straight off invoice balances. */
export async function agingReport(db: PrismaClient, ctx: AuthContext, asOf = new Date()) {
  requirePermission(ctx, PERMISSIONS.INVOICE_READ);

  const invoices = await scopedDb(db, ctx).invoice.findMany({
    where: { status: { in: ['OPEN', 'PARTIALLY_PAID', 'OVERDUE'] }, balanceCents: { gt: 0 } },
    select: {
      id: true,
      invoiceNo: true,
      customerId: true,
      dueDate: true,
      balanceCents: true,
      customer: { select: { companyName: true, firstName: true, lastName: true } },
    },
  });

  const buckets = { current: ZERO, days30: ZERO, days60: ZERO, days90: ZERO, over90: ZERO };

  for (const invoice of invoices) {
    const daysLate = Math.floor((asOf.getTime() - invoice.dueDate.getTime()) / 86_400_000);
    if (daysLate <= 0) buckets.current += invoice.balanceCents;
    else if (daysLate <= 30) buckets.days30 += invoice.balanceCents;
    else if (daysLate <= 60) buckets.days60 += invoice.balanceCents;
    else if (daysLate <= 90) buckets.days90 += invoice.balanceCents;
    else buckets.over90 += invoice.balanceCents;
  }

  return {
    asOf,
    buckets,
    totalCents: sum(Object.values(buckets)),
    invoices,
  };
}
