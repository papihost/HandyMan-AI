import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { ZERO, type Cents } from '../money';
import { postJournalEntry } from '../accounting/ledger';
import { nextDocumentNumber } from '../accounting/sequences';
import { cycleCountVarianceLines } from '../accounting/rules/inventory';
import { fromMilli, toMilli, unitCostOf, valueOf } from './quantity';

/**
 * Cycle counts.
 *
 * Van stock drifts. Parts get used without being logged, returned to the wrong truck, or
 * quietly walk off. A count is the only thing that brings the book back to the shelf, and
 * the variance it produces is a real expense that belongs on the income statement rather
 * than being absorbed silently into the next job's material cost.
 */

export interface CountLineInput {
  priceBookItemId: string;
  countedQuantity: string | number;
}

/** Open a count, snapshotting what the system currently believes is on hand. */
export async function openCycleCount(
  db: PrismaClient,
  ctx: AuthContext,
  stockLocationId: string,
) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_COUNT);

  const stock = await db.stockLocation.findFirst({
    where: { id: stockLocationId, organizationId: ctx.organizationId },
    select: { id: true, code: true },
  });
  if (!stock) throw new NotFoundError('Stock location', stockLocationId);

  return db.$transaction(async (tx) => {
    const countNo = await nextDocumentNumber(tx, ctx.organizationId, 'CYCLE_COUNT');
    const levels = await tx.stockLevel.findMany({
      where: { stockLocationId },
      select: { priceBookItemId: true, quantity: true, avgCostCents: true },
    });

    return tx.cycleCount.create({
      data: {
        organizationId: ctx.organizationId,
        stockLocationId,
        countNo,
        status: 'OPEN',
        lines: {
          create: levels.map((l) => ({
            priceBookItemId: l.priceBookItemId,
            expectedQty: l.quantity,
            countedQty: l.quantity,
            varianceQty: '0',
            unitCostCents: l.avgCostCents,
            varianceCents: 0n,
          })),
        },
      },
      include: { lines: true },
    });
  });
}

/**
 * Record what was actually on the shelf and post the difference.
 *
 * The expected quantity is re-read under lock at post time rather than trusted from when
 * the count was opened, so a consumption recorded while the technician was counting does
 * not turn into a phantom variance.
 */
export async function postCycleCount(
  db: PrismaClient,
  ctx: AuthContext,
  cycleCountId: string,
  counted: CountLineInput[],
  // A count taken on the last day of a period has to post in that period, not on the day
  // somebody got around to keying it in.
  options: { occurredAt?: Date } = {},
) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_ADJUST);

  return db.$transaction(async (tx) => {
    const count = await tx.cycleCount.findFirst({
      where: { id: cycleCountId, organizationId: ctx.organizationId },
      include: { stockLocation: { select: { id: true, kind: true, locationId: true, code: true } } },
    });
    if (!count) throw new NotFoundError('Cycle count', cycleCountId);
    if (count.status === 'POSTED') {
      throw new ValidationError(`Cycle count ${count.countNo} has already been posted`);
    }

    const occurredAt = options.occurredAt ?? new Date();
    let totalVariance: Cents = ZERO;

    for (const line of counted) {
      const countedMilli = toMilli(line.countedQuantity);
      if (countedMilli < 0n) throw new ValidationError('A counted quantity cannot be negative');

      const rows = await tx.$queryRaw<{ id: string; quantity: string; valueCents: bigint }[]>`
        SELECT "id", "quantity"::text, "valueCents"
        FROM "StockLevel"
        WHERE "stockLocationId" = ${count.stockLocationId}
          AND "priceBookItemId" = ${line.priceBookItemId}
        FOR UPDATE
      `;
      const level = rows[0];
      if (!level) continue;

      const expectedMilli = toMilli(level.quantity);
      const varianceMilli = countedMilli - expectedMilli;
      if (varianceMilli === 0n) continue;

      const unitCost = unitCostOf(level.valueCents, expectedMilli);
      // A shortage relieves at the average on hand. An overage has no cost history of its
      // own, so it comes in at the same average — the alternative is inventing a price.
      const varianceValue =
        countedMilli === 0n ? -level.valueCents : valueOf(varianceMilli, unitCost);

      await tx.stockLevel.update({
        where: { id: level.id },
        data: {
          quantity: fromMilli(countedMilli),
          valueCents: level.valueCents + varianceValue,
          avgCostCents: unitCostOf(level.valueCents + varianceValue, countedMilli),
        },
      });

      await tx.cycleCountLine.updateMany({
        where: { cycleCountId, priceBookItemId: line.priceBookItemId },
        data: {
          expectedQty: fromMilli(expectedMilli),
          countedQty: fromMilli(countedMilli),
          varianceQty: fromMilli(varianceMilli),
          unitCostCents: unitCost,
          varianceCents: varianceValue,
        },
      });

      await tx.inventoryTransaction.create({
        data: {
          organizationId: ctx.organizationId,
          kind: varianceMilli < 0n ? 'SHRINKAGE' : 'ADJUSTMENT',
          priceBookItemId: line.priceBookItemId,
          ...(varianceMilli < 0n
            ? { fromStockLocationId: count.stockLocationId }
            : { toStockLocationId: count.stockLocationId }),
          quantity: fromMilli(varianceMilli < 0n ? -varianceMilli : varianceMilli),
          unitCostCents: unitCost,
          totalCostCents: varianceValue < ZERO ? -varianceValue : varianceValue,
          occurredAt,
          createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
          notes: `Cycle count ${count.countNo}`,
        },
      });

      totalVariance += varianceValue;
    }

    let journalEntryId: string | null = null;
    if (totalVariance !== ZERO) {
      const entry = await postJournalEntry(
        db,
        ctx,
        {
          entryDate: occurredAt,
          source: 'INVENTORY',
          sourceType: 'CycleCount',
          sourceId: count.id,
          memo: `Cycle count ${count.countNo} — ${count.stockLocation.code}`,
          lines: cycleCountVarianceLines({
            countNo: count.countNo,
            locationId: count.stockLocation.locationId,
            stockKind: count.stockLocation.kind === 'VAN' ? 'VAN' : 'WAREHOUSE',
            varianceCents: totalVariance,
          }),
        },
        tx,
      );
      journalEntryId = entry.id;
    }

    const posted = await tx.cycleCount.update({
      where: { id: cycleCountId },
      data: {
        status: 'POSTED',
        countedByUserId: ctx.userId === 'system' ? null : ctx.userId,
        countedAt: occurredAt,
        postedAt: occurredAt,
        varianceCents: totalVariance,
      },
      include: { lines: true },
    });

    return { cycleCount: posted, varianceCents: totalVariance, journalEntryId };
  });
}
