import type { LineCategory } from '@prisma/client';
import { ValidationError } from '../../errors';
import { sum, ZERO, type Cents } from '../../money';
import { ACCOUNTS } from '../chart-of-accounts';
import type { PostingLine } from '../ledger';

export interface InvoiceRevenueLine {
  /**
   * Which revenue account this line belongs in. The same categorisation decides the
   * line's sales-tax treatment, so revenue reporting and tax can never disagree about
   * what a line is.
   */
  category: LineCategory;
  amountCents: Cents;
  /** Overrides the category default, for customers who split revenue further. */
  revenueAccountCode?: string;
  serviceTypeId?: string | null;
  description?: string;
}

export interface InvoiceTaxAllocation {
  /** The jurisdiction's own sub-account under 2100, so the filing report is a query. */
  liabilityAccountCode?: string;
  taxCents: Cents;
  jurisdictionName?: string;
}

export interface InvoicePostingInput {
  invoiceNo: string;
  locationId: string;
  customerId: string;
  jobId?: string | null;
  technicianId?: string | null;
  revenueLines: InvoiceRevenueLine[];
  /** Positive amount; posted as a debit to contra-revenue. */
  discountCents?: Cents;
  taxes?: InvoiceTaxAllocation[];
  /** Deposit held against this customer being consumed by this invoice. */
  depositAppliedCents?: Cents;
}

const REVENUE_ACCOUNT: Record<LineCategory, string> = {
  LABOR: ACCOUNTS.REVENUE_LABOR,
  MATERIAL: ACCOUNTS.REVENUE_MATERIALS,
  AGREEMENT: ACCOUNTS.REVENUE_AGREEMENTS,
  FEE: ACCOUNTS.REVENUE_FEES,
  // Subcontracted work is still revenue to us; its cost lands in 5040.
  SUBCONTRACT: ACCOUNTS.REVENUE_LABOR,
};

/**
 * Invoice issued.
 *
 *   Dr  Accounts Receivable            gross - deposit applied
 *   Dr  Customer Deposits              deposit applied      (relieves the liability)
 *   Dr  Discounts & Allowances         discount             (contra-revenue)
 *     Cr  Service Revenue — Labor      labor
 *     Cr  Service Revenue — Materials  materials
 *     Cr  Sales Tax Payable            tax, per jurisdiction
 */
export function invoiceIssuedLines(input: InvoicePostingInput): PostingLine[] {
  const revenue = sum(input.revenueLines.map((l) => l.amountCents));
  const discount = input.discountCents ?? ZERO;
  const tax = sum((input.taxes ?? []).map((t) => t.taxCents));
  const depositApplied = input.depositAppliedCents ?? ZERO;

  if (revenue <= ZERO) throw new ValidationError('An invoice must carry at least one revenue line');
  if (discount < ZERO) throw new ValidationError('Discount must be a positive amount');
  if (depositApplied < ZERO) throw new ValidationError('Applied deposit must be a positive amount');

  const gross = revenue - discount + tax;
  if (depositApplied > gross) {
    throw new ValidationError('Applied deposit exceeds the invoice total');
  }

  const dimensions = {
    locationId: input.locationId,
    jobId: input.jobId ?? null,
    customerId: input.customerId,
    technicianId: input.technicianId ?? null,
  };

  const lines: PostingLine[] = [];
  const receivable = gross - depositApplied;

  if (receivable > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.AR,
      debitCents: receivable,
      memo: `Invoice ${input.invoiceNo}`,
      ...dimensions,
    });
  }

  if (depositApplied > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.CUSTOMER_DEPOSITS,
      debitCents: depositApplied,
      memo: `Deposit applied to invoice ${input.invoiceNo}`,
      ...dimensions,
    });
  }

  if (discount > ZERO) {
    lines.push({
      accountCode: ACCOUNTS.DISCOUNTS,
      debitCents: discount,
      memo: `Discount on invoice ${input.invoiceNo}`,
      ...dimensions,
    });
  }

  for (const line of input.revenueLines) {
    if (line.amountCents === ZERO) continue;
    if (line.amountCents < ZERO) {
      throw new ValidationError('Revenue lines must be positive; use a credit memo to reduce revenue');
    }
    lines.push({
      accountCode: line.revenueAccountCode ?? REVENUE_ACCOUNT[line.category],
      creditCents: line.amountCents,
      memo: line.description ?? `Invoice ${input.invoiceNo}`,
      ...dimensions,
      serviceTypeId: line.serviceTypeId ?? null,
    });
  }

  for (const t of input.taxes ?? []) {
    if (t.taxCents === ZERO) continue;
    lines.push({
      accountCode: t.liabilityAccountCode ?? ACCOUNTS.SALES_TAX_PAYABLE,
      creditCents: t.taxCents,
      memo: t.jurisdictionName
        ? `Sales tax — ${t.jurisdictionName} — ${input.invoiceNo}`
        : `Sales tax — ${input.invoiceNo}`,
      ...dimensions,
    });
  }

  return lines;
}

/**
 * Invoice written off as uncollectable.
 *
 *   Dr  Bad Debt Expense
 *     Cr  Accounts Receivable
 */
export function invoiceWrittenOffLines(input: {
  invoiceNo: string;
  locationId: string;
  customerId: string;
  amountCents: Cents;
}): PostingLine[] {
  if (input.amountCents <= ZERO) throw new ValidationError('Write-off must be a positive amount');

  const dimensions = { locationId: input.locationId, customerId: input.customerId };
  return [
    {
      accountCode: ACCOUNTS.BAD_DEBT,
      debitCents: input.amountCents,
      memo: `Write-off of invoice ${input.invoiceNo}`,
      ...dimensions,
    },
    {
      accountCode: ACCOUNTS.AR,
      creditCents: input.amountCents,
      memo: `Write-off of invoice ${input.invoiceNo}`,
      ...dimensions,
    },
  ];
}

export interface CreditMemoPostingInput {
  creditMemoNo: string;
  invoiceNo: string;
  locationId: string;
  customerId: string;
  jobId?: string | null;
  /** The revenue being given back, split the way the invoice split it. */
  revenueLines: InvoiceRevenueLine[];
  taxes?: InvoiceTaxAllocation[];
}

/**
 * Credit memo issued.
 *
 *   Dr  Service Revenue — Labor       the labour being given back
 *   Dr  Service Revenue — Materials   the materials being given back
 *   Dr  Sales Tax Payable             the tax on what was credited
 *     Cr  Accounts Receivable         what the customer no longer owes
 *
 * The exact inverse of issuing, and deliberately not a reversal of it: the original
 * invoice was right when it was written, and a credit is a second event with its own date
 * and its own reason. A reversal would make the sale look as though it had never
 * happened, which is what a void is for and is a different claim entirely.
 *
 * The tax comes back out of the liability. A shop that credits a customer and keeps the
 * tax in the account remits money it never collected, and finds out at the filing.
 */
export function creditMemoLines(input: CreditMemoPostingInput): PostingLine[] {
  const revenue = sum(input.revenueLines.map((l) => l.amountCents));
  const tax = sum((input.taxes ?? []).map((t) => t.taxCents));

  if (revenue + tax <= ZERO) throw new ValidationError('A credit memo needs an amount');
  if (revenue < ZERO || tax < ZERO) {
    throw new ValidationError('Credit amounts are positive; they are posted as debits');
  }

  const dimensions = {
    locationId: input.locationId,
    jobId: input.jobId ?? null,
    customerId: input.customerId,
  };

  const lines: PostingLine[] = [];

  for (const line of input.revenueLines) {
    if (line.amountCents === ZERO) continue;
    lines.push({
      accountCode: line.revenueAccountCode ?? REVENUE_ACCOUNT[line.category],
      debitCents: line.amountCents,
      memo: `Credit ${input.creditMemoNo} against ${input.invoiceNo}`,
      ...dimensions,
      serviceTypeId: line.serviceTypeId ?? null,
    });
  }

  for (const t of input.taxes ?? []) {
    if (t.taxCents === ZERO) continue;
    lines.push({
      accountCode: t.liabilityAccountCode ?? ACCOUNTS.SALES_TAX_PAYABLE,
      debitCents: t.taxCents,
      memo: t.jurisdictionName
        ? `Sales tax credited — ${t.jurisdictionName} — ${input.creditMemoNo}`
        : `Sales tax credited — ${input.creditMemoNo}`,
      ...dimensions,
    });
  }

  lines.push({
    accountCode: ACCOUNTS.AR,
    creditCents: revenue + tax,
    memo: `Credit ${input.creditMemoNo} against ${input.invoiceNo}`,
    ...dimensions,
  });

  return lines;
}
