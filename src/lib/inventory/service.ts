import type { PrismaClient, StockLocationKind } from '@prisma/client';
import { requireLocation, requirePermission, systemContext, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { sum, ZERO, type Cents } from '../money';
import { postJournalEntry } from '../accounting/ledger';
import {
  partsConsumedLines,
  stockReceivedLines,
  stockTransferLines,
} from '../accounting/rules/inventory';
import { refreshJobRollup } from '../jobs/costing';
import { fromMilli, toMilli, unitCostOf, valueOf, type Milli } from './quantity';

/**
 * Inventory.
 *
 * Parts do not sit in a warehouse; they sit in twenty trucks. Every technician's van is a
 * stock location, and the moment a part comes off a van onto a job is the moment it stops
 * being an asset and becomes the cost of that job. Without that, inventory value is
 * fiction and material margin is a guess.
 *
 * Costing is moving average, captured at the time of the movement. A later receipt at a
 * different price changes what the *next* job costs, never what last month's job cost.
 */

type TxLike = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export interface StockLine {
  priceBookItemId: string;
  quantity: string | number;
  /** Required on a receipt; ignored elsewhere, where cost comes from the stock on hand. */
  unitCostCents?: Cents;
}

/** The GL account each kind of stock location rolls up to. */
function glKind(kind: StockLocationKind): 'WAREHOUSE' | 'VAN' {
  return kind === 'VAN' ? 'VAN' : 'WAREHOUSE';
}

/**
 * Lock a stock level row for the rest of the transaction, creating it if absent.
 *
 * `SELECT ... FOR UPDATE`, because a moving average is a read-modify-write: two concurrent
 * receipts that both read the old average and both write a new one lose the first receipt
 * entirely, and the inventory asset silently stops matching what was paid for it.
 */
async function lockStockLevel(
  tx: TxLike,
  stockLocationId: string,
  priceBookItemId: string,
): Promise<{ id: string; quantityMilli: Milli; valueCents: Cents }> {
  await tx.stockLevel.createMany({
    data: [{ stockLocationId, priceBookItemId, quantity: '0', valueCents: 0n, avgCostCents: 0n }],
    skipDuplicates: true,
  });

  const rows = await tx.$queryRaw<{ id: string; quantity: string; valueCents: bigint }[]>`
    SELECT "id", "quantity"::text, "valueCents"
    FROM "StockLevel"
    WHERE "stockLocationId" = ${stockLocationId} AND "priceBookItemId" = ${priceBookItemId}
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) throw new Error('Stock level row could not be locked');
  return { id: row.id, quantityMilli: toMilli(row.quantity), valueCents: row.valueCents };
}

async function writeStockLevel(
  tx: TxLike,
  id: string,
  quantityMilli: Milli,
  valueCents: Cents,
): Promise<void> {
  await tx.stockLevel.update({
    where: { id },
    data: {
      quantity: fromMilli(quantityMilli),
      valueCents,
      avgCostCents: unitCostOf(valueCents, quantityMilli),
    },
  });
}

/** Every technician gets a van. Idempotent, so it can be called on demand. */
export async function ensureVanStockLocation(
  db: PrismaClient,
  ctx: AuthContext,
  technicianId: string,
  locationId: string,
): Promise<string> {
  const existing = await db.stockLocation.findFirst({
    where: { organizationId: ctx.organizationId, technicianId, kind: 'VAN' },
    select: { id: true },
  });
  if (existing) return existing.id;

  const technician = await db.technician.findFirst({
    where: { id: technicianId, organizationId: ctx.organizationId },
    select: { id: true, user: { select: { firstName: true, lastName: true } } },
  });
  if (!technician) throw new NotFoundError('Technician', technicianId);

  const created = await db.stockLocation.create({
    data: {
      organizationId: ctx.organizationId,
      locationId,
      technicianId,
      kind: 'VAN',
      code: `VAN-${technicianId.slice(-6).toUpperCase()}`,
      name: `${technician.user.firstName} ${technician.user.lastName} — van`,
    },
  });
  return created.id;
}

export interface ReceiveStockInput {
  stockLocationId: string;
  lines: StockLine[];
  purchaseOrderId?: string;
  vendorId?: string;
  reference?: string;
  occurredAt?: Date;
}

/**
 * Stock received from a supplier.
 *
 *   Dr Inventory   Cr Accounts Payable
 *
 * The receipt is what moves the moving average: value in, quantity in, average derived.
 */
export async function receiveStock(db: PrismaClient, ctx: AuthContext, input: ReceiveStockInput) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_ADJUST);
  if (input.lines.length === 0) throw new ValidationError('Nothing to receive');

  return db.$transaction(async (tx) => {
    const location = await loadStockLocation(tx, ctx, input.stockLocationId);
    const occurredAt = input.occurredAt ?? new Date();
    let totalCost = ZERO;

    for (const line of input.lines) {
      const qtyMilli = toMilli(line.quantity);
      if (qtyMilli <= 0n) throw new ValidationError('Receipt quantity must be positive');
      if (line.unitCostCents === undefined) {
        throw new ValidationError('A receipt line needs a unit cost');
      }
      if (line.unitCostCents < ZERO) throw new ValidationError('Unit cost cannot be negative');

      const level = await lockStockLevel(tx, location.id, line.priceBookItemId);
      const lineValue = valueOf(qtyMilli, line.unitCostCents);

      await writeStockLevel(
        tx,
        level.id,
        level.quantityMilli + qtyMilli,
        level.valueCents + lineValue,
      );

      await tx.inventoryTransaction.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'RECEIPT',
          priceBookItemId: line.priceBookItemId,
          toStockLocationId: location.id,
          quantity: fromMilli(qtyMilli),
          unitCostCents: line.unitCostCents,
          totalCostCents: lineValue,
          purchaseOrderId: input.purchaseOrderId ?? null,
          occurredAt,
          createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
          notes: input.reference ?? null,
        },
      });

      totalCost += lineValue;
    }

    const entry = await postJournalEntry(
      db,
      ctx,
      {
        entryDate: occurredAt,
        source: 'INVENTORY',
        sourceType: 'StockReceipt',
        sourceId: input.purchaseOrderId,
        memo: input.reference ?? `Stock received into ${location.code}`,
        lines: stockReceivedLines({
          poNo: input.reference ?? 'receipt',
          locationId: location.locationId,
          vendorId: input.vendorId ?? null,
          totalCostCents: totalCost,
          toStockKind: glKind(location.kind),
        }),
      },
      tx,
    );

    return { totalCostCents: totalCost, journalEntryId: entry.id };
  });
}

export interface TransferStockInput {
  fromStockLocationId: string;
  toStockLocationId: string;
  lines: StockLine[];
  reference?: string;
  occurredAt?: Date;
}

/**
 * Warehouse to van, or van to van.
 *
 * Stock moves out at the source's average cost and arrives valued at exactly that, so no
 * value is created or destroyed by moving a part around. Both sides are assets, so the
 * income statement is untouched — but the movement still has to be recorded, or warehouse
 * and van stock both drift away from what is physically there.
 */
export async function transferStock(db: PrismaClient, ctx: AuthContext, input: TransferStockInput) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_TRANSFER);
  if (input.fromStockLocationId === input.toStockLocationId) {
    throw new ValidationError('Source and destination are the same stock location');
  }

  return db.$transaction(async (tx) => {
    const from = await loadStockLocation(tx, ctx, input.fromStockLocationId);
    const to = await loadStockLocation(tx, ctx, input.toStockLocationId);
    const occurredAt = input.occurredAt ?? new Date();
    let totalCost = ZERO;

    for (const line of input.lines) {
      const qtyMilli = toMilli(line.quantity);
      if (qtyMilli <= 0n) throw new ValidationError('Transfer quantity must be positive');

      // Always lock in a stable order, so two transfers in opposite directions between
      // the same pair of locations cannot deadlock against each other.
      const [first, second] =
        input.fromStockLocationId < input.toStockLocationId
          ? [input.fromStockLocationId, input.toStockLocationId]
          : [input.toStockLocationId, input.fromStockLocationId];
      const locked = new Map<string, Awaited<ReturnType<typeof lockStockLevel>>>();
      locked.set(first, await lockStockLevel(tx, first, line.priceBookItemId));
      locked.set(second, await lockStockLevel(tx, second, line.priceBookItemId));

      const source = locked.get(input.fromStockLocationId)!;
      const destination = locked.get(input.toStockLocationId)!;

      const { costCents, unitCostCents } = await relieveCost(
        tx,
        ctx.organizationId,
        source,
        qtyMilli,
        line.priceBookItemId,
      );

      await writeStockLevel(
        tx,
        source.id,
        source.quantityMilli - qtyMilli,
        source.valueCents - costCents,
      );
      await writeStockLevel(
        tx,
        destination.id,
        destination.quantityMilli + qtyMilli,
        destination.valueCents + costCents,
      );

      await tx.inventoryTransaction.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'TRANSFER',
          priceBookItemId: line.priceBookItemId,
          fromStockLocationId: from.id,
          toStockLocationId: to.id,
          quantity: fromMilli(qtyMilli),
          unitCostCents,
          totalCostCents: costCents,
          occurredAt,
          createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
          notes: input.reference ?? null,
        },
      });

      totalCost += costCents;
    }

    // Warehouse-to-warehouse or van-to-van nets to the same GL account; the subledger
    // still records the move, but there is nothing to post.
    if (totalCost === ZERO || glKind(from.kind) === glKind(to.kind)) {
      return { totalCostCents: totalCost, journalEntryId: null };
    }

    const entry = await postJournalEntry(
      db,
      ctx,
      {
        entryDate: occurredAt,
        source: 'INVENTORY',
        sourceType: 'StockTransfer',
        memo: input.reference ?? `${from.code} to ${to.code}`,
        lines: stockTransferLines({
          reference: input.reference ?? `${from.code}->${to.code}`,
          locationId: to.locationId ?? from.locationId,
          technicianId: to.technicianId ?? from.technicianId,
          totalCostCents: totalCost,
          fromStockKind: glKind(from.kind),
          toStockKind: glKind(to.kind),
        }),
      },
      tx,
    );

    return { totalCostCents: totalCost, journalEntryId: entry.id };
  });
}

export interface ConsumePartsInput {
  jobId: string;
  stockLocationId: string;
  lines: StockLine[];
  occurredAt?: Date;
  technicianId?: string;
}

/**
 * Parts used on a job. This is where inventory becomes cost of goods sold, and where a
 * job's material cost stops being an estimate.
 *
 *   Dr COGS — Materials   Cr Inventory — Van Stock
 */
export async function consumePartsForJob(
  db: PrismaClient,
  ctx: AuthContext,
  input: ConsumePartsInput,
) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_TRANSFER);
  if (input.lines.length === 0) throw new ValidationError('No parts to consume');

  const result = await db.$transaction(async (tx) => {
    const stock = await loadStockLocation(tx, ctx, input.stockLocationId);
    const job = await tx.job.findFirst({
      where: { id: input.jobId, organizationId: ctx.organizationId },
      select: { id: true, locationId: true, serviceTypeId: true, status: true, jobNo: true },
    });
    if (!job) throw new NotFoundError('Job', input.jobId);
    if (job.status === 'CLOSED' || job.status === 'CANCELLED') {
      throw new ValidationError(`Job ${job.jobNo} is ${job.status}; parts cannot be booked to it`);
    }

    const occurredAt = input.occurredAt ?? new Date();
    let totalCost = ZERO;

    for (const line of input.lines) {
      const qtyMilli = toMilli(line.quantity);
      if (qtyMilli <= 0n) throw new ValidationError('Consumption quantity must be positive');

      const level = await lockStockLevel(tx, stock.id, line.priceBookItemId);
      const { costCents, unitCostCents } = await relieveCost(
        tx,
        ctx.organizationId,
        level,
        qtyMilli,
        line.priceBookItemId,
      );

      await writeStockLevel(
        tx,
        level.id,
        level.quantityMilli - qtyMilli,
        level.valueCents - costCents,
      );

      await tx.inventoryTransaction.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'CONSUMPTION',
          priceBookItemId: line.priceBookItemId,
          fromStockLocationId: stock.id,
          quantity: fromMilli(qtyMilli),
          unitCostCents,
          totalCostCents: costCents,
          jobId: job.id,
          occurredAt,
          createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
        },
      });

      totalCost += costCents;
    }

    if (totalCost === ZERO) return { totalCostCents: ZERO, journalEntryId: null, jobId: job.id };

    const entry = await postJournalEntry(
      db,
      ctx,
      {
        entryDate: occurredAt,
        source: 'INVENTORY',
        sourceType: 'PartsConsumed',
        sourceId: job.id,
        memo: `Parts used on job ${job.jobNo}`,
        lines: partsConsumedLines({
          jobId: job.id,
          locationId: job.locationId,
          technicianId: input.technicianId ?? stock.technicianId,
          serviceTypeId: job.serviceTypeId,
          totalCostCents: totalCost,
          fromStockKind: glKind(stock.kind),
        }),
      },
      tx,
    );

    return { totalCostCents: totalCost, journalEntryId: entry.id, jobId: job.id };
  });

  await refreshJobRollup(db, systemContext(ctx.organizationId, ctx.userId), result.jobId);
  return result;
}

/**
 * What it costs to take `qtyMilli` off a stock level.
 *
 * Taking the whole balance relieves exactly what is there, which is what keeps the running
 * value from drifting. A partial draw costs at the current average.
 *
 * Stock can go negative: a technician uses a part that was never recorded as received, and
 * refusing the entry would only mean the job never gets costed at all. When there is
 * nothing on hand to price against, the item's standard cost is used so the job still
 * carries a defensible cost, and the movement is visible on the negative-stock report.
 */
async function relieveCost(
  tx: TxLike,
  organizationId: string,
  level: { quantityMilli: Milli; valueCents: Cents },
  qtyMilli: Milli,
  priceBookItemId: string,
): Promise<{ costCents: Cents; unitCostCents: Cents }> {
  if (level.quantityMilli > 0n && qtyMilli >= level.quantityMilli) {
    return {
      costCents: level.valueCents,
      unitCostCents: unitCostOf(level.valueCents, level.quantityMilli),
    };
  }

  if (level.quantityMilli > 0n) {
    const unit = unitCostOf(level.valueCents, level.quantityMilli);
    return { costCents: valueOf(qtyMilli, unit), unitCostCents: unit };
  }

  const item = await tx.priceBookItem.findFirst({
    where: { id: priceBookItemId, organizationId },
    select: { costCents: true },
  });
  const unit = item?.costCents ?? ZERO;
  return { costCents: valueOf(qtyMilli, unit), unitCostCents: unit };
}

async function loadStockLocation(tx: TxLike, ctx: AuthContext, stockLocationId: string) {
  const location = await tx.stockLocation.findFirst({
    where: { id: stockLocationId, organizationId: ctx.organizationId },
    select: {
      id: true,
      code: true,
      kind: true,
      locationId: true,
      technicianId: true,
      isActive: true,
    },
  });
  if (!location) throw new NotFoundError('Stock location', stockLocationId);
  if (!location.isActive) throw new ValidationError(`Stock location ${location.code} is inactive`);
  if (location.locationId) requireLocation(ctx, location.locationId);
  return location;
}
