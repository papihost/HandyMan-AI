import type { PrismaClient } from '@prisma/client';
import {
  postingContextFor,
  requireLocation,
  requirePermission,
  systemContext,
  type AuthContext,
} from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { ZERO, type Cents } from '../money';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { directJobPurchaseLines } from '../accounting/rules/inventory';
import { subcontractorCostLines } from '../accounting/rules/labor';
import { refreshJobRollup } from '../jobs/costing';

/**
 * Purchasing and payables.
 *
 * The case that matters in the field is small and constant: a technician is mid-job, needs
 * a part nobody stocks, buys it at the supply house and photographs the receipt. If that
 * does not become a cost against the job within a minute of happening, it is either lost
 * entirely or lands next month against nothing in particular — and the job's margin is
 * wrong either way.
 */

export interface JobPurchaseInput {
  jobId: string;
  vendorId: string;
  amountCents: Cents;
  taxCents?: Cents;
  description: string;
  /** Storage key of the photographed receipt. */
  receiptPhotoKey?: string;
  vendorInvoiceNo?: string;
  purchasedAt?: Date;
  technicianId?: string;
  /** Subcontracted labor costs to 5040 rather than to materials. */
  isSubcontract?: boolean;
}

/**
 * Record a purchase made for one job: a vendor bill, a line coded to the job, and the
 * posting that puts the cost where the margin calculation will find it.
 */
export async function recordJobPurchase(
  db: PrismaClient,
  ctx: AuthContext,
  input: JobPurchaseInput,
) {
  requirePermission(ctx, PERMISSIONS.BILL_WRITE);
  if (input.amountCents <= ZERO) throw new ValidationError('A purchase must be a positive amount');

  const result = await db.$transaction(async (tx) => {
    const job = await tx.job.findFirst({
      where: { id: input.jobId, organizationId: ctx.organizationId },
      select: { id: true, jobNo: true, locationId: true, serviceTypeId: true, status: true },
    });
    if (!job) throw new NotFoundError('Job', input.jobId);
    requireLocation(ctx, job.locationId);
    if (job.status === 'CLOSED' || job.status === 'CANCELLED') {
      throw new ValidationError(`Job ${job.jobNo} is ${job.status}; costs cannot be added to it`);
    }

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, organizationId: ctx.organizationId },
      select: { id: true, name: true, paymentTermsDays: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', input.vendorId);

    const billDate = input.purchasedAt ?? new Date();
    const total = input.amountCents + (input.taxCents ?? ZERO);
    const billNo = await nextDocumentNumber(tx, ctx.organizationId, 'VENDOR_BILL');

    const accountCode = input.isSubcontract ? ACCOUNTS.COGS_SUBCONTRACTORS : ACCOUNTS.COGS_MATERIALS;
    const account = await tx.account.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, code: accountCode },
      select: { id: true },
    });

    const bill = await tx.vendorBill.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: job.locationId,
        billNo,
        vendorInvoiceNo: input.vendorInvoiceNo ?? null,
        vendorId: vendor.id,
        status: 'OPEN',
        billDate,
        dueDate: new Date(billDate.getTime() + vendor.paymentTermsDays * 86_400_000),
        subtotalCents: input.amountCents,
        taxCents: input.taxCents ?? ZERO,
        totalCents: total,
        receiptPhotoKey: input.receiptPhotoKey ?? null,
        lines: {
          create: {
            accountId: account.id,
            jobId: job.id,
            description: input.description,
            quantity: '1',
            unitCostCents: total,
            totalCents: total,
          },
        },
      },
    });

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: billDate,
        source: 'VENDOR_BILL',
        sourceType: 'VendorBill',
        sourceId: bill.id,
        memo: `${vendor.name} — ${input.description}`,
        lines: input.isSubcontract
          ? subcontractorCostLines({
              jobId: job.id,
              locationId: job.locationId,
              vendorId: vendor.id,
              amountCents: total,
              billNo,
            })
          : directJobPurchaseLines({
              jobId: job.id,
              locationId: job.locationId,
              vendorId: vendor.id,
              technicianId: input.technicianId,
              serviceTypeId: job.serviceTypeId,
              amountCents: total,
              reference: billNo,
            }),
      },
      tx,
    );

    await tx.vendorBill.update({ where: { id: bill.id }, data: { journalEntryId: entry.id } });
    return { bill, journalEntryId: entry.id, jobId: job.id };
  });

  await refreshJobRollup(db, systemContext(ctx.organizationId, ctx.userId), result.jobId);
  return result;
}

export interface PayBillsOptions {
  /** Pay everything open and due on or before this date. */
  throughDate?: Date;
  /** Or pay exactly these bills, whenever they fall due. */
  billIds?: string[];
  /**
   * When the money left the bank. It defaults to the due-date cutoff, because that is
   * what a month-end run means — everything due by the 30th, paid on the 30th. A run made
   * today against bills due next week is a different thing and should say so.
   */
  paidAt?: Date;
  method?: string;
  /** Cheque number, ACH batch, whatever the bank statement will show. */
  reference?: string;
  bankAccountCode?: string;
}

/**
 * Pay bills.
 *
 *   Dr Accounts Payable   Cr Operating Bank Account
 *
 * Either everything due by a date — the Friday run every shop does — or a named set,
 * because the other half of paying bills is choosing not to pay one: a disputed invoice, a
 * vendor being held, a bill somebody wants to settle early to keep a discount.
 *
 * One journal entry covers the run and a payment record is written against each bill, so
 * the bank statement line and the individual bills it settled can be reconciled to each
 * other afterwards. A run that only flipped statuses would leave the ledger unable to say
 * which bills a payment covered.
 */
export async function payOpenBills(
  db: PrismaClient,
  ctx: AuthContext,
  options: PayBillsOptions,
) {
  requirePermission(ctx, PERMISSIONS.BILL_PAY);

  const selected = options.billIds && options.billIds.length > 0;
  if (!selected && !options.throughDate) {
    throw new ValidationError('Pay which bills — a set, or everything due by a date?');
  }

  const bills = await db.vendorBill.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: { in: ['OPEN', 'PARTIALLY_PAID'] },
      ...(selected
        ? { id: { in: options.billIds } }
        : { dueDate: { lte: options.throughDate } }),
    },
    orderBy: [{ dueDate: 'asc' }, { billNo: 'asc' }],
    select: {
      id: true,
      billNo: true,
      totalCents: true,
      paidCents: true,
      vendorId: true,
      locationId: true,
      vendor: { select: { name: true } },
    },
  });

  if (selected && bills.length !== options.billIds!.length) {
    // Something in the list is already paid, cancelled, or not this organization's. Paying
    // the rest silently is how a bill gets paid twice by two people on the same afternoon.
    throw new ValidationError('One of those bills is no longer open — reload and try again');
  }

  const empty = { paidCount: 0, totalCents: ZERO, journalEntryId: null, bills: [] as PaidBill[] };
  if (bills.length === 0) return empty;

  const total = bills.reduce((t, b) => t + (b.totalCents - b.paidCents), ZERO);
  if (total <= ZERO) return empty;

  const paidAt = options.paidAt ?? options.throughDate ?? new Date();
  const bankCode = options.bankAccountCode ?? ACCOUNTS.BANK_OPERATING;

  return db.$transaction(async (tx) => {
    const bank = await tx.account.findFirst({
      where: { organizationId: ctx.organizationId, code: bankCode },
      select: { id: true },
    });
    if (!bank) throw new NotFoundError('Account', bankCode);

    const entry = await postJournalEntry(
      db,
      postingContextFor(ctx),
      {
        entryDate: paidAt,
        source: 'BILL_PAYMENT',
        memo: selected
          ? `Paid ${bills.length} ${bills.length === 1 ? 'bill' : 'bills'}`
          : `Payables run through ${options.throughDate!.toISOString().slice(0, 10)}`,
        lines: [
          { accountCode: ACCOUNTS.AP, debitCents: total },
          { accountCode: bankCode, creditCents: total },
        ],
      },
      tx,
    );

    const paid: PaidBill[] = [];

    for (const bill of bills) {
      const amountCents = bill.totalCents - bill.paidCents;
      const paymentNo = await nextDocumentNumber(tx, ctx.organizationId, 'BILL_PAYMENT');

      await tx.billPayment.create({
        data: {
          organizationId: ctx.organizationId,
          vendorBillId: bill.id,
          paymentNo,
          amountCents,
          method: options.method ?? 'ACH',
          reference: options.reference ?? null,
          bankAccountId: bank.id,
          paidAt,
          journalEntryId: entry.id,
        },
      });

      await tx.vendorBill.update({
        where: { id: bill.id },
        data: { status: 'PAID', paidCents: bill.totalCents },
      });

      paid.push({
        billId: bill.id,
        billNo: bill.billNo,
        paymentNo,
        vendorName: bill.vendor.name,
        amountCents,
      });
    }

    return { paidCount: bills.length, totalCents: total, journalEntryId: entry.id, bills: paid };
  });
}

export interface PaidBill {
  billId: string;
  billNo: string;
  paymentNo: string;
  vendorName: string;
  amountCents: Cents;
}
