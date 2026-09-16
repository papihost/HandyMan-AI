import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { postJournalEntry, reverseJournalEntry } from '../src/lib/accounting/ledger';
import { closePeriod, findPeriodFor, reopenPeriod } from '../src/lib/accounting/periods';
import { balanceSheet, profitByLocation, trialBalance } from '../src/lib/accounting/reports';
import { invoiceIssuedLines } from '../src/lib/accounting/rules/invoice';
import { paymentReceivedLines } from '../src/lib/accounting/rules/payment';
import { createTestJob, createTestOrg, utc, type TestOrg } from './factory';

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg('Ledger');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('postJournalEntry', () => {
  it('posts a balanced entry and numbers it', async () => {
    const entry = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 3, 15),
      source: 'MANUAL',
      memo: 'Owner contribution',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 500000n, locationId: org.locationId },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 500000n, locationId: org.locationId },
      ],
    });

    expect(entry.entryNo).toMatch(/^JE-\d{5}$/);
    expect(entry.totalCents).toBe(500000n);
    expect(entry.postedAt).toBeInstanceOf(Date);
  });

  it('allocates document numbers without gaps or repeats under concurrency', async () => {
    const before = await db.journalEntry.count({ where: { organizationId: org.organizationId } });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postJournalEntry(db, org.systemCtx, {
          entryDate: utc(2026, 3, 16),
          source: 'MANUAL',
          memo: `Concurrent ${i}`,
          lines: [
            { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
            { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
          ],
        }),
      ),
    );

    const entries = await db.journalEntry.findMany({
      where: { organizationId: org.organizationId },
      select: { entryNo: true },
    });
    const numbers = entries.map((e) => Number(e.entryNo.replace('JE-', '')));
    expect(new Set(numbers).size).toBe(entries.length);
    expect(entries.length).toBe(before + 10);
    // Gapless: the allocated numbers form a contiguous run from 1.
    expect(Math.max(...numbers)).toBe(entries.length);
  });

  it('refuses an unbalanced entry', async () => {
    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2026, 3, 15),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 99n },
        ],
      }),
    ).rejects.toThrow(/out of balance/);
  });

  it('refuses a single-sided line and a zero line', async () => {
    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2026, 3, 15),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n, creditCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
        ],
      }),
    ).rejects.toThrow(/either a debit or a credit/);

    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2026, 3, 15),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 0n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 0n },
        ],
      }),
    ).rejects.toThrow(/zero on both sides/);
  });

  it('refuses a negative amount rather than silently flipping the side', async () => {
    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2026, 3, 15),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: -100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: -100n },
        ],
      }),
    ).rejects.toThrow(/must be positive/);
  });

  it('refuses an unknown account', async () => {
    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2026, 3, 15),
        source: 'MANUAL',
        lines: [
          { accountCode: '9999', debitCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
        ],
      }),
    ).rejects.toThrow(/not found/);
  });

  it('records an audit entry for every posting', async () => {
    const entry = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 3, 17),
      source: 'MANUAL',
      memo: 'Audited',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 4200n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 4200n },
      ],
    });

    const log = await db.auditLog.findFirst({
      where: { entityType: 'JournalEntry', entityId: entry.id, action: 'POST' },
    });
    expect(log).not.toBeNull();
  });
});

describe('immutability', () => {
  it('rejects an update to a posted entry at the database level', async () => {
    const entry = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 4, 1),
      source: 'MANUAL',
      memo: 'Original',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 10000n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 10000n },
      ],
    });

    // Bypassing every application check and going straight at the row.
    await expect(
      db.journalEntry.update({ where: { id: entry.id }, data: { memo: 'Tampered' } }),
    ).rejects.toThrow(/posted and cannot be modified/);
  });

  it('rejects a delete of a posted entry', async () => {
    const entry = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 4, 2),
      source: 'MANUAL',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 10000n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 10000n },
      ],
    });

    await expect(db.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('rejects changing the lines of a posted entry', async () => {
    const entry = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 4, 3),
      source: 'MANUAL',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 10000n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 10000n },
      ],
    });

    const line = await db.journalLine.findFirstOrThrow({ where: { journalEntryId: entry.id } });
    await expect(
      db.journalLine.update({ where: { id: line.id }, data: { debitCents: 999999n } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(db.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(
      /cannot be changed or removed/,
    );
  });

  it('rejects an unbalanced entry written directly, past the application layer', async () => {
    const bankId = org.accountIdByCode.get(ACCOUNTS.BANK_OPERATING)!;
    const equityId = org.accountIdByCode.get(ACCOUNTS.OWNERS_EQUITY)!;
    const period = await findPeriodFor(db, org.organizationId, utc(2026, 4, 4));

    await expect(
      db.journalEntry.create({
        data: {
          organizationId: org.organizationId,
          entryNo: `JE-RAW-${Date.now()}`,
          entryDate: utc(2026, 4, 4),
          postedAt: new Date(),
          source: 'MANUAL',
          periodId: period!.id,
          lines: {
            create: [
              { accountId: bankId, lineNo: 1, debitCents: 100n },
              { accountId: equityId, lineNo: 2, creditCents: 50n },
            ],
          },
        },
      }),
    ).rejects.toThrow(/out of balance/);
  });

  it('keeps the audit log append-only', async () => {
    const log = await db.auditLog.findFirstOrThrow({
      where: { organizationId: org.organizationId },
    });
    await expect(
      db.auditLog.update({ where: { id: log.id }, data: { action: 'REWRITTEN' } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: log.id } })).rejects.toThrow(/append-only/);
  });
});

describe('reversal', () => {
  it('reverses an entry by swapping sides and preserving dimensions', async () => {
    const original = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 5, 10),
      source: 'MANUAL',
      memo: 'Keyed to the wrong account',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 33300n, locationId: org.locationId },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 33300n, locationId: org.locationId },
      ],
    });

    const reversal = await reverseJournalEntry(db, org.systemCtx, original.id);
    const lines = await db.journalLine.findMany({
      where: { journalEntryId: reversal.id },
      include: { account: true },
      orderBy: { lineNo: 'asc' },
    });

    expect(lines[0].creditCents).toBe(33300n);
    expect(lines[0].debitCents).toBe(0n);
    expect(lines[0].account.code).toBe(ACCOUNTS.BANK_OPERATING);
    // Dimensions survive, so the reversal lands in the same branch as the mistake.
    expect(lines[0].locationId).toBe(org.locationId);

    const stored = await db.journalEntry.findUniqueOrThrow({ where: { id: reversal.id } });
    expect(stored.isReversal).toBe(true);
    expect(stored.reversesEntryId).toBe(original.id);
  });

  it('leaves the original entry untouched', async () => {
    const original = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 5, 11),
      source: 'MANUAL',
      memo: 'Stays as posted',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 1000n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 1000n },
      ],
    });

    await reverseJournalEntry(db, org.systemCtx, original.id);
    const stored = await db.journalEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(stored.memo).toBe('Stays as posted');
    expect(stored.postedAt).not.toBeNull();
  });

  it('refuses to reverse the same entry twice', async () => {
    const original = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 5, 12),
      source: 'MANUAL',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 700n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 700n },
      ],
    });

    await reverseJournalEntry(db, org.systemCtx, original.id);
    await expect(reverseJournalEntry(db, org.systemCtx, original.id)).rejects.toThrow(
      /already been reversed/,
    );
  });

  it('nets to zero in the trial balance', async () => {
    const before = await trialBalance(db, org.systemCtx, { from: utc(2026, 6, 1), to: utc(2026, 6, 30) });
    expect(before.rows).toHaveLength(0);

    const original = await postJournalEntry(db, org.systemCtx, {
      entryDate: utc(2026, 6, 15),
      source: 'MANUAL',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 9999n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 9999n },
      ],
    });
    await reverseJournalEntry(db, org.systemCtx, original.id);

    const after = await trialBalance(db, org.systemCtx, { from: utc(2026, 6, 1), to: utc(2026, 6, 30) });
    expect(after.isBalanced).toBe(true);
    for (const row of after.rows) expect(row.balanceCents).toBe(0n);
  });
});

describe('period control', () => {
  it('refuses a posting into a closed period', async () => {
    const closeOrg = await createTestOrg('Periods');
    const period = await findPeriodFor(closeOrg.db, closeOrg.organizationId, utc(2025, 1, 15));

    // January is the first period of the fiscal year, so nothing precedes it.
    await closePeriod(db, closeOrg.systemCtx, period!.id);

    await expect(
      postJournalEntry(db, closeOrg.systemCtx, {
        entryDate: utc(2025, 1, 20),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
        ],
      }),
    ).rejects.toThrow(/period is CLOSED/);
  });

  it('accepts postings again once the period is reopened, and audits the reopening', async () => {
    const reopenOrg = await createTestOrg('Reopen');
    const period = await findPeriodFor(reopenOrg.db, reopenOrg.organizationId, utc(2025, 1, 15));

    await closePeriod(db, reopenOrg.systemCtx, period!.id);
    await reopenPeriod(db, reopenOrg.systemCtx, period!.id, 'Auditor found a missing bill');

    const entry = await postJournalEntry(db, reopenOrg.systemCtx, {
      entryDate: utc(2025, 1, 20),
      source: 'MANUAL',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
        { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
      ],
    });
    expect(entry.entryNo).toBeTruthy();

    const log = await db.auditLog.findFirst({
      where: { entityType: 'AccountingPeriod', entityId: period!.id, action: 'REOPEN_PERIOD' },
    });
    expect(log).not.toBeNull();
  });

  it('refuses to close a period while an earlier one is still open', async () => {
    const seqOrg = await createTestOrg('Sequence');
    const march = await findPeriodFor(seqOrg.db, seqOrg.organizationId, utc(2025, 3, 15));

    await expect(closePeriod(db, seqOrg.systemCtx, march!.id)).rejects.toThrow(/still open/);
  });

  it('refuses a posting to a date no fiscal year covers', async () => {
    await expect(
      postJournalEntry(db, org.systemCtx, {
        entryDate: utc(2099, 1, 1),
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
        ],
      }),
    ).rejects.toThrow(/No accounting period covers/);
  });
});

describe('reporting from the ledger', () => {
  it('produces a balanced trial balance, a P&L by branch, and a balance sheet that ties', async () => {
    const reportOrg = await createTestOrg('Reports');
    const ctx = systemContext(reportOrg.organizationId);
    const mesaJob = await createTestJob(reportOrg.organizationId, reportOrg.locationId);
    const phxJob = await createTestJob(reportOrg.organizationId, reportOrg.otherLocationId);

    // Mesa: an invoice for 650.00 + 16.50 tax, and its cost.
    await postJournalEntry(db, ctx, {
      entryDate: utc(2026, 2, 10),
      source: 'INVOICE',
      sourceType: 'Invoice',
      sourceId: 'inv-1',
      lines: invoiceIssuedLines({
        invoiceNo: 'INV-00001',
        locationId: reportOrg.locationId,
        customerId: mesaJob.customerId,
        jobId: mesaJob.jobId,
        revenueLines: [
          { category: 'LABOR', amountCents: 45000n },
          { category: 'MATERIALS', amountCents: 20000n },
        ],
        taxes: [{ taxCents: 1650n, jurisdictionName: 'Mesa' }],
      }),
    });

    await postJournalEntry(db, ctx, {
      entryDate: utc(2026, 2, 10),
      source: 'INVENTORY',
      lines: [
        {
          accountCode: ACCOUNTS.COGS_MATERIALS,
          debitCents: 12000n,
          locationId: reportOrg.locationId,
          jobId: mesaJob.jobId,
        },
        {
          accountCode: ACCOUNTS.INVENTORY_VAN,
          creditCents: 12000n,
          locationId: reportOrg.locationId,
          jobId: mesaJob.jobId,
        },
      ],
    });

    // Phoenix: a smaller invoice.
    await postJournalEntry(db, ctx, {
      entryDate: utc(2026, 2, 12),
      source: 'INVOICE',
      lines: invoiceIssuedLines({
        invoiceNo: 'INV-00002',
        locationId: reportOrg.otherLocationId,
        customerId: phxJob.customerId,
        jobId: phxJob.jobId,
        revenueLines: [{ category: 'LABOR', amountCents: 30000n }],
      }),
    });

    // Payment against the Mesa invoice.
    await postJournalEntry(db, ctx, {
      entryDate: utc(2026, 2, 14),
      source: 'PAYMENT',
      lines: paymentReceivedLines({
        paymentNo: 'PMT-00001',
        locationId: reportOrg.locationId,
        customerId: mesaJob.customerId,
        jobId: mesaJob.jobId,
        method: 'CARD',
        amountCents: 66650n,
        feeCents: 1933n,
        isDeposit: false,
      }),
    });

    const from = utc(2026, 2, 1);
    const to = utc(2026, 2, 28);

    const tb = await trialBalance(db, ctx, { from, to });
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebitsCents).toBe(tb.totalCreditsCents);

    const byLocation = await profitByLocation(db, ctx, { from, to });
    const mesa = byLocation.find((r) => r.locationName === 'Mesa')!;
    const phoenix = byLocation.find((r) => r.locationName === 'Phoenix')!;

    expect(mesa.revenueCents).toBe(65000n);
    expect(mesa.cogsCents).toBe(12000n);
    expect(mesa.grossProfitCents).toBe(53000n);
    expect(phoenix.revenueCents).toBe(30000n);
    expect(phoenix.grossProfitCents).toBe(30000n);

    const bs = await balanceSheet(db, ctx, to);
    expect(bs.isBalanced).toBe(true);

    // The deposit liability is untouched: nothing here was a prepayment.
    const deposits = tb.rows.find((r) => r.code === ACCOUNTS.CUSTOMER_DEPOSITS);
    expect(deposits).toBeUndefined();
  });

  it('traces every ledger line back to the document that produced it', async () => {
    const traceOrg = await createTestOrg('Trace');
    const ctx = systemContext(traceOrg.organizationId);
    const traced = await createTestJob(traceOrg.organizationId, traceOrg.locationId);

    const entry = await postJournalEntry(db, ctx, {
      entryDate: utc(2026, 7, 4),
      source: 'INVOICE',
      sourceType: 'Invoice',
      sourceId: 'invoice-abc',
      lines: invoiceIssuedLines({
        invoiceNo: 'INV-00009',
        locationId: traceOrg.locationId,
        customerId: traced.customerId,
        jobId: traced.jobId,
        revenueLines: [{ category: 'LABOR', amountCents: 12500n }],
      }),
    });

    const stored = await db.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(stored.sourceType).toBe('Invoice');
    expect(stored.sourceId).toBe('invoice-abc');

    const jobLines = await db.journalLine.findMany({ where: { jobId: traced.jobId } });
    expect(jobLines.length).toBeGreaterThan(0);
  });
});
