import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { balanceSheet, trialBalance } from '../src/lib/accounting/reports';
import { analyzeFile, rollbackImport, runImport, validateImport } from '../src/lib/import/runner';
import { applyOverrides } from '../src/lib/import/mapping';
import { MAX_UPLOAD_BYTES, prepareImport, readWizardRequest } from '../src/server/import';
import { createTestOrg, utc, type TestOrg } from './factory';
import { ZERO } from '../src/lib/money';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The migration is what decides whether a customer signs, so it is tested the way it will
 * be used: a messy export from a real accounting package, mapped automatically, dry-run,
 * committed, reconciled, and — when the trial run was only a trial — reversed.
 */

const CUTOVER = utc(2026, 1, 1);

// A QuickBooks customer export: a title block on top, "Surname, Forename" in the first
// column, two rows for the same household, and an address containing commas.
const CUSTOMER_CSV = [
  'Apex Handyman Services',
  'Customer Contact List',
  'As of 31 December 2025',
  '',
  'Customer,Company Name,First Name,Last Name,Main Email,Main Phone,Bill Addr Line1,Bill Addr City,Bill Addr State,Bill Addr Postal Code,Terms',
  '"Alvarez, Dana",,Dana,Alvarez,dana.alvarez@example.com,(480) 555-0142,"1420 E Broadway Rd, Apt 2",Mesa,AZ,85204,0',
  '"Nakamura, Yui",,Yui,Nakamura,yui.nakamura@example.com,480.555.0188,88 W Main St,Mesa,AZ,85201,0',
  'Saguaro Ridge Property Group,Saguaro Ridge Property Group,Marcus,Bell,ap@saguaroridge.example.com,+1 (602) 555-0110,2140 W Buckeye Rd,Phoenix,AZ,85009,30',
  '"Alvarez, Dana",,Dana,Alvarez,dana.alvarez@example.com,(480) 555-0142,"1420 E Broadway Rd, Apt 2",Mesa,AZ,85204,0',
  '"Okafor, Chidi",,Chidi,Okafor,not-an-email,(623) 555-0170,9 Low Rd,Phoenix,AZ,85012,0',
  ',,,,nobody@example.com,,,,,,',
].join('\n');

const AR_AGING_CSV = [
  'Apex Handyman Services',
  'A/R Aging Detail',
  'As of 31 December 2025',
  '',
  'Num,Customer,Date,Due Date,Amount,Open Balance,P.O. #',
  '1041,"Alvarez, Dana",11/18/2025,12/18/2025,"1,284.50","1,284.50",',
  '1052,"Nakamura, Yui",12/02/2025,12/02/2025,"642.00","642.00",',
  '1063,Saguaro Ridge Property Group,12/14/2025,01/13/2026,"4,180.75","2,180.75",PO-8841',
  '1070,"Okafor, Chidi",12/28/2025,12/28/2025,"310.00","310.00",',
  '1071,Ghost Customer Ltd,12/29/2025,01/28/2026,"500.00","500.00",',
].join('\n');

/** The same report after the office manager fixes the row the reconciliation flagged. */
const AR_AGING_FIXED_CSV = AR_AGING_CSV.replace('Ghost Customer Ltd', '"Nakamura, Yui"');

/**
 * A real trial balance includes receivables. The importer skips that line, because the
 * invoices themselves have already carried it over — and the amount it leaves out is
 * exactly the opening equity those invoices raised, so the plug clears it to zero.
 */
const TRIAL_BALANCE_CSV = [
  'Apex Handyman Services',
  'Trial Balance',
  'As of 31 December 2025',
  '',
  'Account Number,Account,Debit,Credit',
  '1010,Operating Bank Account,"52,400.00",',
  '1200,Accounts Receivable,"4,917.25",',
  '1300,Inventory — Warehouse,"18,250.00",',
  '1500,Vehicles & Equipment,"96,000.00",',
  '1590,Accumulated Depreciation,,"31,200.00"',
  '2010,Accounts Payable,,"14,880.00"',
  '2100,Sales Tax Payable,,"3,912.00"',
  '3010,Owner’s Equity,,"121,575.25"',
].join('\n');

let org: TestOrg;
let ctx: AuthContext;

beforeEach(async () => {
  org = await createTestOrg('Import');
  ctx = systemContext(org.organizationId);
});

afterAll(async () => {
  await db.$disconnect();
});

async function importCustomers(options: { dryRun?: boolean } = {}) {
  const analyzed = analyzeFile(CUSTOMER_CSV, 'CUSTOMER');
  return runImport(
    db,
    ctx,
    {
      entity: 'CUSTOMER',
      parsed: analyzed.parsed,
      mapping: analyzed.mapping,
      fileName: 'customers.csv',
      sourceSystem: 'QUICKBOOKS',
      cutoverDate: CUTOVER,
    },
    options,
  );
}

describe('analysing a real export', () => {
  it('finds the header under the title block and maps the columns', () => {
    const analyzed = analyzeFile(CUSTOMER_CSV, 'CUSTOMER');

    expect(analyzed.headerRow).toBe(4);
    expect(analyzed.parsed.header[0]).toBe('Customer');
    expect(analyzed.mapping.fieldMap.email).toBeDefined();
    expect(analyzed.mapping.fieldMap.billingPostal).toBeDefined();
    // The address contains commas inside quotes and must survive intact.
    expect(analyzed.parsed.rows[0][6]).toBe('1420 E Broadway Rd, Apt 2');
  });

  it('flags the rows an office manager needs to fix, and passes the rest', () => {
    const analyzed = analyzeFile(CUSTOMER_CSV, 'CUSTOMER');
    const report = validateImport('CUSTOMER', analyzed.parsed, analyzed.mapping);

    expect(report.totalRows).toBe(6);
    expect(report.canProceed).toBe(true);

    // The row with no name at all cannot become a customer.
    const nameless = report.issues.find((i) => i.line === 11 && i.severity === 'ERROR');
    expect(nameless?.message).toMatch(/company name or a last name/);
    expect(report.errorRows).toBe(1);

    // A malformed email costs the address, not the customer.
    const badEmail = report.issues.find((i) => i.field === 'email' && i.severity === 'WARNING');
    expect(badEmail?.message).toMatch(/imported without it/);
  });

  it('reads the aging report with its dates, amounts and open balances', () => {
    const analyzed = analyzeFile(AR_AGING_CSV, 'OPEN_INVOICE');
    const report = validateImport('OPEN_INVOICE', analyzed.parsed, analyzed.mapping);

    expect(analyzed.mapping.dateOrder).toBe('MDY');
    expect(report.errorRows).toBe(0);
    // 1,284.50 + 642.00 + 2,180.75 + 310.00 + 500.00
    expect(report.sourceTotalCents).toBe(491_725n);
  });
});

describe('dry run', () => {
  it('reports real numbers and writes nothing', async () => {
    const before = await db.customer.count({ where: { organizationId: org.organizationId } });

    const result = await importCustomers({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1); // the repeated household
    expect(result.errorRows).toBe(1); // the nameless row

    const after = await db.customer.count({ where: { organizationId: org.organizationId } });
    expect(after).toBe(before);
  });

  it('leaves a record that the dry run happened', async () => {
    const result = await importCustomers({ dryRun: true });
    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: result.batchId! } });

    expect(batch.status).toBe('DRY_RUN');
    expect(batch.totalRows).toBe(6);
    expect(batch.fileName).toBe('customers.csv');
  });

  it('rolls back a posting as well as the records', async () => {
    await importCustomers();
    const aging = analyzeFile(AR_AGING_CSV, 'OPEN_INVOICE');

    const dry = await runImport(
      db,
      ctx,
      {
        entity: 'OPEN_INVOICE',
        parsed: aging.parsed,
        mapping: aging.mapping,
        cutoverDate: CUTOVER,
      },
      { dryRun: true },
    );

    expect(dry.imported).toBe(4);

    // Nothing reached the ledger.
    const tb = await trialBalance(db, ctx, {});
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)).toBeUndefined();
    expect(await db.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0);
  });
});

describe('committing an import', () => {
  it('creates customers with their service address and skips duplicates', async () => {
    const result = await importCustomers();

    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1);

    const customers = await db.customer.findMany({
      where: { organizationId: org.organizationId },
      include: { properties: true },
      orderBy: { customerNo: 'asc' },
    });

    expect(customers).toHaveLength(4);
    expect(customers[0].customerNo).toMatch(/^C-\d{5}$/);
    expect(customers[0].properties[0].addressLine1).toBe('1420 E Broadway Rd, Apt 2');
    // Phone is stored both as written and normalised, so a re-import matches it.
    expect(customers[0].phoneNormalized).toBe('4805550142');

    const commercial = customers.find((c) => c.companyName?.includes('Saguaro'))!;
    expect(commercial.type).toBe('COMMERCIAL');
    expect(commercial.paymentTermsDays).toBe(30);
    expect(commercial.phoneNormalized).toBe('6025550110');
  });

  it('updates rather than duplicates when the same file is imported twice', async () => {
    await importCustomers();
    const second = await importCustomers();

    expect(second.imported).toBe(0);
    expect(second.updated).toBe(4);
    expect(second.skipped).toBe(1); // the row repeated inside the file
    expect(await db.customer.count({ where: { organizationId: org.organizationId } })).toBe(4);
  });

  it('refuses to import invoices before there are customers to attach them to', async () => {
    const aging = analyzeFile(AR_AGING_CSV, 'OPEN_INVOICE');

    await expect(
      runImport(db, ctx, {
        entity: 'OPEN_INVOICE',
        parsed: aging.parsed,
        mapping: aging.mapping,
        cutoverDate: CUTOVER,
      }),
    ).rejects.toThrow(/Import customers before/);
  });

  it('refuses a mapping that leaves a required field unmapped', async () => {
    const analyzed = analyzeFile(CUSTOMER_CSV, 'PRICE_BOOK_ITEM');
    const stripped = applyOverrides(analyzed.mapping, { sku: null, name: null });

    await expect(
      runImport(db, ctx, {
        entity: 'PRICE_BOOK_ITEM',
        parsed: analyzed.parsed,
        mapping: stripped,
      }),
    ).rejects.toThrow(/no column is mapped to/);
  });
});

describe('opening balances', () => {
  it('posts receivables against opening equity and names the customer it cannot find', async () => {
    await importCustomers();
    const aging = analyzeFile(AR_AGING_CSV, 'OPEN_INVOICE');

    const result = await runImport(db, ctx, {
      entity: 'OPEN_INVOICE',
      parsed: aging.parsed,
      mapping: aging.mapping,
      cutoverDate: CUTOVER,
      // What the source system says its receivables are, including the unmatched row.
      declaredTotalCents: 491_725n,
    });

    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(1);

    const missing = result.issues.find((i) => i.field === 'customerRef');
    expect(missing?.value).toBe('Ghost Customer Ltd');
    expect(missing?.severity).toBe('ERROR');

    // 1,284.50 + 642.00 + 2,180.75 + 310.00 — the fifth row had nobody to belong to.
    expect(result.reconciliation.importedTotalCents).toBe(441_725n);
    // The reconciliation is what surfaces that gap, rather than leaving it to be found at
    // the first month end.
    expect(result.reconciliation.matches).toBe(false);

    const tb = await trialBalance(db, ctx, {});
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(441_725n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.OPENING_BALANCE_EQUITY)!.balanceCents).toBe(441_725n);
    expect(tb.isBalanced).toBe(true);

    // The partly-paid invoice keeps its history.
    const partial = await db.invoice.findFirstOrThrow({ where: { invoiceNo: '1063' } });
    expect(partial.totalCents).toBe(418_075n);
    expect(partial.paidCents).toBe(200_000n);
    expect(partial.balanceCents).toBe(218_075n);
    expect(partial.status).toBe('PARTIALLY_PAID');
    expect(partial.poNumber).toBe('PO-8841');
  });

  it('clears opening balance equity to zero once the trial balance is loaded', async () => {
    await importCustomers();

    const aging = analyzeFile(AR_AGING_FIXED_CSV, 'OPEN_INVOICE');
    await runImport(db, ctx, {
      entity: 'OPEN_INVOICE',
      parsed: aging.parsed,
      mapping: aging.mapping,
      cutoverDate: CUTOVER,
    });

    const tb = analyzeFile(TRIAL_BALANCE_CSV, 'TRIAL_BALANCE');
    const result = await runImport(db, ctx, {
      entity: 'TRIAL_BALANCE',
      parsed: tb.parsed,
      mapping: tb.mapping,
      cutoverDate: CUTOVER,
    });

    // This is the number the whole migration hangs on.
    expect(result.reconciliation.openingBalanceEquityCents).toBe(0n);
    expect(result.reconciliation.isBalanced).toBe(true);

    const balances = await trialBalance(db, ctx, {});
    expect(balances.isBalanced).toBe(true);
    expect(balances.rows.find((r) => r.code === ACCOUNTS.OPENING_BALANCE_EQUITY)!.balanceCents).toBe(0n);
    expect(balances.rows.find((r) => r.code === ACCOUNTS.BANK_OPERATING)!.balanceCents).toBe(5_240_000n);
    expect(balances.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(491_725n);

    const sheet = await balanceSheet(db, ctx, CUTOVER);
    expect(sheet.isBalanced).toBe(true);
  });

  it('does not post receivables twice when the trial balance also lists them', async () => {
    await importCustomers();

    const aging = analyzeFile(AR_AGING_FIXED_CSV, 'OPEN_INVOICE');
    await runImport(db, ctx, {
      entity: 'OPEN_INVOICE',
      parsed: aging.parsed,
      mapping: aging.mapping,
      cutoverDate: CUTOVER,
    });

    const tb = analyzeFile(TRIAL_BALANCE_CSV, 'TRIAL_BALANCE');
    const result = await runImport(db, ctx, {
      entity: 'TRIAL_BALANCE',
      parsed: tb.parsed,
      mapping: tb.mapping,
      cutoverDate: CUTOVER,
    });

    const skipped = result.issues.find((i) => i.value === ACCOUNTS.AR);
    expect(skipped?.message).toMatch(/subledger/);

    // Still the aging total, not double it.
    const balances = await trialBalance(db, ctx, {});
    expect(balances.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(491_725n);
  });

  it('takes payables from the trial balance when no bills were imported for them', async () => {
    await importCustomers();

    const aging = analyzeFile(AR_AGING_FIXED_CSV, 'OPEN_INVOICE');
    await runImport(db, ctx, {
      entity: 'OPEN_INVOICE',
      parsed: aging.parsed,
      mapping: aging.mapping,
      cutoverDate: CUTOVER,
    });

    const tb = analyzeFile(TRIAL_BALANCE_CSV, 'TRIAL_BALANCE');
    const result = await runImport(db, ctx, {
      entity: 'TRIAL_BALANCE',
      parsed: tb.parsed,
      mapping: tb.mapping,
      cutoverDate: CUTOVER,
    });

    const balances = await trialBalance(db, ctx, {});

    // Receivables were loaded as invoices, so the trial balance line is skipped.
    expect(result.issues.some((i) => i.value === ACCOUNTS.AR)).toBe(true);
    // Payables were not, so the trial balance is the only place that balance comes from.
    // Skipping it on the assumption a subledger covered it would bury $14,880 in equity.
    expect(result.issues.some((i) => i.value === ACCOUNTS.AP)).toBe(false);
    expect(balances.rows.find((r) => r.code === ACCOUNTS.AP)!.balanceCents).toBe(1_488_000n);
    expect(balances.rows.find((r) => r.code === ACCOUNTS.OPENING_BALANCE_EQUITY)!.balanceCents).toBe(0n);
  });

  it('reports an account that does not exist instead of inventing one', async () => {
    const tb = analyzeFile(
      'Account Number,Account,Debit,Credit\n9999,Invented Account,"100.00",\n1010,Operating Bank Account,,"100.00"',
      'TRIAL_BALANCE',
    );

    const result = await runImport(db, ctx, {
      entity: 'TRIAL_BALANCE',
      parsed: tb.parsed,
      mapping: tb.mapping,
      cutoverDate: CUTOVER,
    });

    const unknown = result.issues.find((i) => i.value === '9999');
    expect(unknown?.severity).toBe('ERROR');
    expect(unknown?.message).toMatch(/import the chart of accounts first/);
    expect(result.imported).toBe(1);
  });
});

describe('rollback', () => {
  it('reverses the postings and removes the records', async () => {
    await importCustomers();
    const aging = analyzeFile(AR_AGING_CSV, 'OPEN_INVOICE');
    const imported = await runImport(db, ctx, {
      entity: 'OPEN_INVOICE',
      parsed: aging.parsed,
      mapping: aging.mapping,
      cutoverDate: CUTOVER,
    });

    const result = await rollbackImport(db, ctx, imported.batchId!);

    expect(result.reversedEntries).toBe(1);
    expect(result.deletedRecords).toBe(4);
    expect(await db.invoice.count({ where: { organizationId: org.organizationId } })).toBe(0);

    // The original posting is still in the ledger with its reversal beside it: a posted
    // entry is never removed, even one that should not have been made.
    const entries = await db.journalEntry.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { entryNo: 'asc' },
    });
    expect(entries).toHaveLength(2);
    expect(entries[1].isReversal).toBe(true);

    const tb = await trialBalance(db, ctx, {});
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(0n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.OPENING_BALANCE_EQUITY)!.balanceCents).toBe(0n);
  });

  it('will not roll back the same batch twice', async () => {
    const imported = await importCustomers();
    await rollbackImport(db, ctx, imported.batchId!);

    await expect(rollbackImport(db, ctx, imported.batchId!)).rejects.toThrow(/already been rolled back/);
  });

  it('will not roll back a dry run, which wrote nothing', async () => {
    const dry = await importCustomers({ dryRun: true });
    await expect(rollbackImport(db, ctx, dry.batchId!)).rejects.toThrow(/wrote nothing/);
  });

  it('keeps a customer that has since been given work', async () => {
    const imported = await importCustomers();

    const customer = await db.customer.findFirstOrThrow({
      where: { organizationId: org.organizationId },
      include: { properties: true },
    });
    await db.job.create({
      data: {
        organizationId: org.organizationId,
        locationId: org.locationId,
        jobNo: 'J-KEEP-1',
        customerId: customer.id,
        propertyId: customer.properties[0].id,
        title: 'Work booked after the import',
      },
    });

    const result = await rollbackImport(db, ctx, imported.batchId!);

    expect(result.deletedRecords).toBe(3);
    expect(await db.customer.findUnique({ where: { id: customer.id } })).not.toBeNull();
  });
});

/**
 * The wizard's own layer.
 *
 * The screen keeps the uploaded file in the browser and sends it with every step, so this
 * is where a request from a browser becomes the two arguments the engine takes — and where
 * a correction the operator made on one screen has to survive into the next one.
 */
describe('the wizard request', () => {
  it('refuses a file it was not told what to do with', () => {
    expect(() => readWizardRequest({ text: CUSTOMER_CSV })).toThrow(/what this file holds/i);
    expect(() => readWizardRequest({ entity: 'PAYROLL', text: CUSTOMER_CSV })).toThrow(
      /what this file holds/i,
    );
  });

  it('refuses an empty file and one too large to be a handyman company', () => {
    expect(() => readWizardRequest({ entity: 'CUSTOMER', text: '   ' })).toThrow(/empty/i);
    expect(() =>
      readWizardRequest({ entity: 'CUSTOMER', text: 'x'.repeat(MAX_UPLOAD_BYTES + 1) }),
    ).toThrow(/larger than/i);
  });

  it('ignores an override that is not a column index', () => {
    const request = readWizardRequest({
      entity: 'CUSTOMER',
      text: CUSTOMER_CSV,
      overrides: { email: 'the fourth one' },
    });

    expect(request.overrides).toBeUndefined();
  });

  it('detects the header row, and lets an operator overrule the detection', () => {
    const detected = prepareImport(readWizardRequest({ entity: 'CUSTOMER', text: CUSTOMER_CSV }));
    expect(detected.headerRow).toBe(4); // past the title block
    expect(detected.parsed.header[0]).toBe('Customer');

    // Told the headings are on the first line, it believes them — and finds a file with
    // one column called "Apex Handyman Services", which is what the operator will see and
    // is how they discover they were wrong.
    const forced = prepareImport(
      readWizardRequest({ entity: 'CUSTOMER', text: CUSTOMER_CSV, headerRow: 0 }),
    );
    expect(forced.headerRow).toBe(0);
    expect(forced.parsed.header[0]).toBe('Apex Handyman Services');
  });

  it('carries a hand-made mapping through', () => {
    const request = readWizardRequest({
      entity: 'CUSTOMER',
      text: CUSTOMER_CSV,
      // "Main Phone" is column 5; claim it for notes instead, as a correction would.
      overrides: { notes: 5, phone: null },
    });
    const { mapping } = prepareImport(request);

    expect(mapping.fieldMap.notes).toBe(5);
    expect(mapping.fieldMap.phone).toBeUndefined();
  });

  it('lets an operator settle a date order the file cannot prove', () => {
    // Every day is under the thirteenth, so nothing in the file says which way round it is.
    const ambiguous = [
      'Num,Customer,Date,Amount',
      '1,"Alvarez, Dana",01/02/2026,"100.00"',
      '2,"Alvarez, Dana",03/04/2026,"200.00"',
    ].join('\n');

    const guessed = prepareImport(readWizardRequest({ entity: 'OPEN_INVOICE', text: ambiguous }));
    expect(guessed.mapping.dateOrderAmbiguous).toBe(true);

    const settled = prepareImport(
      readWizardRequest({ entity: 'OPEN_INVOICE', text: ambiguous, dateOrder: 'DMY' }),
    );
    expect(settled.mapping.dateOrder).toBe('DMY');
    expect(settled.mapping.dateOrderAmbiguous).toBe(false);
  });
});

/**
 * The sample exports the wizard offers, run the way a demo runs them.
 *
 * These files are what Act 1 is performed on, so a change to the generator that broke one
 * of them would not be found until somebody was standing in front of a customer. The
 * reconciliation catching the row that does not belong is the point of the act, so the
 * test asserts it catches it — and that the corrected file then ties exactly.
 */
describe('the sample exports', () => {
  const sample = (name: string) =>
    readFileSync(join(process.cwd(), 'public', 'sample-exports', name), 'utf8');

  const load = async (name: string, entity: Parameters<typeof analyzeFile>[1]) => {
    const analyzed = analyzeFile(sample(name), entity);
    return runImport(db, ctx, {
      entity,
      parsed: analyzed.parsed,
      mapping: analyzed.mapping,
      fileName: name,
      cutoverDate: CUTOVER,
    });
  };

  it('catch a dropped row all the way through to the opening balance', async () => {
    await load('quickbooks-chart-of-accounts.csv', 'CHART_OF_ACCOUNTS');

    const customers = await load('quickbooks-customers.csv', 'CUSTOMER');
    expect(customers.imported).toBeGreaterThan(15);

    const items = await load('price-book.csv', 'PRICE_BOOK_ITEM');
    expect(items.imported).toBeGreaterThan(15);

    // The row the act is about: an invoice raised against a name nobody has.
    const aging = await load('quickbooks-ar-aging.csv', 'OPEN_INVOICE');
    expect(aging.reconciliation.matches).toBe(false);
    expect(aging.issues.some((issue) => issue.value === 'Ghost Customer Ltd')).toBe(true);
    expect(
      aging.reconciliation.sourceTotalCents - aging.reconciliation.importedTotalCents,
    ).toBe(500_00n);

    // And it does not quietly come right later. The trial balance's receivables line is
    // the aging's full total, so the five hundred that never arrived is still missing when
    // the opening entry lands — which is exactly what Opening Balance Equity is for.
    const tb = await load('quickbooks-trial-balance.csv', 'TRIAL_BALANCE');
    expect(tb.reconciliation.isBalanced).toBe(false);
    expect(tb.reconciliation.openingBalanceEquityCents).toBe(-500_00n);

    // The ledger itself still balances — a wrong import is not an unbalanced one, which is
    // why the equity figure rather than the trial balance is the thing to watch.
    const balance = await trialBalance(db, ctx, {});
    expect(balance.isBalanced).toBe(true);
  }, 120_000);

  it('clear opening equity to zero once the flagged row is corrected', async () => {
    await load('quickbooks-chart-of-accounts.csv', 'CHART_OF_ACCOUNTS');
    await load('quickbooks-customers.csv', 'CUSTOMER');

    const corrected = await load('quickbooks-ar-aging-corrected.csv', 'OPEN_INVOICE');
    expect(corrected.reconciliation.matches).toBe(true);
    expect(corrected.reconciliation.importedTotalCents).toBe(
      corrected.reconciliation.sourceTotalCents,
    );
    expect(corrected.issues.filter((issue) => issue.severity === 'ERROR')).toEqual([]);

    const tb = await load('quickbooks-trial-balance.csv', 'TRIAL_BALANCE');
    expect(tb.reconciliation.openingBalanceEquityCents).toBe(ZERO);
    expect(tb.reconciliation.isBalanced).toBe(true);

    const balance = await trialBalance(db, ctx, {});
    expect(balance.isBalanced).toBe(true);
  }, 120_000);
});

describe('the words a source system actually uses', () => {
  it('reads an item list that calls labour "Service" and a part an "Inventory Part"', async () => {
    const csv = [
      'Item Name/Number,Sales Description,Item Type,Purchase Cost,Sales Price',
      'PLM-TOIL-R,Replace standard toilet,Service,"242.82","485.00"',
      'PRT-WAX,Wax ring kit,Inventory Part,"3.80","12.00"',
      'SUB-TILE,Tile work,Subcontractor,"180.00","450.00"',
      'PLAN-GOLD,Annual service plan,Service Plan,"0.00","349.00"',
    ].join('\n');

    const analyzed = analyzeFile(csv, 'PRICE_BOOK_ITEM');
    const report = validateImport('PRICE_BOOK_ITEM', analyzed.parsed, analyzed.mapping);

    // Not one warning: every one of those words is a word the file was always going to use.
    expect(report.issues.filter((issue) => issue.field === 'category')).toEqual([]);

    await runImport(db, ctx, {
      entity: 'PRICE_BOOK_ITEM',
      parsed: analyzed.parsed,
      mapping: analyzed.mapping,
      cutoverDate: CUTOVER,
    });

    const items = await db.priceBookItem.findMany({
      where: { organizationId: org.organizationId },
      select: { sku: true, category: true },
      orderBy: { sku: 'asc' },
    });

    // The category picks the revenue account and the tax treatment, so filing a service
    // as a material is a tax position rather than a cosmetic slip.
    expect(Object.fromEntries(items.map((item) => [item.sku, item.category]))).toEqual({
      'PLAN-GOLD': 'AGREEMENT',
      'PLM-TOIL-R': 'LABOR',
      'PRT-WAX': 'MATERIAL',
      'SUB-TILE': 'SUBCONTRACT',
    });
  });

  it('still says so when a value is one nobody uses', () => {
    const csv = [
      'Item Name/Number,Sales Description,Item Type,Sales Price',
      'X-1,Something,Widgetry,"10.00"',
    ].join('\n');

    const analyzed = analyzeFile(csv, 'PRICE_BOOK_ITEM');
    const report = validateImport('PRICE_BOOK_ITEM', analyzed.parsed, analyzed.mapping);

    expect(report.issues.some((issue) => /Widgetry/.test(issue.message))).toBe(true);
  });
});
