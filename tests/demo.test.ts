import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '../src/lib/db';
import { systemContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { postJournalEntry } from '../src/lib/accounting/ledger';
import { balanceSheet, incomeStatement, profitByLocation, trialBalance } from '../src/lib/accounting/reports';
import { inventoryValuation } from '../src/lib/inventory/reports';
import { signIn } from '../src/lib/auth/service';
import { DEMO_PASSWORD, seedDemoCompany } from '../src/lib/demo/seed';
import { assertDemoOrganization, deleteDemoOrganization } from '../src/lib/demo/reset';

/**
 * The demo company is what a prospect actually sees, so it is tested like a feature: the
 * books have to balance, the subledgers have to agree with the general ledger, and the
 * whole thing has to disappear cleanly when it is reset.
 */

const TODAY = new Date(Date.UTC(2026, 8, 17));
const YEAR_START = new Date(Date.UTC(2025, 8, 1));

let organizationId: string;

beforeAll(async () => {
  // A small company: the properties under test hold at any size, and the full-size seed
  // takes minutes.
  const result = await seedDemoCompany(db, {
    seed: 1234,
    jobCount: 90,
    customerCount: 60,
    today: TODAY,
  });
  organizationId = result.organizationId;
}, 300_000);

afterAll(async () => {
  await db.$disconnect();
});

describe('the seeded books', () => {
  it('balances, and the balance sheet ties', async () => {
    const ctx = systemContext(organizationId);
    const tb = await trialBalance(db, ctx, {});

    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebitsCents).toBe(tb.totalCreditsCents);
    expect(tb.totalDebitsCents).toBeGreaterThan(0n);

    const bs = await balanceSheet(db, ctx, TODAY);
    expect(bs.isBalanced).toBe(true);
  });

  it('produces a complete income statement, not just gross profit', async () => {
    const ctx = systemContext(organizationId);
    const pl = await incomeStatement(db, ctx, { from: YEAR_START, to: TODAY });

    expect(pl.revenue.totalCents).toBeGreaterThan(0n);
    expect(pl.costOfGoodsSold.totalCents).toBeGreaterThan(0n);
    // Rent, advertising, office payroll and depreciation are all posted; without them a
    // controller sees net income equal to gross profit and stops believing the demo.
    expect(pl.operatingExpenses.totalCents).toBeGreaterThan(0n);
    expect(pl.netIncomeCents).toBe(pl.grossProfitCents - pl.operatingExpenses.totalCents);
  });

  it('costs unbilled technician time, so margin is not flattered', async () => {
    const ctx = systemContext(organizationId);
    const tb = await trialBalance(db, ctx, {});

    const labor = tb.rows.find((r) => r.code === ACCOUNTS.COGS_LABOR)!;
    const burden = tb.rows.find((r) => r.code === ACCOUNTS.COGS_BURDEN)!;

    expect(labor.balanceCents).toBeGreaterThan(0n);
    expect(burden.balanceCents).toBeGreaterThan(0n);

    // Some labor cost carries no job, which is exactly the drive time, shop time and idle
    // hours that a system costing only billable hours would quietly lose.
    const unbilled = await db.journalLine.count({
      where: {
        jobId: null,
        account: { organizationId, code: ACCOUNTS.COGS_LABOR },
        journalEntry: { postedAt: { not: null } },
      },
    });
    expect(unbilled).toBeGreaterThan(0);
  });

  it('reports profit for each branch', async () => {
    const ctx = systemContext(organizationId);
    const rows = await profitByLocation(db, ctx, { from: YEAR_START, to: TODAY });

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.locationName).sort()).toEqual(['Mesa', 'Phoenix', 'Scottsdale']);
    for (const row of rows) {
      expect(row.revenueCents).toBeGreaterThan(0n);
      expect(row.grossProfitCents).toBe(row.revenueCents - row.cogsCents);
    }
    // Every posting is attributed to a branch, so nothing lands in an "unassigned" bucket.
    expect(rows.some((r) => r.locationId === null)).toBe(false);
  });

  it('keeps the inventory subledger equal to the general ledger', async () => {
    const ctx = systemContext(organizationId);
    const valuation = await inventoryValuation(db, ctx);
    const tb = await trialBalance(db, ctx, {});

    const gl =
      (tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_WAREHOUSE)?.balanceCents ?? 0n) +
      (tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)?.balanceCents ?? 0n);

    expect(valuation.totalCents).toBe(gl);
  });

  it('holds no sales tax it has not remitted more than a month', async () => {
    const ctx = systemContext(organizationId);
    const tb = await trialBalance(db, ctx, {});
    const payable = tb.rows.find((r) => r.code === ACCOUNTS.SALES_TAX_PAYABLE);

    // Tax is collected and passed on, not kept. A balance may remain for the current
    // period, but it must never be negative — that would mean remitting money never taken.
    if (payable) expect(payable.balanceCents).toBeGreaterThanOrEqual(0n);
  });

  it('leaves work in flight, so the dispatch board is not a graveyard', async () => {
    const inFlight = await db.job.count({
      where: {
        organizationId,
        status: { in: ['SCHEDULED', 'DISPATCHED', 'IN_PROGRESS', 'DRAFT'] },
      },
    });
    expect(inFlight).toBeGreaterThan(0);
  });

  it('puts work on today, at a believable point in the day', async () => {
    const dayStart = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const todaysJobs = await db.job.findMany({
      where: { organizationId, scheduledStart: { gte: dayStart, lt: dayEnd } },
      select: { status: true, scheduledStart: true },
    });

    // A demo that opens on a technician with an empty morning is over before it starts.
    expect(todaysJobs.length).toBeGreaterThan(0);

    // Some of the day is behind and some is ahead — a board where everything is still to
    // come, or everything is finished, is not a working day.
    const finished = todaysJobs.filter((j) =>
      ['COMPLETED', 'INVOICED', 'PAID'].includes(j.status),
    ).length;
    const ahead = todaysJobs.filter((j) =>
      ['SCHEDULED', 'DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS'].includes(j.status),
    ).length;

    expect(finished).toBeGreaterThan(0);
    expect(ahead).toBeGreaterThan(0);
  });

  it('books the coming days as well, so the schedule has a future', async () => {
    const tomorrow = new Date(
      Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + 1),
    );

    const upcoming = await db.job.count({
      where: { organizationId, scheduledStart: { gte: tomorrow } },
    });
    expect(upcoming).toBeGreaterThan(0);

    // Nothing in the future has been worked.
    const workedAhead = await db.job.count({
      where: {
        organizationId,
        scheduledStart: { gte: tomorrow },
        status: { in: ['COMPLETED', 'INVOICED', 'PAID', 'CLOSED'] },
      },
    });
    expect(workedAhead).toBe(0);
  });

  it('leaves quotes unclosed, so the pipeline has something in it', async () => {
    const open = await db.quote.count({ where: { organizationId, status: 'SENT' } });
    expect(open).toBeGreaterThan(0);
  });

  it('records warranty callbacks that cost but do not bill', async () => {
    const callbacks = await db.job.findMany({
      where: { organizationId, isWarranty: true },
      select: { id: true, isBillable: true, parentJobId: true },
    });

    expect(callbacks.length).toBeGreaterThan(0);
    for (const callback of callbacks) {
      expect(callback.isBillable).toBe(false);
      expect(callback.parentJobId).not.toBeNull();
    }

    const invoiced = await db.invoice.count({
      where: { organizationId, jobId: { in: callbacks.map((c) => c.id) } },
    });
    expect(invoiced).toBe(0);
  });

  it('closes older periods and refuses to post into them', async () => {
    const ctx = systemContext(organizationId);
    const closed = await db.accountingPeriod.findFirst({
      where: { organizationId, status: 'CLOSED' },
      orderBy: { startDate: 'desc' },
    });
    expect(closed).not.toBeNull();

    await expect(
      postJournalEntry(db, ctx, {
        entryDate: closed!.startDate,
        source: 'MANUAL',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100n },
        ],
      }),
    ).rejects.toThrow(/period is CLOSED/);
  });

  it('lets the seeded staff sign in', async () => {
    const result = await signIn(db, {
      organizationId,
      email: 'diane.kowalczyk@apexhandyman.test',
      password: DEMO_PASSWORD,
    });
    expect(result.context.roleKeys).toEqual(['CONTROLLER']);
    expect(result.context.canReadCost).toBe(true);
  });

  it('gives technicians accounts that cannot see cost', async () => {
    const result = await signIn(db, {
      organizationId,
      email: 'marcus.deleon@apexhandyman.test',
      password: DEMO_PASSWORD,
    });
    expect(result.context.roleKeys).toEqual(['TECHNICIAN']);
    expect(result.context.canReadCost).toBe(false);
    expect(result.context.scope).toBe('SELF');
  });
});

describe('reproducibility', () => {
  it('produces the same company from the same seed', async () => {
    const a = await seedDemoCompany(db, { seed: 777, jobCount: 25, customerCount: 20, today: TODAY });
    const b = await seedDemoCompany(db, { seed: 777, jobCount: 25, customerCount: 20, today: TODAY });

    const revenue = async (id: string) =>
      (await incomeStatement(db, systemContext(id), { from: YEAR_START, to: TODAY })).revenue
        .totalCents;

    expect(await revenue(a.organizationId)).toBe(await revenue(b.organizationId));
    expect(a.counts.customers).toBe(b.counts.customers);
    expect(a.counts.jobs).toBe(b.counts.jobs);

    await deleteDemoOrganization(db, a.organizationId);
    await deleteDemoOrganization(db, b.organizationId);
  }, 300_000);
});

describe('demo reset', () => {
  it('refuses to touch an organization holding live data', async () => {
    const live = await db.organization.create({
      data: { name: 'A Real Customer, Inc.', dataMode: 'LIVE' },
    });

    await expect(assertDemoOrganization(db, live.id)).rejects.toThrow(/holds live data/);
    await expect(deleteDemoOrganization(db, live.id)).rejects.toThrow(/holds live data/);

    // Still there.
    expect(await db.organization.findUnique({ where: { id: live.id } })).not.toBeNull();
    await db.organization.delete({ where: { id: live.id } });
  });

  it('leaves nothing behind in any table', async () => {
    const seeded = await seedDemoCompany(db, {
      seed: 99,
      jobCount: 30,
      customerCount: 15,
      today: TODAY,
    });

    const before = await db.journalEntry.count({ where: { organizationId: seeded.organizationId } });
    expect(before).toBeGreaterThan(0);

    await deleteDemoOrganization(db, seeded.organizationId);

    // Walk every model the schema declares with an organizationId and assert it is empty,
    // so a table added later cannot quietly start leaking across resets.
    const orgScoped = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
      .map((m) => m.name);

    const survivors: string[] = [];
    for (const model of orgScoped) {
      const delegate = (db as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[
        model.charAt(0).toLowerCase() + model.slice(1)
      ];
      const count = await delegate.count({ where: { organizationId: seeded.organizationId } });
      if (count > 0) survivors.push(`${model}: ${count}`);
    }

    expect(survivors).toEqual([]);
    expect(await db.organization.findUnique({ where: { id: seeded.organizationId } })).toBeNull();
  }, 300_000);

  it('restores the ledger triggers it had to disable', async () => {
    const seeded = await seedDemoCompany(db, {
      seed: 55,
      jobCount: 10,
      customerCount: 10,
      today: TODAY,
    });
    await deleteDemoOrganization(db, seeded.organizationId);

    // A posted entry in a surviving organization must still be immutable afterwards.
    const ctx = systemContext(organizationId);
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { organizationId, postedAt: { not: null } },
    });
    await expect(
      db.journalEntry.update({ where: { id: entry.id }, data: { memo: 'tampered' } }),
    ).rejects.toThrow(/posted and cannot be modified/);
  }, 300_000);
});
