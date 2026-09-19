import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { postJournalEntry } from '../src/lib/accounting/ledger';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { laborCostedLines } from '../src/lib/accounting/rules/labor';
import { createCustomer } from '../src/lib/customers/service';
import { addJobLines, createJob, transitionJob } from '../src/lib/jobs/service';
import { createInvoiceFromJob, issueInvoice } from '../src/lib/invoices/service';
import {
  companySummary,
  marginByServiceType,
  technicianScorecard,
  flatRateReview,
  unappliedLabourByBranch,
  unbilledCompletedJobs,
  dispatchBoard,
} from '../src/lib/reporting/dashboard';
import {
  createPriceBookItem,
  createTestOrg,
  createTestTechnician,
  utc,
  type TestOrg,
} from './factory';

/**
 * The office reports.
 *
 * Every figure here is read from posted journal lines, so these tests are really about one
 * property: what the dashboard says and what the ledger says are the same thing.
 */

const WORK_DATE = utc(2026, 4, 14);
const PERIOD = { from: utc(2026, 1, 1), to: utc(2026, 12, 31) };

let org: TestOrg;
let ctx: AuthContext;
let plumbingId: string;
let drywallId: string;
let tech: { technicianId: string; userId: string };

async function completedJob(options: {
  serviceTypeId: string;
  itemId: string;
  quantity: string;
  labourHours: string;
  invoice?: boolean;
}) {
  const customer = await createCustomer(db, ctx, {
    lastName: `R${Math.random().toString(36).slice(2, 7)}`,
    property: { addressLine1: '1 Test St', city: 'Mesa', state: 'AZ', postalCode: '85201' },
  });

  const job = await createJob(db, ctx, {
    locationId: org.locationId,
    customerId: customer.id,
    propertyId: customer.properties[0].id,
    title: 'Seeded work',
    serviceTypeId: options.serviceTypeId,
    scheduledStart: WORK_DATE,
  });

  await db.jobAssignment.create({
    data: { jobId: job.id, technicianId: tech.technicianId, isLead: true },
  });
  await addJobLines(db, ctx, job.id, [
    { priceBookItemId: options.itemId, quantity: options.quantity },
  ]);

  await transitionJob(db, ctx, job.id, 'DISPATCHED');
  await transitionJob(db, ctx, job.id, 'IN_PROGRESS');
  await transitionJob(db, ctx, job.id, 'COMPLETED');

  await postJournalEntry(db, ctx, {
    entryDate: WORK_DATE,
    source: 'PAYROLL',
    sourceType: 'TimeEntry',
    sourceId: job.id,
    lines: laborCostedLines({
      jobId: job.id,
      locationId: org.locationId,
      technicianId: tech.technicianId,
      serviceTypeId: options.serviceTypeId,
      hours: options.labourHours,
      baseHourlyCents: 2800n,
      loadedHourlyCents: 4056n,
    }),
  });

  if (options.invoice !== false) {
    const draft = await createInvoiceFromJob(db, ctx, { jobId: job.id, issueDate: WORK_DATE });
    await issueInvoice(db, ctx, draft.id);
  }

  return job;
}

beforeAll(async () => {
  org = await createTestOrg('Reporting');
  ctx = systemContext(org.organizationId);
  tech = await createTestTechnician(org.organizationId, org.locationId);

  plumbingId = (
    await db.serviceType.create({
      data: { organizationId: org.organizationId, code: 'PLM', name: 'Plumbing' },
    })
  ).id;
  drywallId = (
    await db.serviceType.create({
      data: { organizationId: org.organizationId, code: 'DRY', name: 'Drywall' },
    })
  ).id;

  const healthy = await createPriceBookItem(org.organizationId, {
    name: 'Replace toilet',
    category: 'LABOR',
    kind: 'FLAT_RATE',
    costCents: 14200n,
    priceCents: 48500n,
  });
  // Priced years ago and never revisited while costs climbed — the anomaly.
  const stale = await createPriceBookItem(org.organizationId, {
    name: 'Drywall patch',
    category: 'LABOR',
    kind: 'FLAT_RATE',
    costCents: 13900n,
    priceCents: 15500n,
  });

  await completedJob({ serviceTypeId: plumbingId, itemId: healthy, quantity: '1', labourHours: '2.5' });
  await completedJob({ serviceTypeId: plumbingId, itemId: healthy, quantity: '2', labourHours: '5' });
  await completedJob({ serviceTypeId: drywallId, itemId: stale, quantity: '1', labourHours: '2' });
  await completedJob({ serviceTypeId: drywallId, itemId: stale, quantity: '1', labourHours: '2.25' });

  // Finished, never billed.
  await completedJob({
    serviceTypeId: plumbingId,
    itemId: healthy,
    quantity: '1',
    labourHours: '2',
    invoice: false,
  });

  // Paid hours that never reached a job: waiting, driving, a call that cancelled. They
  // land on the branch with no job and no trade, which is the whole point of the report.
  await postJournalEntry(db, ctx, {
    entryDate: WORK_DATE,
    source: 'PAYROLL',
    memo: 'Paid time not booked to a job',
    lines: [
      {
        accountCode: ACCOUNTS.COGS_LABOR,
        debitCents: 5_600n,
        locationId: org.locationId,
        technicianId: tech.technicianId,
        memo: 'Unbilled paid hours (2.0)',
      },
      {
        accountCode: ACCOUNTS.COGS_BURDEN,
        debitCents: 2_512n,
        locationId: org.locationId,
        technicianId: tech.technicianId,
        memo: 'Burden on unbilled hours',
      },
      { accountCode: ACCOUNTS.PAYROLL_LIABILITIES, creditCents: 8_112n },
    ],
  });
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe('margin by service line', () => {
  it('attributes revenue to the trade that earned it, not only the cost', async () => {
    const rows = await marginByServiceType(db, ctx, PERIOD);

    for (const row of rows) {
      // Costs carry a service type through the posting rules. Revenue has to as well, or
      // the report shows costs with nothing against them — wrong in a believable direction.
      expect(row.revenueCents).toBeGreaterThan(0n);
    }
  });

  it('flags the line running well under the rest, and only that one', async () => {
    const rows = await marginByServiceType(db, ctx, PERIOD);

    const drywall = rows.find((r) => r.name === 'Drywall')!;
    const plumbing = rows.find((r) => r.name === 'Plumbing')!;

    expect(drywall.grossMarginPercent).toBeLessThan(plumbing.grossMarginPercent);
    expect(drywall.isOutlier).toBe(true);
    expect(plumbing.isOutlier).toBe(false);

    // Worst first, so the thing worth asking about is at the top.
    expect(rows[0].name).toBe('Drywall');
  });

  it('agrees with the ledger it was read from', async () => {
    const rows = await marginByServiceType(db, ctx, PERIOD);
    const summary = await companySummary(db, ctx, PERIOD);

    const revenue = rows.reduce((total, row) => total + row.revenueCents, 0n);
    expect(revenue).toBe(summary.revenueCents);
  });
});

describe('company summary', () => {
  it('derives gross and net from the same lines the P&L uses', async () => {
    const summary = await companySummary(db, ctx, PERIOD);

    expect(summary.revenueCents).toBeGreaterThan(0n);
    expect(summary.grossProfitCents).toBe(summary.revenueCents - summary.cogsCents);
    expect(summary.netIncomeCents).toBe(
      summary.grossProfitCents - summary.operatingExpenseCents,
    );
    expect(summary.receivablesCents).toBeGreaterThan(0n);
  });

  it('counts finished work nobody has billed', async () => {
    const summary = await companySummary(db, ctx, PERIOD);
    const unbilled = await unbilledCompletedJobs(db, ctx);

    expect(summary.unbilledJobCount).toBe(1);
    expect(summary.unbilledCents).toBe(unbilled.totalCents);
    expect(unbilled.jobs[0].valueCents).toBeGreaterThan(0n);
  });
});

describe('technician scorecard', () => {
  it('reads utilization from the ledger rather than a timesheet', async () => {
    // The fixture posted two hours of this technician's month that no job paid for.
    const rows = await technicianScorecard(db, ctx, PERIOD);
    const row = rows.find((r) => r.technicianId === tech.technicianId)!;

    expect(row.jobsCompleted).toBe(5);
    expect(row.revenueCents).toBeGreaterThan(0n);
    expect(row.averageTicketCents).toBeGreaterThan(0n);

    // 13.75 billable hours against 15.75 paid.
    expect(row.billableHours).toBe(14);
    expect(row.paidHours).toBe(16);
    expect(row.utilizationPercent).toBeGreaterThan(80);
    expect(row.utilizationPercent).toBeLessThan(90);
  });

  it('refuses a caller who may not see cost', async () => {
    const dispatcher = await db.role.findUniqueOrThrow({
      where: { organizationId_key: { organizationId: org.organizationId, key: 'DISPATCHER' } },
    });
    const restricted = {
      ...ctx,
      permissions: new Set([...ctx.permissions].filter((p) => p !== 'finance:read_cost')),
    } as AuthContext;

    await expect(technicianScorecard(db, restricted, PERIOD)).rejects.toThrow(
      /Missing permission: finance:read_cost/,
    );
    expect(dispatcher.key).toBe('DISPATCHER');
  });
});

describe('dispatch board', () => {
  it('groups a day by technician and puts unassigned work first', async () => {
    const customer = await createCustomer(db, ctx, {
      lastName: 'Unassigned',
      property: { addressLine1: '9 Loose End', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });
    await createJob(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      title: 'Nobody has taken this yet',
      scheduledStart: WORK_DATE,
    });

    const board = await dispatchBoard(db, ctx, WORK_DATE);

    expect(board.length).toBeGreaterThan(1);
    // The only column that needs a decision goes first.
    expect(board[0].name).toBe('Unassigned');
    expect(board[0].jobs).toHaveLength(1);
    expect(board.some((column) => column.technicianId === tech.technicianId)).toBe(true);
  });
});

describe('where the branch margin goes', () => {
  it('separates cost that reached a job from cost that reached only the branch', async () => {
    const [branch] = await unappliedLabourByBranch(db, ctx, PERIOD);

    // The two paid hours from the fixture, wage and burden, and not a cent of the labour
    // that reached a job.
    expect(branch.unappliedCostCents).toBe(8_112n);
    expect(branch.appliedCostCents).toBeGreaterThan(0n);
    expect(branch.unappliedPercentOfRevenue).toBeGreaterThan(0);
  });

  it('ties back to the same lines the trade report leaves out', async () => {
    const [branch] = await unappliedLabourByBranch(db, ctx, PERIOD);
    const byService = await marginByServiceType(db, ctx, PERIOD);

    const tradedCost = byService.reduce((total, row) => total + row.cogsCents, 0n);

    // Every cost is in exactly one of the two buckets — which is what makes the branch
    // table and the trade table reconcilable rather than merely different.
    expect(branch.appliedCostCents).toBe(tradedCost);
  });

  it('refuses a caller who may not see cost', async () => {
    const blind: AuthContext = {
      ...ctx,
      permissions: new Set([...ctx.permissions].filter((p) => p !== 'finance:read_cost')),
    };

    await expect(unappliedLabourByBranch(db, blind, PERIOD)).rejects.toThrow(/permission/i);
  });
});

describe('backdated job transitions', () => {
  it('stamps the transition when the work happened, not when the row was written', async () => {
    const customer = await createCustomer(db, ctx, {
      lastName: 'Backdate',
      property: { addressLine1: '2 Test St', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });
    const job = await createJob(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      title: 'Work done in March',
      serviceTypeId: plumbingId,
      scheduledStart: utc(2026, 3, 2),
    });

    const started = utc(2026, 3, 2);
    const finished = new Date(started.getTime() + 3 * 3_600_000);

    await transitionJob(db, ctx, job.id, 'DISPATCHED', { occurredAt: started });
    await transitionJob(db, ctx, job.id, 'IN_PROGRESS', { occurredAt: started });
    const done = await transitionJob(db, ctx, job.id, 'COMPLETED', { occurredAt: finished });

    expect(done.startedAt?.toISOString()).toBe(started.toISOString());
    expect(done.completedAt?.toISOString()).toBe(finished.toISOString());

    // And the default is still now, so a technician tapping the button is unaffected.
    const other = await createJob(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      title: 'Work done today',
      serviceTypeId: plumbingId,
      scheduledStart: utc(2026, 3, 2),
    });

    const before = Date.now();
    await transitionJob(db, ctx, other.id, 'DISPATCHED');
    await transitionJob(db, ctx, other.id, 'IN_PROGRESS');
    const now = await transitionJob(db, ctx, other.id, 'COMPLETED');
    expect(now.completedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('price book review', () => {
  it('finds the flat rate whose price stopped moving while its cost did not', async () => {
    const rows = await flatRateReview(db, ctx, PERIOD, { minimumTimesSold: 1 });

    const worst = rows[0];
    expect(worst.name).toBe('Drywall patch');
    // 13,900 against 15,500 — under a tenth of the price, and the thinnest thing sold.
    expect(worst.marginPercent).toBeLessThan(15);

    // Sorted thinnest first, so the dashboard callout can simply take the head.
    expect(rows.map((row) => row.marginPercent)).toEqual(
      [...rows.map((row) => row.marginPercent)].sort((a, b) => a - b),
    );
  });

  it('is a different question from margin by trade, and says so in the numbers', async () => {
    const [byPrice] = await flatRateReview(db, ctx, PERIOD, { minimumTimesSold: 1 });
    const byTrade = await marginByServiceType(db, ctx, PERIOD);
    const drywall = byTrade.find((row) => row.name === 'Drywall')!;

    // The trade reads better than the item inside it: the price book compares a billed
    // price against a standard cost, the trade compares revenue against what was posted.
    // Both are true, and a report that conflated them would hide the item.
    expect(byPrice.marginPercent).not.toBeCloseTo(drywall.grossMarginPercent, 1);
  });

  it('refuses a caller who may not see cost', async () => {
    const blind: AuthContext = {
      ...ctx,
      permissions: new Set([...ctx.permissions].filter((p) => p !== 'finance:read_cost')),
    };

    await expect(flatRateReview(db, blind, PERIOD)).rejects.toThrow(/permission/i);
  });
});
