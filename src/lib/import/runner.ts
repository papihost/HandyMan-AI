import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { formatMoney, sum, ZERO, type Cents } from '../money';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { parseFile, detectDelimiter, detectHeaderRow, type ParsedFile } from './csv';
import { proposeMapping, type MappingProposal } from './mapping';
import { ENTITY_LABELS, IMPORT_ORDER, type ImportEntity } from './schema';
import {
  RECONCILING_FIELD,
  ROW_BUILDERS,
  type AnyRow,
  type RowContext,
  type RowIssue,
} from './rows';
import {
  writeAccounts,
  writeCustomers,
  writeOpenInvoices,
  writePriceBookItems,
  writeTrialBalance,
  type Tx,
} from './writers';

/**
 * The import wizard's engine.
 *
 *   Upload → Detect → Map → Validate → Preview → Dry run → Commit → Reconcile
 *
 * The two steps that decide whether a customer trusts this are the dry run and the
 * reconciliation. The dry run executes the entire import inside a transaction that is then
 * rolled back, so the counts, the errors and the ledger impact shown are the real ones
 * rather than a prediction. The reconciliation proves the imported totals match the source
 * file, and that opening equity nets to zero.
 */

export interface AnalyzedFile {
  parsed: ParsedFile;
  mapping: MappingProposal;
  delimiter: string;
  headerRow: number;
  preview: Record<string, string>[];
}

/** Detect the shape of a file and propose how its columns map. */
export function analyzeFile(text: string, entity: ImportEntity, previewRows = 20): AnalyzedFile {
  const delimiter = detectDelimiter(text);
  const headerRow = detectHeaderRow(text, delimiter);
  const parsed = parseFile(text, { delimiter, skipRows: headerRow });
  const mapping = proposeMapping(entity, parsed.header, parsed.rows);

  const preview = parsed.rows.slice(0, previewRows).map((row) =>
    Object.fromEntries(parsed.header.map((heading, index) => [heading, row[index] ?? ''])),
  );

  return { parsed, mapping, delimiter, headerRow, preview };
}

export interface ValidationReport {
  entity: ImportEntity;
  entityLabel: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  issues: RowIssue[];
  /** The file's own total for the money column, for the reconciliation report. */
  sourceTotalCents: Cents;
  missingRequired: string[];
  raggedRows: { line: number; columns: number }[];
  dateOrderAmbiguous: boolean;
  canProceed: boolean;
}

/** Build every row and collect the problems, without touching the database. */
export function validateImport(
  entity: ImportEntity,
  parsed: ParsedFile,
  mapping: MappingProposal,
): ValidationReport {
  const ctx: RowContext = {
    fieldMap: mapping.fieldMap,
    dateOrder: mapping.dateOrder,
    decimalSeparator: mapping.decimalSeparator,
  };

  const build = ROW_BUILDERS[entity];
  const reconciler = RECONCILING_FIELD[entity];

  const issues: RowIssue[] = [];
  let validRows = 0;
  let errorRows = 0;
  let warningRows = 0;
  let sourceTotal = ZERO;

  for (const [index, values] of parsed.rows.entries()) {
    // Counted from the top of the file, past any title block, so the number matches what
    // the office manager sees when they open it to fix a row.
    const built = build(values, parsed.headerOffset + index + 2, ctx);
    issues.push(...built.issues);

    if (built.record) {
      validRows++;
      if (reconciler) sourceTotal += reconciler(built.record);
      if (built.issues.some((i) => i.severity === 'WARNING')) warningRows++;
    } else {
      errorRows++;
    }
  }

  for (const ragged of parsed.raggedRows) {
    issues.push({
      line: ragged.line,
      severity: 'WARNING',
      message: `has ${ragged.columns} columns where the header has a different number — padded`,
    });
  }

  return {
    entity,
    entityLabel: ENTITY_LABELS[entity],
    totalRows: parsed.totalRows,
    validRows,
    errorRows,
    warningRows,
    issues,
    sourceTotalCents: sourceTotal,
    missingRequired: mapping.missingRequired,
    raggedRows: parsed.raggedRows,
    dateOrderAmbiguous: mapping.dateOrderAmbiguous,
    canProceed: mapping.missingRequired.length === 0 && validRows > 0,
  };
}

export interface ImportInput {
  entity: ImportEntity;
  parsed: ParsedFile;
  mapping: MappingProposal;
  fileName?: string;
  sourceSystem?: string;
  /** The date opening balances are posted as. Defaults to today. */
  cutoverDate?: Date;
  /** The source system's own total, for the reconciliation report. */
  declaredTotalCents?: Cents;
}

export interface Reconciliation {
  sourceTotalCents: Cents;
  /** Of the file's total, what this import was right not to write. Not a discrepancy. */
  excludedTotalCents: Cents;
  importedTotalCents: Cents;
  declaredTotalCents: Cents | null;
  matches: boolean;
  openingBalanceEquityCents: Cents;
  isBalanced: boolean;
  lines: string[];
}

export interface ImportResult {
  batchId: string | null;
  entity: ImportEntity;
  dryRun: boolean;
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  errorRows: number;
  issues: RowIssue[];
  notes: string[];
  reconciliation: Reconciliation;
}

/** Thrown to unwind a dry run; never escapes `runImport`. */
class DryRunComplete extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run complete');
  }
}

export async function runImport(
  db: PrismaClient,
  ctx: AuthContext,
  input: ImportInput,
  options: { dryRun?: boolean } = {},
): Promise<ImportResult> {
  requirePermission(ctx, PERMISSIONS.IMPORT_RUN);

  const dryRun = options.dryRun ?? false;
  const validation = validateImport(input.entity, input.parsed, input.mapping);

  if (validation.missingRequired.length > 0) {
    throw new ValidationError(
      `Cannot import ${ENTITY_LABELS[input.entity]}: no column is mapped to ${validation.missingRequired.join(', ')}`,
    );
  }

  await assertPrerequisites(db, ctx, input.entity);

  const cutoverDate = input.cutoverDate ?? new Date();
  const rowCtx: RowContext = {
    fieldMap: input.mapping.fieldMap,
    dateOrder: input.mapping.dateOrder,
    decimalSeparator: input.mapping.decimalSeparator,
  };

  const build = ROW_BUILDERS[input.entity];
  const good: { line: number; record: AnyRow }[] = [];
  for (const [index, values] of input.parsed.rows.entries()) {
    const built = build(values, input.parsed.headerOffset + index + 2, rowCtx);
    if (built.record) good.push({ line: built.line, record: built.record });
  }

  const batch = await db.importBatch.create({
    data: {
      organizationId: ctx.organizationId,
      name: input.fileName ?? `${input.entity} import`,
      sourceSystem: input.sourceSystem ?? 'GENERIC_CSV',
      entityType: input.entity,
      status: dryRun ? 'DRY_RUN' : 'COMMITTING',
      fileName: input.fileName ?? null,
      totalRows: validation.totalRows,
      errorRows: validation.errorRows,
      sourceTotalCents: validation.sourceTotalCents,
      startedAt: new Date(),
      createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
    },
  });

  try {
    const result = await db.$transaction(
      async (tx) => {
        const write = await dispatchWrite(db, tx, ctx, input.entity, good, batch.id, cutoverDate);

        const obe = await openingBalanceEquity(tx, ctx.organizationId);
        const importedTotal =
          write.importedTotalCents > ZERO ? write.importedTotalCents : validation.sourceTotalCents;

        const reconciliation = buildReconciliation({
          entity: input.entity,
          sourceTotalCents: validation.sourceTotalCents,
          excludedTotalCents: write.deliberatelyExcludedCents,
          importedTotalCents: importedTotal,
          declaredTotalCents: input.declaredTotalCents ?? null,
          openingBalanceEquityCents: obe,
          imported: write.imported,
          updated: write.updated,
          skipped: write.skipped,
          totalRows: validation.totalRows,
          errorRows: validation.errorRows,
        });

        const outcome: ImportResult = {
          batchId: batch.id,
          entity: input.entity,
          dryRun,
          totalRows: validation.totalRows,
          imported: write.imported,
          updated: write.updated,
          skipped: write.skipped,
          errorRows: validation.errorRows,
          issues: [...validation.issues, ...write.issues],
          notes: write.notes,
          reconciliation,
        };

        // Everything above really happened; this unwinds it so the customer sees true
        // numbers without anything being written.
        if (dryRun) throw new DryRunComplete(outcome);
        return outcome;
      },
      { timeout: 120_000 },
    );

    await db.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'COMPLETED',
        importedRows: result.imported + result.updated,
        skippedRows: result.skipped,
        errorRows: result.errorRows,
        importedTotalCents: result.reconciliation.importedTotalCents,
        isBalanced: result.reconciliation.isBalanced,
        errorReport: result.issues.slice(0, 500) as unknown as object,
        completedAt: new Date(),
      },
    });

    return result;
  } catch (error) {
    if (error instanceof DryRunComplete) {
      // The batch row itself is written outside the transaction, so the dry run leaves a
      // record of having been done — which is the audit trail for "we tested it first".
      await db.importBatch.update({
        where: { id: batch.id },
        data: {
          status: 'DRY_RUN',
          importedRows: error.result.imported + error.result.updated,
          skippedRows: error.result.skipped,
          errorRows: error.result.errorRows,
          importedTotalCents: error.result.reconciliation.importedTotalCents,
          isBalanced: error.result.reconciliation.isBalanced,
          errorReport: error.result.issues.slice(0, 500) as unknown as object,
          completedAt: new Date(),
        },
      });
      return { ...error.result, batchId: dryRun ? batch.id : error.result.batchId };
    }

    await db.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'FAILED',
        errorReport: [{ message: (error as Error).message }] as unknown as object,
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

async function dispatchWrite(
  db: PrismaClient,
  tx: Tx,
  ctx: AuthContext,
  entity: ImportEntity,
  rows: { line: number; record: AnyRow }[],
  batchId: string,
  cutoverDate: Date,
) {
  switch (entity) {
    case 'CUSTOMER':
      return writeCustomers(tx, ctx, rows as never, batchId);
    case 'PRICE_BOOK_ITEM':
      return writePriceBookItems(tx, ctx, rows as never, batchId);
    case 'CHART_OF_ACCOUNTS':
      return writeAccounts(tx, ctx, rows as never, batchId);
    case 'OPEN_INVOICE':
      return writeOpenInvoices(db, tx, ctx, rows as never, batchId, cutoverDate);
    case 'TRIAL_BALANCE':
      return writeTrialBalance(db, tx, ctx, rows as never, batchId, cutoverDate);
  }
}

/**
 * Refuse to run an import whose prerequisites are missing.
 *
 * Loading invoices before customers produces several hundred rows of "customer not found"
 * and a wasted afternoon. The order is stated once, in `IMPORT_ORDER`, and enforced here.
 */
async function assertPrerequisites(
  db: PrismaClient,
  ctx: AuthContext,
  entity: ImportEntity,
): Promise<void> {
  // Only invoices need a customer to belong to; a trial balance does not.
  if (entity === 'OPEN_INVOICE') {
    const customers = await db.customer.count({ where: { organizationId: ctx.organizationId } });
    if (customers === 0) {
      throw new ValidationError(
        'Import customers before open invoices — an invoice needs someone to belong to',
      );
    }
  }

  if (entity === 'TRIAL_BALANCE' || entity === 'OPEN_INVOICE') {
    const accounts = await db.account.count({ where: { organizationId: ctx.organizationId } });
    if (accounts === 0) {
      throw new ValidationError('Set up or import the chart of accounts before posting balances');
    }
  }
}

async function openingBalanceEquity(tx: Tx, organizationId: string): Promise<Cents> {
  const account = await tx.account.findFirst({
    where: { organizationId, code: ACCOUNTS.OPENING_BALANCE_EQUITY },
    select: { id: true },
  });
  if (!account) return ZERO;

  const totals = await tx.journalLine.aggregate({
    where: { accountId: account.id, journalEntry: { postedAt: { not: null } } },
    _sum: { debitCents: true, creditCents: true },
  });

  // Equity is credit-normal, so a positive figure means equity was raised and not cleared.
  return (totals._sum.creditCents ?? ZERO) - (totals._sum.debitCents ?? ZERO);
}

function buildReconciliation(input: {
  entity: ImportEntity;
  sourceTotalCents: Cents;
  /** What the file carried that this import was right not to write. Not a discrepancy. */
  excludedTotalCents: Cents;
  importedTotalCents: Cents;
  declaredTotalCents: Cents | null;
  openingBalanceEquityCents: Cents;
  imported: number;
  updated: number;
  skipped: number;
  totalRows: number;
  errorRows: number;
}): Reconciliation {
  // A trial balance line whose subledger already came across is not money that went
  // missing — counting it as one had the reconciliation announcing a correct import as
  // "out by" the receivables it had just been careful not to double count.
  const comparable = input.sourceTotalCents - input.excludedTotalCents;

  const balanced = input.openingBalanceEquityCents === ZERO;

  /*
   * A trial balance has no source-against-imported comparison to make. Its file total is
   * both sides of every line added together and what posts is one side, so the two were
   * never going to agree, and saying "out by" some six-figure number about a correct
   * import is worse than saying nothing. What a trial balance has instead is the figure
   * the whole migration hangs on: Opening Balance Equity, which clears to zero when the
   * books came over whole and does not when they did not.
   */
  const matches =
    input.entity === 'TRIAL_BALANCE'
      ? balanced
      : comparable === input.importedTotalCents &&
        (input.declaredTotalCents === null ||
          input.declaredTotalCents === input.importedTotalCents);

  const lines: string[] = [
    `Rows in file        ${String(input.totalRows).padStart(6)}   ` +
      `imported ${String(input.imported).padStart(5)}   ` +
      `updated ${String(input.updated).padStart(5)}   ` +
      `skipped ${String(input.skipped).padStart(5)}   ` +
      `errors ${String(input.errorRows).padStart(4)}`,
  ];

  if (input.entity === 'TRIAL_BALANCE') {
    lines.push(`Opening balances posted ${formatMoney(input.importedTotalCents).padStart(11)}`);
    if (input.excludedTotalCents > ZERO) {
      lines.push(
        `Left to its subledger   ${formatMoney(input.excludedTotalCents).padStart(11)}   ` +
          'already carried over, not posted twice',
      );
    }
  } else if (input.sourceTotalCents > ZERO || input.importedTotalCents > ZERO) {
    lines.push(`File total          ${formatMoney(input.sourceTotalCents).padStart(16)}`);
    if (input.excludedTotalCents > ZERO) {
      lines.push(
        `Already carried over ${formatMoney(input.excludedTotalCents).padStart(15)}   ` +
          'posted by its own subledger, not counted again',
      );
      lines.push(`Left to import      ${formatMoney(comparable).padStart(16)}`);
    }
    lines.push(`Imported total      ${formatMoney(input.importedTotalCents).padStart(16)}`);
    if (input.declaredTotalCents !== null) {
      lines.push(
        `Source system total ${formatMoney(input.declaredTotalCents).padStart(16)}   ` +
          (input.declaredTotalCents === input.importedTotalCents ? 'MATCH' : 'DOES NOT MATCH'),
      );
    }
  }

  // The figure the whole migration hangs on. Anything but zero after the trial balance is
  // loaded means the books came over wrong.
  lines.push(
    `Opening Balance Equity ${formatMoney(input.openingBalanceEquityCents).padStart(13)}   ` +
      (balanced
        ? 'BALANCED'
        : input.entity === 'TRIAL_BALANCE'
          ? 'NOT CLEARED — the migration is out of balance'
          : 'expected until the trial balance is loaded'),
  );

  return {
    sourceTotalCents: input.sourceTotalCents,
    excludedTotalCents: input.excludedTotalCents,
    importedTotalCents: input.importedTotalCents,
    declaredTotalCents: input.declaredTotalCents,
    matches,
    openingBalanceEquityCents: input.openingBalanceEquityCents,
    isBalanced: input.entity === 'TRIAL_BALANCE' ? balanced : true,
    lines,
  };
}

export function formatReconciliation(result: ImportResult): string {
  const header = `${ENTITY_LABELS[result.entity]}${result.dryRun ? ' (dry run — nothing was written)' : ''}`;
  return [header, ...result.reconciliation.lines].join('\n');
}

/**
 * Reverse an entire batch.
 *
 * Every record created by an import carries its batch id, and any journal entry it posted
 * is reversed rather than deleted — a posted entry is never removed from the ledger, even
 * one that should not have been made. Available until the customer starts trading on the
 * new system; after that, unwinding an import is a bookkeeping decision, not a button.
 */
export async function rollbackImport(
  db: PrismaClient,
  ctx: AuthContext,
  batchId: string,
): Promise<{ reversedEntries: number; deletedRecords: number }> {
  requirePermission(ctx, PERMISSIONS.IMPORT_RUN);

  const batch = await db.importBatch.findFirst({
    where: { id: batchId, organizationId: ctx.organizationId },
  });
  if (!batch) throw new NotFoundError('Import batch', batchId);
  if (batch.status === 'ROLLED_BACK') {
    throw new ValidationError('That batch has already been rolled back');
  }
  if (batch.status === 'DRY_RUN') {
    throw new ValidationError('A dry run wrote nothing, so there is nothing to roll back');
  }

  const { reverseJournalEntry } = await import('../accounting/ledger');

  const entries = await db.journalEntry.findMany({
    where: { organizationId: ctx.organizationId, importBatchId: batchId, isReversal: false },
    select: { id: true },
  });

  let reversedEntries = 0;
  for (const entry of entries) {
    const already = await db.journalEntry.findFirst({
      where: { reversesEntryId: entry.id },
      select: { id: true },
    });
    if (already) continue;
    await reverseJournalEntry(db, ctx, entry.id, { memo: `Rollback of import ${batch.name}` });
    reversedEntries++;
  }

  const deleted = await db.$transaction(async (tx) => {
    let count = 0;

    // Invoices first: a customer with invoices against it cannot be removed.
    const invoices = await tx.invoice.findMany({
      where: { organizationId: ctx.organizationId, importBatchId: batchId },
      select: { id: true },
    });
    if (invoices.length > 0) {
      await tx.invoiceLine.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
      await tx.invoiceTaxLine.deleteMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } } });
      const removed = await tx.invoice.deleteMany({ where: { id: { in: invoices.map((i) => i.id) } } });
      count += removed.count;
    }

    const customers = await tx.customer.findMany({
      where: { organizationId: ctx.organizationId, importBatchId: batchId },
      select: { id: true },
    });
    if (customers.length > 0) {
      const ids = customers.map((c) => c.id);
      // A customer that has since been given a job is no longer the import's to remove.
      const withJobs = await tx.job.findMany({
        where: { customerId: { in: ids } },
        select: { customerId: true },
        distinct: ['customerId'],
      });
      const busy = new Set(withJobs.map((j) => j.customerId));
      const removable = ids.filter((id) => !busy.has(id));

      await tx.property.deleteMany({ where: { customerId: { in: removable } } });
      await tx.contact.deleteMany({ where: { customerId: { in: removable } } });
      const removed = await tx.customer.deleteMany({ where: { id: { in: removable } } });
      count += removed.count;
    }

    const items = await tx.priceBookItem.deleteMany({
      where: {
        organizationId: ctx.organizationId,
        importBatchId: batchId,
        // Anything already quoted or worked stays; removing it would orphan the document.
        quoteLines: { none: {} },
        jobLines: { none: {} },
        invoiceLines: { none: {} },
      },
    });
    count += items.count;

    const accounts = await tx.account.deleteMany({
      where: {
        organizationId: ctx.organizationId,
        importBatchId: batchId,
        isSystem: false,
        journalLines: { none: {} },
      },
    });
    count += accounts.count;

    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'ROLLED_BACK', rolledBackAt: new Date() },
    });

    return count;
  });

  return { reversedEntries, deletedRecords: deleted };
}

export { IMPORT_ORDER, ENTITY_LABELS };
export type { ImportEntity, MappingProposal, ParsedFile };
export { sum };
