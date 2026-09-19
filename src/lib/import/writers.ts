import type { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../auth/context';
import { sum, ZERO, type Cents } from '../money';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { normalizePhone } from './coerce';
import type {
  AccountRow,
  CustomerRow,
  OpenInvoiceRow,
  PriceBookRow,
  RowIssue,
  TrialBalanceRow,
} from './rows';

/**
 * Writing imported records.
 *
 * Every record is stamped with the batch that created it and, where the source had one,
 * the id it carried there. That is what makes a second run an update rather than a
 * duplication, and what makes the whole batch reversible until the first live transaction
 * is recorded.
 */

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface WriteResult {
  imported: number;
  skipped: number;
  updated: number;
  /** Total the reconciliation report compares against the source file. */
  importedTotalCents: Cents;
  /**
   * Amount the file carried that this import was right not to write: a trial balance line
   * whose subledger already came across, or the opening equity plug the importer computes
   * for itself. It is not a discrepancy, so the reconciliation deducts it from the file's
   * total before comparing — otherwise a correct import reports itself as out by the
   * receivables it deliberately declined to count twice.
   */
  deliberatelyExcludedCents: Cents;
  issues: RowIssue[];
  notes: string[];
}

const empty = (): WriteResult => ({
  imported: 0,
  skipped: 0,
  updated: 0,
  importedTotalCents: ZERO,
  deliberatelyExcludedCents: ZERO,
  issues: [],
  notes: [],
});

// ---------------------------------------------------------------- customers

export async function writeCustomers(
  tx: Tx,
  ctx: AuthContext,
  rows: { line: number; record: CustomerRow }[],
  batchId: string,
): Promise<WriteResult> {
  const result = empty();
  if (rows.length === 0) return result;

  // Load once rather than per row: a 600-row file would otherwise be 1,800 queries.
  const existing = await tx.customer.findMany({
    where: { organizationId: ctx.organizationId },
    select: {
      id: true,
      externalId: true,
      email: true,
      phoneNormalized: true,
      companyName: true,
      lastName: true,
    },
  });

  const byExternalId = new Map(existing.filter((c) => c.externalId).map((c) => [c.externalId!, c.id]));
  const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email!, c.id]));
  const byPhone = new Map(
    existing.filter((c) => c.phoneNormalized).map((c) => [c.phoneNormalized!, c.id]),
  );

  // Duplicates inside the file itself are as common as duplicates against the database.
  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  /** Existing customers already touched by this run, so a repeated row is not applied twice. */
  const touched = new Set<string>();

  const startNo = await reserveNumbers(tx, ctx.organizationId, 'CUSTOMER', rows.length);
  let offset = 0;

  for (const { line, record } of rows) {
    const match =
      (record.externalId ? byExternalId.get(record.externalId) : undefined) ??
      (record.email ? byEmail.get(record.email) : undefined) ??
      (record.phoneNormalized ? byPhone.get(record.phoneNormalized) : undefined);

    if (match && touched.has(match)) {
      result.skipped++;
      result.issues.push({
        line,
        severity: 'WARNING',
        message: 'the same customer appears earlier in this file — skipped',
      });
      continue;
    }

    if (match) {
      // Re-running an import updates rather than duplicating, which is what makes a trial
      // run followed by a real cutover two weeks later safe.
      await tx.customer.update({
        where: { id: match },
        data: {
          companyName: record.companyName,
          firstName: record.firstName,
          lastName: record.lastName,
          email: record.email,
          phone: record.phone,
          phoneNormalized: record.phoneNormalized,
          billingAddress1: record.billingAddress1,
          billingCity: record.billingCity,
          billingState: record.billingState,
          billingPostal: record.billingPostal,
          paymentTermsDays: record.paymentTermsDays,
          isTaxExempt: record.isTaxExempt,
          externalId: record.externalId,
          importBatchId: batchId,
        },
      });
      touched.add(match);
      result.updated++;
      result.issues.push({
        line,
        severity: 'WARNING',
        message: 'matched an existing customer and was updated rather than added',
      });
      continue;
    }

    if (record.email && seenEmail.has(record.email)) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'email',
        severity: 'WARNING',
        message: 'duplicate of an earlier row in this file — skipped',
        value: record.email,
      });
      continue;
    }
    if (record.phoneNormalized && seenPhone.has(record.phoneNormalized)) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'phone',
        severity: 'WARNING',
        message: 'duplicate of an earlier row in this file — skipped',
        value: record.phone ?? undefined,
      });
      continue;
    }

    if (record.email) seenEmail.add(record.email);
    if (record.phoneNormalized) seenPhone.add(record.phoneNormalized);

    await tx.customer.create({
      data: {
        organizationId: ctx.organizationId,
        customerNo: `C-${String(startNo + offset).padStart(5, '0')}`,
        type: record.type,
        companyName: record.companyName,
        firstName: record.firstName,
        lastName: record.lastName,
        email: record.email,
        phone: record.phone,
        phoneNormalized: record.phoneNormalized,
        billingAddress1: record.billingAddress1,
        billingCity: record.billingCity,
        billingState: record.billingState,
        billingPostal: record.billingPostal,
        paymentTermsDays: record.paymentTermsDays,
        isTaxExempt: record.isTaxExempt,
        notes: record.notes,
        externalId: record.externalId,
        importBatchId: batchId,
        ...(record.property ? { properties: { create: record.property } } : {}),
      },
    });
    offset++;
    result.imported++;
  }

  if (result.updated > 0) {
    result.notes.push(`${result.updated} existing customers were updated rather than duplicated`);
  }
  return result;
}

// ---------------------------------------------------------------- price book

export async function writePriceBookItems(
  tx: Tx,
  ctx: AuthContext,
  rows: { line: number; record: PriceBookRow }[],
  batchId: string,
): Promise<WriteResult> {
  const result = empty();

  const existing = await tx.priceBookItem.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, sku: true },
  });
  const bySku = new Map(existing.map((i) => [i.sku.toLowerCase(), i.id]));
  const seen = new Set<string>();

  for (const { line, record } of rows) {
    const key = record.sku.toLowerCase();

    if (seen.has(key)) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'sku',
        severity: 'WARNING',
        message: 'the same SKU appears earlier in this file — skipped',
        value: record.sku,
      });
      continue;
    }
    seen.add(key);

    const data = {
      name: record.name,
      description: record.description,
      category: record.category,
      kind: record.isStocked ? ('PART' as const) : record.category === 'LABOR' ? ('LABOR' as const) : ('MATERIAL' as const),
      unit: record.unit,
      costCents: record.costCents,
      priceCents: record.priceCents,
      isStocked: record.isStocked,
      reorderPoint: record.reorderPoint?.toString() ?? null,
      importBatchId: batchId,
    };

    const match = bySku.get(key);
    if (match) {
      await tx.priceBookItem.update({ where: { id: match }, data });
      result.updated++;
      continue;
    }

    await tx.priceBookItem.create({
      data: { organizationId: ctx.organizationId, sku: record.sku, ...data },
    });
    result.imported++;
  }

  if (result.updated > 0) {
    result.notes.push(`${result.updated} existing price book items were updated`);
  }
  return result;
}

// ---------------------------------------------------------------- accounts

export async function writeAccounts(
  tx: Tx,
  ctx: AuthContext,
  rows: { line: number; record: AccountRow }[],
  batchId: string,
): Promise<WriteResult> {
  const result = empty();

  const existing = await tx.account.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, code: true, isSystem: true },
  });
  const byCode = new Map(existing.map((a) => [a.code, a]));

  for (const { line, record } of rows) {
    const match = byCode.get(record.code);

    if (match?.isSystem) {
      // Posting rules reference these by code. They may be renamed, never retyped.
      await tx.account.update({
        where: { id: match.id },
        data: { name: record.name, description: record.description },
      });
      result.updated++;
      result.issues.push({
        line,
        field: 'type',
        severity: 'WARNING',
        message: 'this account is used by the posting rules — renamed, but its type was kept',
        value: record.type,
      });
      continue;
    }

    if (match) {
      await tx.account.update({
        where: { id: match.id },
        data: { name: record.name, type: record.type, description: record.description, importBatchId: batchId },
      });
      result.updated++;
      continue;
    }

    await tx.account.create({
      data: {
        organizationId: ctx.organizationId,
        code: record.code,
        name: record.name,
        type: record.type,
        description: record.description,
        importBatchId: batchId,
      },
    });
    result.imported++;
  }

  return result;
}

// ---------------------------------------------------------------- open invoices

/**
 * Open receivables at cutover.
 *
 * Each invoice is created as an open document so it appears on the aging report and can be
 * paid, and the balance is posted:
 *
 *   Dr  1200 Accounts Receivable
 *     Cr  3900 Opening Balance Equity
 *
 * The offset goes to Opening Balance Equity rather than to revenue, because this work was
 * earned before the cutover and recognising it again would overstate the year.
 */
export async function writeOpenInvoices(
  db: PrismaClient,
  tx: Tx,
  ctx: AuthContext,
  rows: { line: number; record: OpenInvoiceRow }[],
  batchId: string,
  cutoverDate: Date,
): Promise<WriteResult> {
  const result = empty();
  if (rows.length === 0) return result;

  const customers = await tx.customer.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, externalId: true, customerNo: true, companyName: true, lastName: true, firstName: true },
  });

  const lookup = new Map<string, string>();
  for (const customer of customers) {
    for (const key of customerKeys(customer)) {
      if (key && !lookup.has(key)) lookup.set(key, customer.id);
    }
  }

  const location = await tx.location.findFirst({
    where: { organizationId: ctx.organizationId },
    orderBy: { code: 'asc' },
    select: { id: true },
  });
  if (!location) {
    result.issues.push({
      line: 0,
      severity: 'ERROR',
      message: 'no location exists yet — create at least one branch before importing invoices',
    });
    return result;
  }

  const existing = await tx.invoice.findMany({
    where: { organizationId: ctx.organizationId },
    select: { invoiceNo: true },
  });
  const usedNumbers = new Set(existing.map((i) => i.invoiceNo));

  let posted = ZERO;

  for (const { line, record } of rows) {
    if (record.balanceCents <= ZERO) {
      result.skipped++;
      continue;
    }

    const customerId = lookup.get(normalizeKey(record.customerRef));
    if (!customerId) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'customerRef',
        severity: 'ERROR',
        message: 'no customer of that name or id was found — import customers first',
        value: record.customerRef,
      });
      continue;
    }

    if (usedNumbers.has(record.invoiceNo)) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'invoiceNo',
        severity: 'WARNING',
        message: 'an invoice with this number already exists — skipped',
        value: record.invoiceNo,
      });
      continue;
    }
    usedNumbers.add(record.invoiceNo);

    const paid = record.totalCents - record.balanceCents;

    await tx.invoice.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: location.id,
        invoiceNo: record.invoiceNo,
        customerId,
        status: paid > ZERO ? 'PARTIALLY_PAID' : 'OPEN',
        issueDate: record.issueDate,
        dueDate: record.dueDate ?? record.issueDate,
        poNumber: record.poNumber,
        memo: record.memo,
        // No lines: the detail lived in the old system. What carries over is the balance,
        // which is what the customer owes and what the ledger has to agree with.
        subtotalCents: record.totalCents,
        totalCents: record.totalCents,
        paidCents: paid,
        balanceCents: record.balanceCents,
        externalId: record.externalId,
        importBatchId: batchId,
      },
    });

    posted += record.balanceCents;
    result.imported++;
  }

  if (posted > ZERO) {
    const entry = await postJournalEntry(
      db,
      ctx,
      {
        entryDate: cutoverDate,
        source: 'OPENING_BALANCE',
        sourceType: 'ImportBatch',
        sourceId: batchId,
        memo: 'Opening accounts receivable at cutover',
        lines: [
          { accountCode: ACCOUNTS.AR, debitCents: posted },
          { accountCode: ACCOUNTS.OPENING_BALANCE_EQUITY, creditCents: posted },
        ],
      },
      tx,
    );
    await tx.journalEntry.update({ where: { id: entry.id }, data: { importBatchId: batchId } });
    result.notes.push(`Posted ${entry.entryNo}: receivables against Opening Balance Equity`);
  }

  result.importedTotalCents = posted;
  return result;
}

function customerKeys(customer: {
  externalId: string | null;
  customerNo: string;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
}): string[] {
  const full = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
  return [
    customer.externalId,
    customer.customerNo,
    customer.companyName,
    full,
    // "Surname, Forename" is how accounting packages print a customer list.
    customer.lastName && customer.firstName ? `${customer.lastName}, ${customer.firstName}` : null,
    customer.lastName,
  ]
    .filter((v): v is string => !!v)
    .map(normalizeKey);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- trial balance

/**
 * The trial balance at cutover.
 *
 * Accounts already loaded from a subledger are skipped: receivables came over as invoices,
 * and posting them again from the trial balance would double the balance sheet. Whatever
 * the remaining lines do not balance to is exactly the opening equity already raised by
 * those subledger imports, so the plug goes to 3900 and that account nets to zero.
 *
 * If it does not net to zero, the migration is out of balance and the wizard says so
 * loudly rather than leaving a broken ledger to be discovered at the first month end.
 */
export async function writeTrialBalance(
  db: PrismaClient,
  tx: Tx,
  ctx: AuthContext,
  rows: { line: number; record: TrialBalanceRow }[],
  batchId: string,
  cutoverDate: Date,
): Promise<WriteResult> {
  const result = empty();
  if (rows.length === 0) return result;

  const accounts = await tx.account.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, code: true, name: true },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  /**
   * Accounts a subledger import may already have loaded.
   *
   * Whether to skip one is decided by looking, not by assuming: if open invoices were
   * imported, receivables are already on the ledger and taking them from the trial
   * balance as well would double them. If they were not, the trial balance is the only
   * place that balance is coming from, and dropping it would quietly bury it in opening
   * equity instead.
   */
  const subledgerBalances = new Map<string, Cents>();
  for (const code of [ACCOUNTS.AR, ACCOUNTS.AP]) {
    const account = byCode.get(code);
    if (!account) continue;
    const totals = await tx.journalLine.aggregate({
      where: { accountId: account.id, journalEntry: { postedAt: { not: null } } },
      _sum: { debitCents: true, creditCents: true },
    });
    const balance = (totals._sum.debitCents ?? ZERO) - (totals._sum.creditCents ?? ZERO);
    if (balance !== ZERO) subledgerBalances.set(code, balance);
  }

  const lines: { accountCode: string; debitCents?: Cents; creditCents?: Cents; memo: string }[] = [];
  let debits = ZERO;
  let credits = ZERO;

  for (const { line, record } of rows) {
    if (record.debitCents === ZERO && record.creditCents === ZERO) {
      result.skipped++;
      continue;
    }

    if (!byCode.has(record.accountCode)) {
      result.skipped++;
      result.issues.push({
        line,
        field: 'accountCode',
        severity: 'ERROR',
        message: 'no account with this number — import the chart of accounts first',
        value: record.accountCode,
      });
      continue;
    }

    if (subledgerBalances.has(record.accountCode)) {
      result.skipped++;
      result.deliberatelyExcludedCents +=
        record.debitCents > ZERO ? record.debitCents : record.creditCents;
      result.issues.push({
        line,
        field: 'accountCode',
        severity: 'WARNING',
        message:
          'already carried over from its own subledger — skipped here to avoid counting it twice',
        value: record.accountCode,
      });
      continue;
    }

    if (record.accountCode === ACCOUNTS.OPENING_BALANCE_EQUITY) {
      result.skipped++;
      result.deliberatelyExcludedCents +=
        record.debitCents > ZERO ? record.debitCents : record.creditCents;
      result.issues.push({
        line,
        field: 'accountCode',
        severity: 'WARNING',
        message: 'Opening Balance Equity is calculated, not imported — skipped',
      });
      continue;
    }

    lines.push({
      accountCode: record.accountCode,
      ...(record.debitCents > ZERO ? { debitCents: record.debitCents } : { creditCents: record.creditCents }),
      memo: record.accountName ?? 'Opening balance',
    });
    debits += record.debitCents;
    credits += record.creditCents;
    result.imported++;
  }

  if (lines.length === 0) {
    result.issues.push({ line: 0, severity: 'ERROR', message: 'no usable trial balance rows' });
    return result;
  }

  // The plug that makes the entry balance is, by construction, the opening equity the
  // subledger imports raised.
  const plug = debits - credits;
  if (plug !== ZERO) {
    lines.push({
      accountCode: ACCOUNTS.OPENING_BALANCE_EQUITY,
      ...(plug > ZERO ? { creditCents: plug } : { debitCents: -plug }),
      memo: 'Opening balance equity',
    });
  }

  const entry = await postJournalEntry(
    db,
    ctx,
    {
      entryDate: cutoverDate,
      source: 'OPENING_BALANCE',
      sourceType: 'ImportBatch',
      sourceId: batchId,
      memo: 'Trial balance at cutover',
      lines,
    },
    tx,
  );
  await tx.journalEntry.update({ where: { id: entry.id }, data: { importBatchId: batchId } });

  result.importedTotalCents = debits;
  result.notes.push(`Posted ${entry.entryNo}: ${lines.length} opening balance lines`);
  return result;
}

/** Take a block of document numbers in one go, rather than one call per row. */
async function reserveNumbers(
  tx: Tx,
  organizationId: string,
  docType: 'CUSTOMER',
  count: number,
): Promise<number> {
  const first = await nextDocumentNumber(tx, organizationId, docType);
  const start = Number(first.replace(/\D/g, ''));

  if (count > 1) {
    await tx.documentSequence.updateMany({
      where: { organizationId, docType, locationCode: '' },
      data: { nextValue: start + count },
    });
  }
  return start;
}

export function totalOf(values: Iterable<Cents>): Cents {
  return sum(values);
}
