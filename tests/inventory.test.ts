import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { scopedDb } from '../src/lib/auth/scoped-db';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { trialBalance } from '../src/lib/accounting/reports';
import { jobCosting } from '../src/lib/jobs/costing';
import {
  consumePartsForJob,
  ensureVanStockLocation,
  receiveStock,
  transferStock,
} from '../src/lib/inventory/service';
import { openCycleCount, postCycleCount } from '../src/lib/inventory/counts';
import {
  inventoryValuation,
  itemMovements,
  negativeStock,
  reorderSuggestions,
  stockOnHand,
  valuationAgainstLedger,
} from '../src/lib/inventory/reports';
import {
  createPriceBookItem,
  createStockLocation,
  createTestJob,
  createTestOrg,
  createTestTechnician,
  createTestUser,
  utc,
  type TestOrg,
} from './factory';

let org: TestOrg;
let ctx: AuthContext;

beforeAll(async () => {
  org = await createTestOrg('Inventory');
  ctx = systemContext(org.organizationId);
});

afterAll(async () => {
  await db.$disconnect();
});

async function stockLevel(stockLocationId: string, priceBookItemId: string) {
  return db.stockLevel.findFirstOrThrow({ where: { stockLocationId, priceBookItemId } });
}

describe('moving average cost', () => {
  it('blends two receipts at different prices', async () => {
    const warehouse = await createStockLocation(org.organizationId, {
      kind: 'WAREHOUSE',
      locationId: org.locationId,
    });
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Ball valve',
      category: 'MATERIAL',
      costCents: 800n,
      priceCents: 2400n,
    });

    await receiveStock(db, ctx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 800n }],
      occurredAt: utc(2026, 3, 1),
    });
    await receiveStock(db, ctx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 1200n }],
      occurredAt: utc(2026, 3, 2),
    });

    const level = await stockLevel(warehouse, item);
    expect(level.quantity.toString()).toBe('20');
    // 10 x 8.00 + 10 x 12.00 = 200.00 over 20 units = 10.00 average.
    expect(level.valueCents).toBe(20000n);
    expect(level.avgCostCents).toBe(1000n);
  });

  it('survives concurrent receipts without losing one of them', async () => {
    const warehouse = await createStockLocation(org.organizationId, {
      kind: 'WAREHOUSE',
      locationId: org.locationId,
    });
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Drywall screw box',
      category: 'MATERIAL',
      costCents: 500n,
      priceCents: 1200n,
    });

    // A moving average is a read-modify-write; without the row lock these interleave and
    // the value silently stops matching what was paid.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        receiveStock(db, ctx, {
          stockLocationId: warehouse,
          lines: [{ priceBookItemId: item, quantity: '5', unitCostCents: 500n }],
          occurredAt: utc(2026, 3, 3),
        }),
      ),
    );

    const level = await stockLevel(warehouse, item);
    expect(level.quantity.toString()).toBe('40');
    expect(level.valueCents).toBe(20000n); // 40 x 5.00, none lost
    expect(level.avgCostCents).toBe(500n);
  });

  it('relieves exactly the remaining value when a bin is emptied, so nothing drifts', async () => {
    const warehouse = await createStockLocation(org.organizationId, {
      kind: 'WAREHOUSE',
      locationId: org.locationId,
    });
    const van = await createStockLocation(org.organizationId, {
      kind: 'VAN',
      locationId: org.locationId,
    });
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Odd-priced widget',
      category: 'MATERIAL',
      costCents: 333n,
      priceCents: 999n,
    });

    // 3 units at 3.33 each = 10.00, an average that does not divide evenly.
    await receiveStock(db, ctx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '3', unitCostCents: 333n }],
      occurredAt: utc(2026, 3, 4),
    });

    await transferStock(db, ctx, {
      fromStockLocationId: warehouse,
      toStockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '3' }],
      occurredAt: utc(2026, 3, 4),
    });

    const source = await stockLevel(warehouse, item);
    const destination = await stockLevel(van, item);

    expect(source.quantity.toString()).toBe('0');
    expect(source.valueCents).toBe(0n); // exactly empty, not 1 cent adrift
    expect(destination.valueCents).toBe(999n);
  });
});

describe('transfers', () => {
  it('moves value from warehouse to van without touching the income statement', async () => {
    const transferOrg = await createTestOrg('Transfer');
    const transferCtx = systemContext(transferOrg.organizationId);
    const warehouse = await createStockLocation(transferOrg.organizationId, {
      kind: 'WAREHOUSE',
      locationId: transferOrg.locationId,
    });
    const van = await createStockLocation(transferOrg.organizationId, {
      kind: 'VAN',
      locationId: transferOrg.locationId,
    });
    const item = await createPriceBookItem(transferOrg.organizationId, {
      name: 'Wax ring kit',
      category: 'MATERIAL',
      costCents: 420n,
      priceCents: 1800n,
    });

    await receiveStock(db, transferCtx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '50', unitCostCents: 420n }],
      occurredAt: utc(2026, 4, 1),
    });
    await transferStock(db, transferCtx, {
      fromStockLocationId: warehouse,
      toStockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '12' }],
      occurredAt: utc(2026, 4, 2),
    });

    const tb = await trialBalance(db, transferCtx, { to: utc(2026, 4, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_WAREHOUSE)!.balanceCents).toBe(15960n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)!.balanceCents).toBe(5040n);
    // Nothing became an expense by being driven across town.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.COGS_MATERIALS)).toBeUndefined();
    expect(tb.isBalanced).toBe(true);
  });

  it('refuses a transfer to the same location', async () => {
    const warehouse = await createStockLocation(org.organizationId, { kind: 'WAREHOUSE' });
    await expect(
      transferStock(db, ctx, {
        fromStockLocationId: warehouse,
        toStockLocationId: warehouse,
        lines: [],
      }),
    ).rejects.toThrow(/same stock location/);
  });
});

describe('consumption on a job', () => {
  it('moves van stock to COGS and shows up in job costing', async () => {
    const jobOrg = await createTestOrg('Consume');
    const jobCtx = systemContext(jobOrg.organizationId);
    const tech = await createTestTechnician(jobOrg.organizationId, jobOrg.locationId);
    const van = await ensureVanStockLocation(db, jobCtx, tech.technicianId, jobOrg.locationId);
    const warehouse = await createStockLocation(jobOrg.organizationId, {
      kind: 'WAREHOUSE',
      locationId: jobOrg.locationId,
    });
    const item = await createPriceBookItem(jobOrg.organizationId, {
      name: 'Wax ring kit',
      category: 'MATERIAL',
      costCents: 420n,
      priceCents: 1800n,
    });
    const job = await createTestJob(jobOrg.organizationId, jobOrg.locationId);

    await receiveStock(db, jobCtx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '20', unitCostCents: 420n }],
      occurredAt: utc(2026, 5, 1),
    });
    await transferStock(db, jobCtx, {
      fromStockLocationId: warehouse,
      toStockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '6' }],
      occurredAt: utc(2026, 5, 2),
    });

    const consumed = await consumePartsForJob(db, jobCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '3' }],
      occurredAt: utc(2026, 5, 3),
      technicianId: tech.technicianId,
    });

    expect(consumed.totalCostCents).toBe(1260n);

    const level = await stockLevel(van, item);
    expect(level.quantity.toString()).toBe('3');
    expect(level.valueCents).toBe(1260n);

    const costing = await jobCosting(db, jobCtx, job.jobId);
    expect(costing.materialCents).toBe(1260n);
    expect(costing.totalCostCents).toBe(1260n);

    const tb = await trialBalance(db, jobCtx, { to: utc(2026, 5, 31) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.COGS_MATERIALS)!.balanceCents).toBe(1260n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)!.balanceCents).toBe(1260n);
    expect(tb.isBalanced).toBe(true);
  });

  it('names the technician van, so a van is a place and a person', async () => {
    const tech = await createTestTechnician(org.organizationId, org.locationId);
    const van = await ensureVanStockLocation(db, ctx, tech.technicianId, org.locationId);
    const again = await ensureVanStockLocation(db, ctx, tech.technicianId, org.locationId);

    expect(again).toBe(van);
    const record = await db.stockLocation.findUniqueOrThrow({ where: { id: van } });
    expect(record.kind).toBe('VAN');
    expect(record.technicianId).toBe(tech.technicianId);
    expect(record.name).toContain('van');
  });

  it('still costs a part consumed from an empty van, and reports the negative', async () => {
    const negOrg = await createTestOrg('Negative');
    const negCtx = systemContext(negOrg.organizationId);
    const van = await createStockLocation(negOrg.organizationId, {
      kind: 'VAN',
      locationId: negOrg.locationId,
    });
    const item = await createPriceBookItem(negOrg.organizationId, {
      name: 'Untracked fitting',
      category: 'MATERIAL',
      costCents: 650n,
      priceCents: 1900n,
    });
    const job = await createTestJob(negOrg.organizationId, negOrg.locationId);

    // Nothing was ever received into this van; the technician used it anyway.
    const consumed = await consumePartsForJob(db, negCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '2' }],
      occurredAt: utc(2026, 6, 1),
    });

    // Falls back to standard cost so the job still carries a defensible material cost.
    expect(consumed.totalCostCents).toBe(1300n);

    const negatives = await negativeStock(db, negCtx);
    expect(negatives.count).toBe(1);
    expect(negatives.rows[0].quantity.toString()).toBe('-2');
  });

  it('refuses to book parts to a closed job', async () => {
    const van = await createStockLocation(org.organizationId, {
      kind: 'VAN',
      locationId: org.locationId,
    });
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Closed job part',
      category: 'MATERIAL',
      costCents: 100n,
      priceCents: 300n,
    });
    const job = await createTestJob(org.organizationId, org.locationId);
    await db.job.update({ where: { id: job.jobId }, data: { status: 'CLOSED' } });

    await expect(
      consumePartsForJob(db, ctx, {
        jobId: job.jobId,
        stockLocationId: van,
        lines: [{ priceBookItemId: item, quantity: '1' }],
      }),
    ).rejects.toThrow(/is CLOSED/);
  });
});

describe('cycle counts', () => {
  it('posts a shortage to shrinkage and corrects the stock', async () => {
    const countOrg = await createTestOrg('Count');
    const countCtx = systemContext(countOrg.organizationId);
    const van = await createStockLocation(countOrg.organizationId, {
      kind: 'VAN',
      locationId: countOrg.locationId,
    });
    const item = await createPriceBookItem(countOrg.organizationId, {
      name: 'Copper coupling',
      category: 'MATERIAL',
      costCents: 250n,
      priceCents: 900n,
    });

    await receiveStock(db, countCtx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '40', unitCostCents: 250n }],
      occurredAt: utc(2026, 7, 1),
    });

    const count = await openCycleCount(db, countCtx, van);
    expect(count.lines).toHaveLength(1);
    expect(count.lines[0].expectedQty.toString()).toBe('40');

    // Only 34 are actually on the truck.
    const posted = await postCycleCount(
      db,
      countCtx,
      count.id,
      [{ priceBookItemId: item, countedQuantity: '34' }],
      { occurredAt: utc(2026, 7, 20) },
    );

    expect(posted.varianceCents).toBe(-1500n); // 6 missing at 2.50

    const level = await stockLevel(van, item);
    expect(level.quantity.toString()).toBe('34');
    expect(level.valueCents).toBe(8500n);
    expect(level.avgCostCents).toBe(250n);

    const tb = await trialBalance(db, countCtx, { to: utc(2026, 7, 31) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_SHRINKAGE)!.balanceCents).toBe(1500n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)!.balanceCents).toBe(8500n);
    expect(tb.isBalanced).toBe(true);
  });

  it('posts an overage the other way', async () => {
    const overOrg = await createTestOrg('Overage');
    const overCtx = systemContext(overOrg.organizationId);
    const van = await createStockLocation(overOrg.organizationId, {
      kind: 'VAN',
      locationId: overOrg.locationId,
    });
    const item = await createPriceBookItem(overOrg.organizationId, {
      name: 'PVC elbow',
      category: 'MATERIAL',
      costCents: 120n,
      priceCents: 500n,
    });

    await receiveStock(db, overCtx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 120n }],
      occurredAt: utc(2026, 7, 5),
    });

    const count = await openCycleCount(db, overCtx, van);
    const posted = await postCycleCount(
      db,
      overCtx,
      count.id,
      [{ priceBookItemId: item, countedQuantity: '13' }],
      { occurredAt: utc(2026, 7, 20) },
    );

    expect(posted.varianceCents).toBe(360n);
    const level = await stockLevel(van, item);
    expect(level.quantity.toString()).toBe('13');
    expect(level.valueCents).toBe(1560n);
  });

  it('refuses to post a count twice', async () => {
    const van = await createStockLocation(org.organizationId, {
      kind: 'VAN',
      locationId: org.locationId,
    });
    const count = await openCycleCount(db, ctx, van);
    await postCycleCount(db, ctx, count.id, []);
    await expect(postCycleCount(db, ctx, count.id, [])).rejects.toThrow(/already been posted/);
  });

  it('re-reads expected quantity at post time, not at open time', async () => {
    const raceOrg = await createTestOrg('CountRace');
    const raceCtx = systemContext(raceOrg.organizationId);
    const van = await createStockLocation(raceOrg.organizationId, {
      kind: 'VAN',
      locationId: raceOrg.locationId,
    });
    const item = await createPriceBookItem(raceOrg.organizationId, {
      name: 'Sealant tube',
      category: 'MATERIAL',
      costCents: 700n,
      priceCents: 1800n,
    });
    const job = await createTestJob(raceOrg.organizationId, raceOrg.locationId);

    await receiveStock(db, raceCtx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 700n }],
      occurredAt: utc(2026, 8, 1),
    });

    const count = await openCycleCount(db, raceCtx, van);

    // A job consumes 2 while the technician is still counting the shelf.
    await consumePartsForJob(db, raceCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '2' }],
      occurredAt: utc(2026, 8, 1),
    });

    // They counted 8, which is now correct — there is no variance to post.
    const posted = await postCycleCount(
      db,
      raceCtx,
      count.id,
      [{ priceBookItemId: item, countedQuantity: '8' }],
      { occurredAt: utc(2026, 8, 20) },
    );

    expect(posted.varianceCents).toBe(0n);
    expect(posted.journalEntryId).toBeNull();
  });
});

describe('inventory reporting', () => {
  it('valuation equals the inventory balance in the general ledger', async () => {
    const valueOrg = await createTestOrg('Valuation');
    const valueCtx = systemContext(valueOrg.organizationId);
    const warehouse = await createStockLocation(valueOrg.organizationId, {
      kind: 'WAREHOUSE',
      locationId: valueOrg.locationId,
    });
    const van = await createStockLocation(valueOrg.organizationId, {
      kind: 'VAN',
      locationId: valueOrg.locationId,
    });
    const job = await createTestJob(valueOrg.organizationId, valueOrg.locationId);

    const itemA = await createPriceBookItem(valueOrg.organizationId, {
      name: 'Item A',
      category: 'MATERIAL',
      costCents: 777n,
      priceCents: 2000n,
    });
    const itemB = await createPriceBookItem(valueOrg.organizationId, {
      name: 'Item B',
      category: 'MATERIAL',
      costCents: 1333n,
      priceCents: 4000n,
    });

    await receiveStock(db, valueCtx, {
      stockLocationId: warehouse,
      lines: [
        { priceBookItemId: itemA, quantity: '7', unitCostCents: 777n },
        { priceBookItemId: itemB, quantity: '3', unitCostCents: 1333n },
      ],
      occurredAt: utc(2026, 9, 1),
    });
    await transferStock(db, valueCtx, {
      fromStockLocationId: warehouse,
      toStockLocationId: van,
      lines: [{ priceBookItemId: itemA, quantity: '2' }],
      occurredAt: utc(2026, 9, 2),
    });
    await consumePartsForJob(db, valueCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: itemA, quantity: '1' }],
      occurredAt: utc(2026, 9, 3),
    });

    const valuation = await inventoryValuation(db, valueCtx);
    const tb = await trialBalance(db, valueCtx, { to: utc(2026, 9, 30) });

    const glInventory =
      (tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_WAREHOUSE)?.balanceCents ?? 0n) +
      (tb.rows.find((r) => r.code === ACCOUNTS.INVENTORY_VAN)?.balanceCents ?? 0n);

    // The subledger and the general ledger agree to the penny. If they ever do not, one
    // of the two is wrong and nobody can tell which.
    expect(valuation.totalCents).toBe(glInventory);
    expect(tb.isBalanced).toBe(true);

    /*
     * And the comparison is a report rather than a thing a test knows.
     *
     * The inventory screen leads with it, so it has to be computed the same way the books
     * are — and it has to be able to fail. A reconciliation that can only ever say "fine"
     * tells a controller nothing, so the shape below is asserted as well as the verdict.
     */
    const reconciliation = await valuationAgainstLedger(db, valueCtx, utc(2026, 9, 30));
    expect(reconciliation.ties).toBe(true);
    expect(reconciliation.subledgerCents).toBe(valuation.totalCents);
    expect(reconciliation.ledgerCents).toBe(glInventory);
    expect(reconciliation.differenceCents).toBe(0n);
    // It names the accounts it compared against, so the figure can be drilled rather than
    // taken on faith.
    expect(reconciliation.accounts.map((account) => account.code).sort()).toEqual([
      ACCOUNTS.INVENTORY_WAREHOUSE,
      ACCOUNTS.INVENTORY_VAN,
    ]);
    expect(reconciliation.accounts.every((account) => account.accountId.length > 0)).toBe(true);
  });

  it('lists what one van is carrying, dearest first, and flags what it is short of', async () => {
    const shelfOrg = await createTestOrg('Shelf');
    const shelfCtx = systemContext(shelfOrg.organizationId);
    const van = await createStockLocation(shelfOrg.organizationId, {
      kind: 'VAN',
      locationId: shelfOrg.locationId,
      code: 'VAN-099',
    });

    const cheap = await createPriceBookItem(shelfOrg.organizationId, {
      name: 'Wax ring kit',
      category: 'MATERIAL',
      costCents: 400n,
      priceCents: 1200n,
    });
    const dear = await createPriceBookItem(shelfOrg.organizationId, {
      name: 'Circulator pump',
      category: 'MATERIAL',
      costCents: 18_000n,
      priceCents: 42_000n,
    });

    await receiveStock(db, shelfCtx, {
      stockLocationId: van,
      lines: [
        { priceBookItemId: cheap, quantity: '10', unitCostCents: 400n },
        { priceBookItemId: dear, quantity: '1', unitCostCents: 18_000n },
      ],
      occurredAt: utc(2026, 9, 1),
    });

    // The van works to a level of its own, which is the number that decides "short".
    await db.stockLevel.updateMany({
      where: { stockLocationId: van, priceBookItemId: cheap },
      data: { reorderPoint: '12' },
    });

    const rows = await stockOnHand(db, shelfCtx, van);

    // Dearest first: one pump outranks ten wax rings, which is the order somebody asking
    // about money wants and the opposite of alphabetical.
    expect(rows.map((row) => row.name)).toEqual(['Circulator pump', 'Wax ring kit']);
    expect(rows[0].valueCents).toBe(18_000n);
    expect(rows[1].valueCents).toBe(4_000n);

    const waxRing = rows.find((row) => row.priceBookItemId === cheap)!;
    expect(waxRing.isLow).toBe(true);
    expect(waxRing.reorderPoint).toBe('12');
    expect(rows.find((row) => row.priceBookItemId === dear)!.isLow).toBe(false);
  });

  it('suggests restocking a van that has dropped to its reorder point', async () => {
    const reorderOrg = await createTestOrg('Reorder');
    const reorderCtx = systemContext(reorderOrg.organizationId);
    const van = await createStockLocation(reorderOrg.organizationId, {
      kind: 'VAN',
      locationId: reorderOrg.locationId,
      code: 'VAN-042',
    });
    const item = await createPriceBookItem(reorderOrg.organizationId, {
      name: 'Wax ring kit',
      category: 'MATERIAL',
      costCents: 420n,
      priceCents: 1800n,
    });
    const job = await createTestJob(reorderOrg.organizationId, reorderOrg.locationId);

    await receiveStock(db, reorderCtx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 420n }],
      occurredAt: utc(2026, 9, 1),
    });
    await db.stockLevel.updateMany({
      where: { stockLocationId: van, priceBookItemId: item },
      data: { reorderPoint: '4', reorderQty: '12' },
    });

    expect(await reorderSuggestions(db, reorderCtx, { stockLocationId: van })).toHaveLength(0);

    await consumePartsForJob(db, reorderCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '7' }],
      occurredAt: utc(2026, 9, 2),
    });

    const suggestions = await reorderSuggestions(db, reorderCtx, { stockLocationId: van });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].stockLocationCode).toBe('VAN-042');
    expect(suggestions[0].onHand).toBe('3');
    expect(suggestions[0].suggestedQty).toBe('12');
  });

  it('says nothing about an item with no reorder point set', async () => {
    const quietOrg = await createTestOrg('Quiet');
    const quietCtx = systemContext(quietOrg.organizationId);
    const van = await createStockLocation(quietOrg.organizationId, {
      kind: 'VAN',
      locationId: quietOrg.locationId,
    });
    const item = await createPriceBookItem(quietOrg.organizationId, {
      name: 'Rarely tracked consumable',
      category: 'MATERIAL',
      costCents: 100n,
      priceCents: 400n,
    });
    await receiveStock(db, quietCtx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '1', unitCostCents: 100n }],
      occurredAt: utc(2026, 9, 1),
    });

    expect(await reorderSuggestions(db, quietCtx)).toHaveLength(0);
  });

  it('shows every movement behind an item balance', async () => {
    const traceOrg = await createTestOrg('Movements');
    const traceCtx = systemContext(traceOrg.organizationId);
    const warehouse = await createStockLocation(traceOrg.organizationId, {
      kind: 'WAREHOUSE',
      locationId: traceOrg.locationId,
    });
    const van = await createStockLocation(traceOrg.organizationId, {
      kind: 'VAN',
      locationId: traceOrg.locationId,
    });
    const item = await createPriceBookItem(traceOrg.organizationId, {
      name: 'Traced part',
      category: 'MATERIAL',
      costCents: 500n,
      priceCents: 1500n,
    });
    const job = await createTestJob(traceOrg.organizationId, traceOrg.locationId);

    await receiveStock(db, traceCtx, {
      stockLocationId: warehouse,
      lines: [{ priceBookItemId: item, quantity: '10', unitCostCents: 500n }],
      occurredAt: utc(2026, 9, 1),
    });
    await transferStock(db, traceCtx, {
      fromStockLocationId: warehouse,
      toStockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '4' }],
      occurredAt: utc(2026, 9, 2),
    });
    await consumePartsForJob(db, traceCtx, {
      jobId: job.jobId,
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '1' }],
      occurredAt: utc(2026, 9, 3),
    });

    const movements = await itemMovements(db, traceCtx, item);
    expect(movements.map((m) => m.kind)).toEqual(['CONSUMPTION', 'TRANSFER', 'RECEIPT']);
    expect(movements[0].job!.jobNo).toBeTruthy();
  });

  it('hides stock cost from a technician', async () => {
    const tech = await createTestUser(org.organizationId, {
      roleKey: 'TECHNICIAN',
      locationIds: [org.locationId],
    });
    const van = await createStockLocation(org.organizationId, {
      kind: 'VAN',
      locationId: org.locationId,
    });
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Hidden cost part',
      category: 'MATERIAL',
      costCents: 900n,
      priceCents: 2700n,
    });
    await receiveStock(db, ctx, {
      stockLocationId: van,
      lines: [{ priceBookItemId: item, quantity: '5', unitCostCents: 900n }],
      occurredAt: utc(2026, 9, 1),
    });

    const levels = await scopedDb(db, tech.ctx).stockLevel.findMany({
      where: { stockLocationId: van, priceBookItemId: item },
    });

    expect(levels).toHaveLength(1);
    // The technician can see what is on the truck, not what it cost.
    expect(levels[0].quantity.toString()).toBe('5');
    expect('avgCostCents' in levels[0]).toBe(false);
  });
});
