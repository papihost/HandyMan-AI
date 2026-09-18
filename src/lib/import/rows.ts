import type { AccountType, LineCategory, CustomerType } from '@prisma/client';
import { ZERO, type Cents } from '../money';
import {
  coerceBoolean,
  coerceDate,
  coerceEmail,
  coerceMoney,
  coerceNumber,
  coerceText,
  normalizePhone,
  type DateOrder,
} from './coerce';
import { ENTITY_FIELDS, type ImportEntity } from './schema';

/**
 * Turning mapped columns into candidate records.
 *
 * Pure: a row in, a record or a list of problems out. No database, so every rule here can
 * be tested against a table of awkward inputs, and the validation pass and the commit pass
 * are guaranteed to agree about what a row means — they run the same function.
 */

export type Severity = 'ERROR' | 'WARNING';

export interface RowIssue {
  /** Line number in the source file, counting the header as line 1. */
  line: number;
  field?: string;
  severity: Severity;
  message: string;
  value?: string;
}

export interface RowContext {
  fieldMap: Record<string, number>;
  dateOrder: DateOrder;
  decimalSeparator: '.' | ',';
}

export interface BuiltRow<T> {
  line: number;
  record: T | null;
  issues: RowIssue[];
}

class RowReader {
  readonly issues: RowIssue[] = [];

  constructor(
    private readonly values: readonly string[],
    private readonly line: number,
    private readonly ctx: RowContext,
  ) {}

  private raw(field: string): string {
    const index = this.ctx.fieldMap[field];
    if (index === undefined) return '';
    return this.values[index] ?? '';
  }

  has(field: string): boolean {
    return this.ctx.fieldMap[field] !== undefined && this.raw(field).trim() !== '';
  }

  fail(field: string, message: string, value?: string): void {
    this.issues.push({ line: this.line, field, severity: 'ERROR', message, value });
  }

  warn(field: string, message: string, value?: string): void {
    this.issues.push({ line: this.line, field, severity: 'WARNING', message, value });
  }

  text(field: string, options: { required?: boolean; maxLength?: number } = {}): string | null {
    const raw = this.raw(field);
    const result = coerceText(raw, options.maxLength);
    if (!result.ok) {
      this.fail(field, result.reason, raw);
      return null;
    }
    if (options.required && result.value === null) {
      this.fail(field, 'is required but empty');
    }
    return result.value;
  }

  email(field: string): string | null {
    const raw = this.raw(field);
    if (!raw.trim()) return null;
    const result = coerceEmail(raw);
    if (!result.ok) {
      // A bad email should not cost the customer record; drop the value and say so.
      this.warn(field, `${result.reason} — imported without it`, raw);
      return null;
    }
    return result.value;
  }

  money(field: string, options: { required?: boolean } = {}): Cents {
    const raw = this.raw(field);
    if (!raw.trim()) {
      if (options.required) this.fail(field, 'is required but empty');
      return ZERO;
    }
    const result = coerceMoney(raw, this.ctx.decimalSeparator);
    if (!result.ok) {
      this.fail(field, result.reason, raw);
      return ZERO;
    }
    return result.value;
  }

  date(field: string, options: { required?: boolean } = {}): Date | null {
    const raw = this.raw(field);
    if (!raw.trim()) {
      if (options.required) this.fail(field, 'is required but empty');
      return null;
    }
    const result = coerceDate(raw, this.ctx.dateOrder);
    if (!result.ok) {
      this.fail(field, result.reason, raw);
      return null;
    }
    if (result.value.getUTCFullYear() > new Date().getUTCFullYear() + 1) {
      this.warn(field, 'is more than a year in the future', raw);
    }
    return result.value;
  }

  number(field: string): number | null {
    const raw = this.raw(field);
    if (!raw.trim()) return null;
    const result = coerceNumber(raw);
    if (!result.ok) {
      this.fail(field, result.reason, raw);
      return null;
    }
    return result.value;
  }

  boolean(field: string, fallback = false): boolean {
    const raw = this.raw(field);
    if (!raw.trim()) return fallback;
    const result = coerceBoolean(raw);
    if (!result.ok) {
      this.warn(field, `${result.reason} — treated as ${fallback ? 'yes' : 'no'}`, raw);
      return fallback;
    }
    return result.value;
  }

  enum<T extends string>(field: string, allowed: readonly T[], fallback: T): T {
    const raw = this.raw(field).trim();
    if (!raw) return fallback;

    const normalized = raw.toUpperCase().replace(/[\s-]+/g, '_');
    const exact = allowed.find((a) => a === normalized);
    if (exact) return exact;

    const loose = allowed.find((a) => a.startsWith(normalized) || normalized.startsWith(a));
    if (loose) return loose;

    this.warn(field, `"${raw}" is not a recognised value — treated as ${fallback}`, raw);
    return fallback;
  }

  phone(field: string): { display: string | null; normalized: string | null } {
    const raw = this.raw(field).trim();
    if (!raw) return { display: null, normalized: null };

    const normalized = normalizePhone(raw);
    if (!normalized || normalized.length < 7) {
      this.warn(field, 'does not look like a phone number — imported as written', raw);
      return { display: raw, normalized: null };
    }
    return { display: raw, normalized };
  }
}

// ---------------------------------------------------------------- customers

export interface CustomerRow {
  externalId: string | null;
  type: CustomerType;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  billingAddress1: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostal: string | null;
  paymentTermsDays: number;
  isTaxExempt: boolean;
  notes: string | null;
  /** The service address, which may differ from where the bill goes. */
  property: {
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  } | null;
}

export function buildCustomerRow(
  values: readonly string[],
  line: number,
  ctx: RowContext,
): BuiltRow<CustomerRow> {
  const r = new RowReader(values, line, ctx);

  const companyName = r.text('companyName');
  const firstName = r.text('firstName');
  const lastName = r.text('lastName');

  if (!companyName && !lastName) {
    r.fail('lastName', 'needs either a company name or a last name');
  }

  const phone = r.phone('phone');
  const billingAddress1 = r.text('billingAddress1');
  const billingCity = r.text('billingCity');
  const billingState = r.text('billingState');
  const billingPostal = r.text('billingPostal');

  // Fall back to the billing address: a residential customer's bill goes where the work is.
  const serviceAddress1 = r.text('serviceAddress1') ?? billingAddress1;
  const serviceCity = r.text('serviceCity') ?? billingCity;
  const serviceState = r.text('serviceState') ?? billingState;
  const servicePostal = r.text('servicePostal') ?? billingPostal;

  const property =
    serviceAddress1 && serviceCity && serviceState && servicePostal
      ? {
          addressLine1: serviceAddress1,
          city: serviceCity,
          state: serviceState,
          postalCode: servicePostal,
        }
      : null;

  if (!property) {
    r.warn('serviceAddress1', 'no complete service address — imported without a property');
  }

  const record: CustomerRow = {
    externalId: r.text('externalId'),
    type: r.enum(
      'type',
      ['RESIDENTIAL', 'COMMERCIAL', 'PROPERTY_MANAGER', 'BUILDER'] as const,
      companyName ? 'COMMERCIAL' : 'RESIDENTIAL',
    ),
    companyName,
    firstName,
    lastName,
    email: r.email('email'),
    phone: phone.display,
    phoneNormalized: phone.normalized,
    billingAddress1,
    billingCity,
    billingState,
    billingPostal,
    paymentTermsDays: r.number('paymentTermsDays') ?? 0,
    isTaxExempt: r.boolean('isTaxExempt'),
    notes: r.text('notes', { maxLength: 4000 }),
    property,
  };

  const blocked = r.issues.some((i) => i.severity === 'ERROR');
  return { line, record: blocked ? null : record, issues: r.issues };
}

// ---------------------------------------------------------------- price book

export interface PriceBookRow {
  sku: string;
  name: string;
  description: string | null;
  category: LineCategory;
  costCents: Cents;
  priceCents: Cents;
  unit: string;
  isStocked: boolean;
  reorderPoint: number | null;
}

export function buildPriceBookRow(
  values: readonly string[],
  line: number,
  ctx: RowContext,
): BuiltRow<PriceBookRow> {
  const r = new RowReader(values, line, ctx);

  const sku = r.text('sku', { required: true, maxLength: 64 });
  const name = r.text('name', { required: true, maxLength: 200 });
  const costCents = r.money('costCents');
  const priceCents = r.money('priceCents');

  if (priceCents > ZERO && costCents > priceCents) {
    r.warn('priceCents', 'sells for less than it costs');
  }
  if (priceCents < ZERO || costCents < ZERO) {
    r.fail('priceCents', 'cost and price cannot be negative');
  }

  const record: PriceBookRow = {
    sku: sku ?? '',
    name: name ?? '',
    description: r.text('description', { maxLength: 4000 }),
    category: r.enum(
      'category',
      ['LABOR', 'MATERIAL', 'AGREEMENT', 'FEE', 'SUBCONTRACT'] as const,
      'MATERIAL',
    ),
    costCents,
    priceCents,
    unit: r.text('unit', { maxLength: 16 }) ?? 'ea',
    isStocked: r.boolean('isStocked'),
    reorderPoint: r.number('reorderPoint'),
  };

  const blocked = r.issues.some((i) => i.severity === 'ERROR');
  return { line, record: blocked ? null : record, issues: r.issues };
}

// ---------------------------------------------------------------- accounts

export interface AccountRow {
  code: string;
  name: string;
  type: AccountType;
  description: string | null;
}

/** Account types are named a dozen ways across packages; map the common ones. */
const ACCOUNT_TYPE_ALIASES: Record<string, AccountType> = {
  BANK: 'ASSET',
  ACCOUNTS_RECEIVABLE: 'ASSET',
  OTHER_CURRENT_ASSET: 'ASSET',
  FIXED_ASSET: 'ASSET',
  OTHER_ASSET: 'ASSET',
  ACCOUNTS_PAYABLE: 'LIABILITY',
  CREDIT_CARD: 'LIABILITY',
  OTHER_CURRENT_LIABILITY: 'LIABILITY',
  LONG_TERM_LIABILITY: 'LIABILITY',
  INCOME: 'REVENUE',
  SALES: 'REVENUE',
  OTHER_INCOME_ACCOUNT: 'OTHER_INCOME',
  COST_OF_GOODS_SOLD: 'COGS',
  COGS_ACCOUNT: 'COGS',
  EXPENSES: 'EXPENSE',
  OTHER_EXPENSE_ACCOUNT: 'OTHER_EXPENSE',
};

export function buildAccountRow(
  values: readonly string[],
  line: number,
  ctx: RowContext,
): BuiltRow<AccountRow> {
  const r = new RowReader(values, line, ctx);

  const code = r.text('code', { required: true, maxLength: 32 });
  const name = r.text('name', { required: true, maxLength: 200 });

  const rawType = ctx.fieldMap['type'] !== undefined ? (values[ctx.fieldMap['type']] ?? '') : '';
  const aliased = ACCOUNT_TYPE_ALIASES[rawType.trim().toUpperCase().replace(/[\s-]+/g, '_')];

  const type =
    aliased ??
    r.enum(
      'type',
      ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE'] as const,
      'EXPENSE',
    );

  const record: AccountRow = {
    code: code ?? '',
    name: name ?? '',
    type,
    description: r.text('description', { maxLength: 1000 }),
  };

  const blocked = r.issues.some((i) => i.severity === 'ERROR');
  return { line, record: blocked ? null : record, issues: r.issues };
}

// ---------------------------------------------------------------- open invoices

export interface OpenInvoiceRow {
  externalId: string | null;
  invoiceNo: string;
  customerRef: string;
  issueDate: Date;
  dueDate: Date | null;
  totalCents: Cents;
  balanceCents: Cents;
  poNumber: string | null;
  memo: string | null;
}

export function buildOpenInvoiceRow(
  values: readonly string[],
  line: number,
  ctx: RowContext,
): BuiltRow<OpenInvoiceRow> {
  const r = new RowReader(values, line, ctx);

  const invoiceNo = r.text('invoiceNo', { required: true, maxLength: 64 });
  const customerRef = r.text('customerRef', { required: true, maxLength: 200 });
  const issueDate = r.date('issueDate', { required: true });
  const dueDate = r.date('dueDate');
  const totalCents = r.money('totalCents', { required: true });

  // Not every export carries an open balance; where it does not, the whole invoice is open.
  const balanceCents = r.has('balanceCents') ? r.money('balanceCents') : totalCents;

  if (totalCents <= ZERO) {
    r.fail('totalCents', 'an open invoice must have a positive total');
  }
  if (balanceCents > totalCents) {
    r.fail('balanceCents', 'open balance is larger than the invoice total');
  }
  if (balanceCents <= ZERO) {
    r.warn('balanceCents', 'nothing outstanding — skipped, since only open items are imported');
  }
  if (dueDate && issueDate && dueDate < issueDate) {
    r.warn('dueDate', 'is before the invoice date');
  }

  const record: OpenInvoiceRow = {
    externalId: r.text('externalId'),
    invoiceNo: invoiceNo ?? '',
    customerRef: customerRef ?? '',
    issueDate: issueDate ?? new Date(),
    dueDate,
    totalCents,
    balanceCents,
    poNumber: r.text('poNumber', { maxLength: 64 }),
    memo: r.text('memo', { maxLength: 4000 }),
  };

  const blocked = r.issues.some((i) => i.severity === 'ERROR');
  return { line, record: blocked ? null : record, issues: r.issues };
}

// ---------------------------------------------------------------- trial balance

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string | null;
  debitCents: Cents;
  creditCents: Cents;
}

export function buildTrialBalanceRow(
  values: readonly string[],
  line: number,
  ctx: RowContext,
): BuiltRow<TrialBalanceRow> {
  const r = new RowReader(values, line, ctx);

  const accountCode = r.text('accountCode', { required: true, maxLength: 32 });
  let debitCents = r.money('debitCents');
  let creditCents = r.money('creditCents');

  // Some exports put a single signed amount in one column; a negative debit is a credit.
  if (debitCents < ZERO) {
    creditCents += -debitCents;
    debitCents = ZERO;
  }
  if (creditCents < ZERO) {
    debitCents += -creditCents;
    creditCents = ZERO;
  }

  if (debitCents > ZERO && creditCents > ZERO) {
    r.fail('debitCents', 'has both a debit and a credit');
  }
  if (debitCents === ZERO && creditCents === ZERO) {
    r.warn('debitCents', 'has no amount — skipped');
  }

  const record: TrialBalanceRow = {
    accountCode: accountCode ?? '',
    accountName: r.text('accountName', { maxLength: 200 }),
    debitCents,
    creditCents,
  };

  const blocked = r.issues.some((i) => i.severity === 'ERROR');
  return { line, record: blocked ? null : record, issues: r.issues };
}

// ---------------------------------------------------------------- dispatch

export type AnyRow = CustomerRow | PriceBookRow | AccountRow | OpenInvoiceRow | TrialBalanceRow;

export const ROW_BUILDERS: Record<
  ImportEntity,
  (values: readonly string[], line: number, ctx: RowContext) => BuiltRow<AnyRow>
> = {
  CUSTOMER: buildCustomerRow,
  PRICE_BOOK_ITEM: buildPriceBookRow,
  CHART_OF_ACCOUNTS: buildAccountRow,
  OPEN_INVOICE: buildOpenInvoiceRow,
  TRIAL_BALANCE: buildTrialBalanceRow,
};

/** Which field carries the amount a reconciliation report should total. */
export const RECONCILING_FIELD: Partial<Record<ImportEntity, (row: AnyRow) => Cents>> = {
  OPEN_INVOICE: (row) => (row as OpenInvoiceRow).balanceCents,
  TRIAL_BALANCE: (row) => {
    const tb = row as TrialBalanceRow;
    return tb.debitCents > ZERO ? tb.debitCents : tb.creditCents;
  },
};

export function requiredFieldsFor(entity: ImportEntity): string[] {
  return ENTITY_FIELDS[entity].filter((f) => f.required).map((f) => f.key);
}
