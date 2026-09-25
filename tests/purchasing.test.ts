import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { trialBalance } from '../src/lib/accounting/reports';
import { closePeriod, findPeriodFor } from '../src/lib/accounting/periods';
import { jobCosting } from '../src/lib/jobs/costing';
import { payOpenBills, recordJobPurchase } from '../src/lib/purchasing/service';
import { openBills } from '../src/lib/purchasing/reports';
import {
  createPurchaseOrder,
  draftOrdersFromReorder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from '../src/lib/purchasing/orders';
import {
  createPriceBookItem,
  createStockLocation,
  createTestJob,
  createTestOrg,
  utc,
  type TestOrg,
} from './factory';

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

  it('writes a payment record against each bill it settles', async () => {
    const org = await createTestOrg('PayRecords');
    const ctx = systemContext(org.organizationId);
    const vendor = await db.vendor.create({
      data: {
        organizationId: org.organizationId,
        vendorNo: 'V-0001',
        name: 'Copper State Supply',
        paymentTermsDays: 15,
      },
    });

    const job = await createTestJob(org.organizationId, org.locationId);
    await recordJobPurchase(db, ctx, {
      jobId: job.jobId,
      vendorId: vendor.id,
      amountCents: 42_000n,
      description: 'Special-order parts',
      purchasedAt: utc(2026, 6, 1),
    });

    // Paid on the 20th, clearing everything due by the 30th: the ledger records the day
    // the money left, not the cutoff the run was drawn up against.
    const run = await payOpenBills(db, ctx, {
      throughDate: utc(2026, 6, 30),
      paidAt: utc(2026, 6, 20),
      method: 'CHECK',
      reference: '20418',
    });

    expect(run.paidCount).toBe(1);
    expect(run.bills[0].paymentNo).toMatch(/^BP-\d{5}$/);
    expect(run.bills[0].vendorName).toBe('Copper State Supply');

    const payment = await db.billPayment.findFirstOrThrow({
      where: { organizationId: org.organizationId },
      include: { vendorBill: true, bankAccount: true },
    });
    expect(payment.amountCents).toBe(42_000n);
    expect(payment.method).toBe('CHECK');
    expect(payment.reference).toBe('20418');
    expect(payment.bankAccount.code).toBe(ACCOUNTS.BANK_OPERATING);
    expect(payment.paidAt.toISOString().slice(0, 10)).toBe('2026-06-20');
    // The bank line and the bills it covers point at the same posting.
    expect(payment.journalEntryId).toBe(run.journalEntryId);
    expect(payment.vendorBill.status).toBe('PAID');

    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: run.journalEntryId! } });
    expect(entry.entryDate.toISOString().slice(0, 10)).toBe('2026-06-20');
  });

  it('pays a named bill early and leaves the others alone', async () => {
    const org = await createTestOrg('PaySelected');
    const ctx = systemContext(org.organizationId);
    const vendor = await db.vendor.create({
      data: {
        organizationId: org.organizationId,
        vendorNo: 'V-0001',
        name: 'Sunbelt Electrical',
        paymentTermsDays: 30,
      },
    });

    const first = await createTestJob(org.organizationId, org.locationId);
    const second = await createTestJob(org.organizationId, org.locationId);

    for (const [job, amount] of [
      [first, 18_000n],
      [second, 9_000n],
    ] as const) {
      await recordJobPurchase(db, ctx, {
        jobId: job.jobId,
        vendorId: vendor.id,
        amountCents: amount,
        description: 'Materials',
        purchasedAt: utc(2026, 7, 1),
      });
    }

    const bills = await db.vendorBill.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { totalCents: 'desc' },
    });

    // Nothing is due for a month, and this one is being settled anyway — an early
    // settlement discount, or a supplier who will not load the van until it is paid.
    const run = await payOpenBills(db, ctx, {
      billIds: [bills[0].id],
      paidAt: utc(2026, 7, 3),
    });

    expect(run.paidCount).toBe(1);
    expect(run.totalCents).toBe(18_000n);

    const after = await db.vendorBill.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { totalCents: 'desc' },
    });
    expect(after[0].status).toBe('PAID');
    expect(after[1].status).toBe('OPEN');

    const tb = await trialBalance(db, ctx, { to: utc(2026, 7, 31) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AP)!.balanceCents).toBe(9_000n);
    expect(tb.isBalanced).toBe(true);

    // Paying it again is refused rather than quietly paying nothing, because two people
    // on the same afternoon is exactly how a supplier gets paid twice.
    await expect(
      payOpenBills(db, ctx, { billIds: [bills[0].id], paidAt: utc(2026, 7, 4) }),
    ).rejects.toThrow(/no longer open/);
  });

  it('shows what is owed and how late it is', async () => {
    const org = await createTestOrg('PayablesReport');
    const ctx = systemContext(org.organizationId);
    const vendor = await db.vendor.create({
      data: {
        organizationId: org.organizationId,
        vendorNo: 'V-0001',
        name: 'Desert Builders Wholesale',
        paymentTermsDays: 30,
        is1099Vendor: false,
      },
    });

    const late = await createTestJob(org.organizationId, org.locationId);
    const soon = await createTestJob(org.organizationId, org.locationId);

    await recordJobPurchase(db, ctx, {
      jobId: late.jobId,
      vendorId: vendor.id,
      amountCents: 25_000n,
      description: 'Drywall',
      purchasedAt: utc(2026, 4, 1),
    });
    await recordJobPurchase(db, ctx, {
      jobId: soon.jobId,
      vendorId: vendor.id,
      amountCents: 15_000n,
      description: 'Paint',
      purchasedAt: utc(2026, 5, 20),
    });

    // Standing on 8 June: the April bill was due on 1 May, the May one on 19 June.
    const report = await openBills(db, ctx, utc(2026, 6, 8));

    expect(report.totalCents).toBe(40_000n);
    expect(report.overdueCents).toBe(25_000n);
    expect(report.dueThisWeekCents).toBe(0n);
    expect(report.laterCents).toBe(15_000n);

    // Oldest due first, and the job each cost was coded to comes with it.
    expect(report.bills[0].daysOverdue).toBe(38);
    expect(report.bills[0].jobNo).toBeTruthy();
    expect(report.bills[1].daysOverdue).toBe(-11);
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

describe('purchase orders', () => {
  let poOrg: TestOrg;
  let poCtx: AuthContext;
  let vendorId: string;
  let otherVendorId: string;
  let warehouse: string;
  let valve: string;
  let breaker: string;

  beforeAll(async () => {
    poOrg = await createTestOrg('Ordering');
    poCtx = systemContext(poOrg.organizationId);

    [vendorId, otherVendorId] = await Promise.all(
      [
        { vendorNo: 'V-0001', name: 'Copper State Supply', paymentTermsDays: 30 },
        { vendorNo: 'V-0002', name: 'Desert Electric Wholesale', paymentTermsDays: 15 },
      ].map(async (data) =>
        (await db.vendor.create({ data: { organizationId: poOrg.organizationId, ...data } })).id,
      ),
    );

    warehouse = await createStockLocation(poOrg.organizationId, {
      kind: 'WAREHOUSE',
      code: 'WH-PO',
      locationId: poOrg.locationId,
    });

    valve = await createPriceBookItem(poOrg.organizationId, {
      sku: 'PL-VALVE',
      name: 'Ball valve 3/4"',
      category: 'MATERIAL',
      costCents: 800n,
      priceCents: 2400n,
    });
    breaker = await createPriceBookItem(poOrg.organizationId, {
      sku: 'EL-BRK20',
      name: '20A breaker',
      category: 'MATERIAL',
      costCents: 1_250n,
      priceCents: 3_900n,
    });
  });

  it('prices its lines from the price book and orders nothing until submitted', async () => {
    const order = await createPurchaseOrder(db, poCtx, {
      vendorId,
      receiveToStockLocationId: warehouse,
      lines: [
        { priceBookItemId: valve, quantity: '10' },
        { priceBookItemId: breaker, quantity: '4', unitCostCents: 1_100n },
      ],
      createdAt: utc(2026, 6, 1),
    });

    expect(order.poNo).toMatch(/^PO-\d{5}$/);
    expect(order.status).toBe('DRAFT');
    // 10 × $8.00, plus 4 × the $11.00 actually quoted rather than the book's $12.50.
    expect(order.totalCents).toBe(8_000n + 4_400n);

    const tb = await trialBalance(db, poCtx, { to: utc(2026, 6, 30) });
    // Ordering something is a commitment, not a cost. Nothing has posted.
    expect(tb.rows.length).toBe(0);

    const submitted = await submitPurchaseOrder(db, poCtx, order.id, { at: utc(2026, 6, 1) });
    expect(submitted.status).toBe('SUBMITTED');
    await expect(submitPurchaseOrder(db, poCtx, order.id)).rejects.toThrow(/already SUBMITTED/);
  });

  it('refuses to order an item the price book has no cost for', async () => {
    const freebie = await createPriceBookItem(poOrg.organizationId, {
      name: 'Uncosted gasket',
      category: 'MATERIAL',
      costCents: 0n,
      priceCents: 500n,
    });

    await expect(
      createPurchaseOrder(db, poCtx, {
        vendorId,
        receiveToStockLocationId: warehouse,
        lines: [{ priceBookItemId: freebie, quantity: '5' }],
      }),
    ).rejects.toThrow(/no cost on the price book/);

    await expect(
      createPurchaseOrder(db, poCtx, { vendorId, receiveToStockLocationId: warehouse, lines: [] }),
    ).rejects.toThrow(/needs a line/);
  });

  it('receiving puts the stock on the shelf and the money in payables, once', async () => {
    const order = await createPurchaseOrder(db, poCtx, {
      vendorId,
      receiveToStockLocationId: warehouse,
      lines: [{ priceBookItemId: valve, quantity: '20', unitCostCents: 900n }],
      createdAt: utc(2026, 7, 1),
    });
    await submitPurchaseOrder(db, poCtx, order.id, { at: utc(2026, 7, 1) });

    const receipt = await receivePurchaseOrder(db, poCtx, order.id, {
      vendorInvoiceNo: 'CS-99120',
      receivedAt: utc(2026, 7, 3),
    });

    expect(receipt.order.status).toBe('RECEIVED');
    expect(receipt.totalCostCents).toBe(18_000n);

    const level = await db.stockLevel.findFirstOrThrow({
      where: { stockLocationId: warehouse, priceBookItemId: valve },
    });
    expect(Number(level.quantity)).toBe(20);

    const bill = await db.vendorBill.findUniqueOrThrow({ where: { id: receipt.billId } });
    expect(bill.vendorInvoiceNo).toBe('CS-99120');
    expect(bill.totalCents).toBe(18_000n);
    // The bill hangs off the posting the receipt made — one entry, not two, so the
    // document and the ledger can never disagree about the amount.
    expect(bill.journalEntryId).toBe(receipt.journalEntryId);
    expect(bill.dueDate?.toISOString().slice(0, 10)).toBe('2026-08-02');

    const tb = await trialBalance(db, poCtx, { to: utc(2026, 7, 31) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_WAREHOUSE)!.balanceCents).toBe(
      18_000n,
    );
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AP)!.balanceCents).toBe(18_000n);
    expect(tb.isBalanced).toBe(true);

    await expect(receivePurchaseOrder(db, poCtx, order.id)).rejects.toThrow(
      /already been received/,
    );
  });

  it('takes a short delivery and leaves the rest outstanding', async () => {
    const order = await createPurchaseOrder(db, poCtx, {
      vendorId: otherVendorId,
      receiveToStockLocationId: warehouse,
      lines: [{ priceBookItemId: breaker, quantity: '12', unitCostCents: 1_000n }],
      createdAt: utc(2026, 8, 1),
    });
    await submitPurchaseOrder(db, poCtx, order.id, { at: utc(2026, 8, 1) });
    const lineId = order.lines[0].id;

    await expect(
      receivePurchaseOrder(db, poCtx, order.id, {
        lines: [{ purchaseOrderLineId: lineId, quantity: '15' }],
      }),
    ).rejects.toThrow(/more than the 12 still outstanding/);

    const first = await receivePurchaseOrder(db, poCtx, order.id, {
      lines: [{ purchaseOrderLineId: lineId, quantity: '5' }],
      receivedAt: utc(2026, 8, 4),
    });
    expect(first.order.status).toBe('PARTIALLY_RECEIVED');
    expect(first.order.receivedAt).toBeNull();
    expect(first.totalCostCents).toBe(5_000n);

    // The rest arrives a week later: omitting lines takes whatever is still outstanding.
    const second = await receivePurchaseOrder(db, poCtx, order.id, {
      receivedAt: utc(2026, 8, 11),
    });
    expect(second.order.status).toBe('RECEIVED');
    expect(second.totalCostCents).toBe(7_000n);

    // Two deliveries, two bills — the vendor invoices what it actually sent.
    const bills = await db.vendorBill.findMany({ where: { purchaseOrderId: order.id } });
    expect(bills.length).toBe(2);
  });

  it('gives the claim back when the posting is refused', async () => {
    const lockedOrg = await createTestOrg('OrderingLocked');
    const lockedCtx = systemContext(lockedOrg.organizationId);

    const supplier = (
      await db.vendor.create({
        data: {
          organizationId: lockedOrg.organizationId,
          vendorNo: 'V-0001',
          name: 'Copper State Supply',
          paymentTermsDays: 30,
        },
      })
    ).id;
    const shelf = await createStockLocation(lockedOrg.organizationId, {
      kind: 'WAREHOUSE',
      code: 'WH-LOCK',
      locationId: lockedOrg.locationId,
    });
    const part = await createPriceBookItem(lockedOrg.organizationId, {
      name: 'Angle stop',
      category: 'MATERIAL',
      costCents: 1_150n,
      priceCents: 3_800n,
    });

    const order = await createPurchaseOrder(db, lockedCtx, {
      vendorId: supplier,
      receiveToStockLocationId: shelf,
      lines: [{ priceBookItemId: part, quantity: '8' }],
      createdAt: utc(2025, 1, 5),
    });
    await submitPurchaseOrder(db, lockedCtx, order.id, { at: utc(2025, 1, 5) });

    // January is the first period of the fiscal year, so nothing precedes it.
    const january = await findPeriodFor(db, lockedOrg.organizationId, utc(2025, 1, 15));
    await closePeriod(db, lockedCtx, january!.id);

    await expect(
      receivePurchaseOrder(db, lockedCtx, order.id, { receivedAt: utc(2025, 1, 20) }),
    ).rejects.toThrow(/period is CLOSED/);

    // The order is exactly as it was: nothing received, nothing owed, nothing on the shelf.
    const after = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true, bills: true },
    });
    expect(after.status).toBe('SUBMITTED');
    expect(after.receivedAt).toBeNull();
    expect(Number(after.lines[0].receivedQty)).toBe(0);
    expect(after.bills.length).toBe(0);

    const level = await db.stockLevel.findFirst({
      where: { stockLocationId: shelf, priceBookItemId: part },
    });
    expect(level === null || Number(level.quantity) === 0).toBe(true);

    // And it still receives once the month it belongs to is open.
    const received = await receivePurchaseOrder(db, lockedCtx, order.id, {
      receivedAt: utc(2025, 2, 3),
    });
    expect(received.order.status).toBe('RECEIVED');
    expect(received.totalCostCents).toBe(9_200n);
  });

  it('drafts one order per vendor per stock location, and leaves orphans out', async () => {
    const draftOrg = await createTestOrg('Reordering');
    const draftCtx = systemContext(draftOrg.organizationId);

    const plumbing = (
      await db.vendor.create({
        data: {
          organizationId: draftOrg.organizationId,
          vendorNo: 'V-0001',
          name: 'Copper State Supply',
          paymentTermsDays: 30,
        },
      })
    ).id;
    const electrical = (
      await db.vendor.create({
        data: {
          organizationId: draftOrg.organizationId,
          vendorNo: 'V-0002',
          name: 'Desert Electric Wholesale',
          paymentTermsDays: 15,
        },
      })
    ).id;

    const shop = await createStockLocation(draftOrg.organizationId, {
      kind: 'WAREHOUSE',
      code: 'WH-1',
      locationId: draftOrg.locationId,
    });
    const van = await createStockLocation(draftOrg.organizationId, {
      kind: 'VAN',
      code: 'VAN-1',
      locationId: draftOrg.locationId,
    });

    const stocked = async (name: string, preferredVendorId: string | null) => {
      const id = await createPriceBookItem(draftOrg.organizationId, {
        name,
        category: 'MATERIAL',
        costCents: 900n,
        priceCents: 2_700n,
      });
      await db.priceBookItem.update({
        where: { id },
        data: { preferredVendorId, reorderPoint: '10', reorderQty: '24' },
      });
      return id;
    };

    const pipe = await stocked('Copper pipe 3/4"', plumbing);
    const wire = await stocked('12/2 romex', electrical);
    const orphan = await stocked('Shop-made bracket', null);

    for (const stockLocationId of [shop, van]) {
      for (const priceBookItemId of [pipe, wire, orphan]) {
        await db.stockLevel.create({
          data: {
            stockLocationId,
            priceBookItemId,
            quantity: '2',
            valueCents: 1_800n,
            avgCostCents: 900n,
          },
        });
      }
    }

    const { drafts, unassigned } = await draftOrdersFromReorder(db, draftCtx);

    // Two vendors × two places to receive into: four orders, never one big one.
    expect(drafts.length).toBe(4);
    for (const draft of drafts) {
      expect(draft.lines.length).toBe(1);
      expect(draft.lines[0].quantity).toBe('24');
    }
    expect(new Set(drafts.map((d) => d.stockLocationCode))).toEqual(new Set(['WH-1', 'VAN-1']));
    expect(new Set(drafts.map((d) => d.vendorName))).toEqual(
      new Set(['Copper State Supply', 'Desert Electric Wholesale']),
    );

    // A part with nobody to buy it from is reported, not guessed at.
    expect(unassigned.map((u) => u.name)).toEqual(['Shop-made bracket', 'Shop-made bracket']);

    // Filtering to one shelf drafts only that shelf's orders.
    const vanOnly = await draftOrdersFromReorder(db, draftCtx, { stockLocationId: van });
    expect(vanOnly.drafts.length).toBe(2);
  });
});
