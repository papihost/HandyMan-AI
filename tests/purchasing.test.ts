import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { trialBalance } from '../src/lib/accounting/reports';
import { jobCosting } from '../src/lib/jobs/costing';
import { payOpenBills, recordJobPurchase } from '../src/lib/purchasing/service';
import { createTestJob, createTestOrg, utc, type TestOrg } from './factory';

let org: TestOrg;
let ctx: AuthContext;
let supplyHouse: string;
let subcontractor: string;

beforeAll(async () => {
  org = await createTestOrg('Purchasing');
  ctx = systemContext(org.organizationId);

  supplyHouse = (
    await db.vendor.create({
      data: {
        organizationId: org.organizationId,
        vendorNo: 'V-0001',
        name: 'Copper State Supply',
        paymentTermsDays: 30,
      },
    })
  ).id;

  subcontractor = (
    await db.vendor.create({
      data: {
        organizationId: org.organizationId,
        vendorNo: 'V-0002',
        name: 'Rivera Tile & Stone',
        paymentTermsDays: 15,
        is1099Vendor: true,
        w9OnFile: true,
      },
    })
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('materials bought for one job', () => {
  it('costs to the job and creates a payable, without touching inventory', async () => {
    const job = await createTestJob(org.organizationId, org.locationId);

    const { bill } = await recordJobPurchase(db, ctx, {
      jobId: job.jobId,
      vendorId: supplyHouse,
      amountCents: 24_500n,
      description: 'Special-order fixture',
      receiptPhotoKey: 'receipts/abc.jpg',
      vendorInvoiceNo: 'SO-884210',
      purchasedAt: utc(2026, 4, 12),
    });

    expect(bill.billNo).toMatch(/^BILL-\d{5}$/);
    expect(bill.totalCents).toBe(24_500n);
    expect(bill.status).toBe('OPEN');
    // Thirty-day terms from the bill date.
    expect(bill.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-12');
    expect(bill.receiptPhotoKey).toBe('receipts/abc.jpg');

    const costing = await jobCosting(db, ctx, job.jobId);
    expect(costing.materialCents).toBe(24_500n);

    const tb = await trialBalance(db, ctx, { to: utc(2026, 4, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.COGS_MATERIALS)!.balanceCents).toBe(24_500n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AP)!.balanceCents).toBe(24_500n);
    // A one-off purchase for one job must never move the moving average of stocked items.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_WAREHOUSE)).toBeUndefined();
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)).toBeUndefined();
    expect(tb.isBalanced).toBe(true);
  });

  it('includes tax in the cost, since we cannot reclaim it', async () => {
    const job = await createTestJob(org.organizationId, org.locationId);
    await recordJobPurchase(db, ctx, {
      jobId: job.jobId,
      vendorId: supplyHouse,
      amountCents: 10_000n,
      taxCents: 830n,
      description: 'Trim and hardware',
      purchasedAt: utc(2026, 4, 13),
    });

    const costing = await jobCosting(db, ctx, job.jobId);
    expect(costing.materialCents).toBe(10_830n);
  });

  it('posts subcontracted work to its own account, not to materials', async () => {
    const job = await createTestJob(org.organizationId, org.locationId);
    await recordJobPurchase(db, ctx, {
      jobId: job.jobId,
      vendorId: subcontractor,
      amountCents: 65_000n,
      description: 'Shower tile',
      isSubcontract: true,
      purchasedAt: utc(2026, 4, 14),
    });

    const costing = await jobCosting(db, ctx, job.jobId);
    expect(costing.subcontractorCents).toBe(65_000n);
    expect(costing.materialCents).toBe(0n);
  });

  it('refuses a purchase against a closed job', async () => {
    const job = await createTestJob(org.organizationId, org.locationId);
    await db.job.update({ where: { id: job.jobId }, data: { status: 'CLOSED' } });

    await expect(
      recordJobPurchase(db, ctx, {
        jobId: job.jobId,
        vendorId: supplyHouse,
        amountCents: 100n,
        description: 'Too late',
      }),
    ).rejects.toThrow(/is CLOSED/);
  });

  it('refuses a vendor from another organization', async () => {
    const other = await createTestOrg('Other Vendor Co');
    const foreign = await db.vendor.create({
      data: { organizationId: other.organizationId, vendorNo: 'V-9999', name: 'Not ours' },
    });
    const job = await createTestJob(org.organizationId, org.locationId);

    await expect(
      recordJobPurchase(db, ctx, {
        jobId: job.jobId,
        vendorId: foreign.id,
        amountCents: 100n,
        description: 'Cross-tenant',
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('paying bills', () => {
  it('clears payables that are due and leaves the rest', async () => {
    const payOrg = await createTestOrg('Payables');
    const payCtx = systemContext(payOrg.organizationId);
    const vendor = await db.vendor.create({
      data: {
        organizationId: payOrg.organizationId,
        vendorNo: 'V-0001',
        name: 'Valley Hardware',
        paymentTermsDays: 15,
      },
    });

    const dueJob = await createTestJob(payOrg.organizationId, payOrg.locationId);
    const laterJob = await createTestJob(payOrg.organizationId, payOrg.locationId);

    await recordJobPurchase(db, payCtx, {
      jobId: dueJob.jobId,
      vendorId: vendor.id,
      amountCents: 30_000n,
      description: 'Due already',
      purchasedAt: utc(2026, 5, 1),
    });
    await recordJobPurchase(db, payCtx, {
      jobId: laterJob.jobId,
      vendorId: vendor.id,
      amountCents: 20_000n,
      description: 'Not due yet',
      purchasedAt: utc(2026, 5, 25),
    });

    const run = await payOpenBills(db, payCtx, { throughDate: utc(2026, 5, 31) });
    expect(run.paidCount).toBe(1);
    expect(run.totalCents).toBe(30_000n);

    const tb = await trialBalance(db, payCtx, { to: utc(2026, 5, 31) });
    // The paid bill is gone from AP; the one not yet due remains.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AP)!.balanceCents).toBe(20_000n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.BANK_OPERATING)!.balanceCents).toBe(-30_000n);
    expect(tb.isBalanced).toBe(true);

    const remaining = await db.vendorBill.findMany({
      where: { organizationId: payOrg.organizationId },
      orderBy: { billDate: 'asc' },
    });
    expect(remaining[0].status).toBe('PAID');
    expect(remaining[1].status).toBe('OPEN');
  });

  it('does nothing when there is nothing due', async () => {
    const quietOrg = await createTestOrg('NothingDue');
    const run = await payOpenBills(db, systemContext(quietOrg.organizationId), {
      throughDate: utc(2026, 5, 31),
    });
    expect(run.paidCount).toBe(0);
    expect(run.journalEntryId).toBeNull();
  });
});
