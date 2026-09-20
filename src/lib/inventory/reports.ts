import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { sum, ZERO, type Cents } from '../money';
import { toMilli } from './quantity';

/**
 * Inventory reporting.
 *
 * Valuation reads the stored value rather than recomputing quantity x average, so the
 * total here is the same number that sits in the inventory accounts on the balance sheet.
 */

export interface ValuationRow {
  stockLocationId: string;
  stockLocationCode: string;
  stockLocationName: string;
  kind: string;
  itemCount: number;
  valueCents: Cents;
}

export async function inventoryValuation(
  db: PrismaClient,
  ctx: AuthContext,
): Promise<{ rows: ValuationRow[]; totalCents: Cents }> {
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const locations = await db.stockLocation.findMany({
    where: { organizationId: ctx.organizationId, isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      stockLevels: { select: { valueCents: true, quantity: true } },
    },
    orderBy: { code: 'asc' },
  });

  const rows = locations.map((l) => ({
    stockLocationId: l.id,
    stockLocationCode: l.code,
    stockLocationName: l.name,
    kind: l.kind,
    itemCount: l.stockLevels.filter((s) => toMilli(s.quantity.toString()) !== 0n).length,
    valueCents: sum(l.stockLevels.map((s) => s.valueCents)),
  }));

  return { rows, totalCents: sum(rows.map((r) => r.valueCents)) };
}

export interface ReorderSuggestion {
  stockLocationId: string;
  stockLocationCode: string;
  priceBookItemId: string;
  sku: string;
  name: string;
  onHand: string;
  reorderPoint: string;
  suggestedQty: string;
  preferredVendorId: string | null;
}

/**
 * What to restock.
 *
 * The reorder point on the stock level wins over the one on the item, because a van
 * carries a different working stock than the warehouse does. An item with no reorder point
 * anywhere is not suggested — silence is better than nagging about every consumable.
 */
export async function reorderSuggestions(
  db: PrismaClient,
  ctx: AuthContext,
  filter: { stockLocationId?: string; locationId?: string } = {},
): Promise<ReorderSuggestion[]> {
  requirePermission(ctx, PERMISSIONS.INVENTORY_READ);

  const levels = await db.stockLevel.findMany({
    where: {
      stockLocation: {
        organizationId: ctx.organizationId,
        isActive: true,
        ...(filter.stockLocationId ? { id: filter.stockLocationId } : {}),
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
      },
    },
    select: {
      quantity: true,
      reorderPoint: true,
      reorderQty: true,
      stockLocation: { select: { id: true, code: true } },
      priceBookItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          reorderPoint: true,
          reorderQty: true,
          preferredVendorId: true,
          isActive: true,
          isStocked: true,
        },
      },
    },
  });

  const suggestions: ReorderSuggestion[] = [];

  for (const level of levels) {
    const item = level.priceBookItem;
    if (!item.isActive || !item.isStocked) continue;

    const point = level.reorderPoint ?? item.reorderPoint;
    if (point === null) continue;

    const onHandMilli = toMilli(level.quantity.toString());
    const pointMilli = toMilli(point.toString());
    if (onHandMilli > pointMilli) continue;

    const targetQty = level.reorderQty ?? item.reorderQty;
    // With no explicit order quantity, order back up to the reorder point.
    const suggestedMilli = targetQty
      ? toMilli(targetQty.toString())
      : pointMilli - onHandMilli;
    if (suggestedMilli <= 0n) continue;

    suggestions.push({
      stockLocationId: level.stockLocation.id,
      stockLocationCode: level.stockLocation.code,
      priceBookItemId: item.id,
      sku: item.sku,
      name: item.name,
      onHand: level.quantity.toString(),
      reorderPoint: point.toString(),
      suggestedQty: (Number(suggestedMilli) / 1000).toString(),
      preferredVendorId: item.preferredVendorId,
    });
  }

  return suggestions.sort((a, b) => a.stockLocationCode.localeCompare(b.stockLocationCode));
}

/**
 * Stock that has gone negative — parts consumed that were never recorded as received.
 * Not an error to block on, but it must be visible: every negative line is a receipt
 * somebody did not enter, and a material cost that was estimated rather than known.
 */
export async function negativeStock(db: PrismaClient, ctx: AuthContext) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_READ);

  const levels = await db.stockLevel.findMany({
    where: {
      stockLocation: { organizationId: ctx.organizationId },
      quantity: { lt: 0 },
    },
    select: {
      quantity: true,
      valueCents: true,
      stockLocation: { select: { id: true, code: true, name: true } },
      priceBookItem: { select: { id: true, sku: true, name: true } },
    },
  });

  return {
    rows: levels,
    totalValueCents: sum(levels.map((l) => l.valueCents)),
    count: levels.length,
  };
}

/** Everything that moved for one item, newest first — the audit trail behind a stock figure. */
export async function itemMovements(
  db: PrismaClient,
  ctx: AuthContext,
  priceBookItemId: string,
  filter: { from?: Date; to?: Date; stockLocationId?: string } = {},
) {
  requirePermission(ctx, PERMISSIONS.INVENTORY_READ);

  return db.inventoryTransaction.findMany({
    where: {
      organizationId: ctx.organizationId,
      priceBookItemId,
      ...(filter.from || filter.to
        ? {
            occurredAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
      ...(filter.stockLocationId
        ? {
            OR: [
              { fromStockLocationId: filter.stockLocationId },
              { toStockLocationId: filter.stockLocationId },
            ],
          }
        : {}),
    },
    orderBy: { occurredAt: 'desc' },
    select: {
      id: true,
      kind: true,
      quantity: true,
      unitCostCents: true,
      totalCostCents: true,
      occurredAt: true,
      jobId: true,
      notes: true,
      fromStockLocation: { select: { code: true } },
      toStockLocation: { select: { code: true } },
      job: { select: { jobNo: true } },
    },
    take: 200,
  });
}

export interface ValuationAgainstLedger {
  subledgerCents: Cents;
  ledgerCents: Cents;
  differenceCents: Cents;
  ties: boolean;
  accounts: { accountId: string; code: string; name: string; balanceCents: Cents }[];
}

/**
 * The stock on the shelves against the stock on the balance sheet.
 *
 * Two systems count the same thing here: the inventory subledger, which knows what is on
 * each van, and the general ledger, which knows what the company says its inventory is
 * worth. In most shops those two numbers have never been compared, and the gap between
 * them is discovered once a year by a stocktake nobody enjoys.
 *
 * They agree here by construction — every movement posts — so the honest thing is to show
 * the comparison rather than assert it, and to make a disagreement loud if one ever
 * appears. A reconciliation that can only ever say "fine" is decoration.
 */
export async function valuationAgainstLedger(
  db: PrismaClient,
  ctx: AuthContext,
  asOf?: Date,
): Promise<ValuationAgainstLedger> {
  requirePermission(ctx, PERMISSIONS.FINANCE_READ_COST);

  const { trialBalance } = await import('../accounting/reports');
  const { ACCOUNTS } = await import('../accounting/chart-of-accounts');

  const [valuation, tb] = await Promise.all([
    inventoryValuation(db, ctx),
    trialBalance(db, ctx, asOf ? { to: asOf } : {}),
  ]);

  const codes: readonly string[] = [ACCOUNTS.INVENTORY_WAREHOUSE, ACCOUNTS.INVENTORY_VAN];
  const accounts = tb.rows
    .filter((row) => codes.includes(row.code))
    .map((row) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      balanceCents: row.balanceCents,
    }));

  const ledgerCents = sum(accounts.map((account) => account.balanceCents));

  return {
    subledgerCents: valuation.totalCents,
    ledgerCents,
    differenceCents: valuation.totalCents - ledgerCents,
    ties: valuation.totalCents === ledgerCents,
    accounts,
  };
}

export interface StockOnHandRow {
  priceBookItemId: string;
  sku: string;
  name: string;
  quantity: string;
  avgCostCents: Cents;
  valueCents: Cents;
  reorderPoint: string | null;
  /** At or under the point this stock location works to, so it needs restocking. */
  isLow: boolean;
  binLocation: string | null;
}

/**
 * What is on one van or in one warehouse, dearest first.
 *
 * Sorted by value rather than by name because the question being asked is usually about
 * money — which truck is carrying a fortune in fixtures — and a shop with eighty part
 * numbers on a van does not want to read all of them to find out.
 */
export async function stockOnHand(
  db: PrismaClient,
  ctx: AuthContext,
  stockLocationId: string,
): Promise<StockOnHandRow[]> {
  requirePermission(ctx, PERMISSIONS.INVENTORY_READ);

  const levels = await db.stockLevel.findMany({
    where: {
      stockLocationId,
      stockLocation: { organizationId: ctx.organizationId },
    },
    select: {
      quantity: true,
      avgCostCents: true,
      valueCents: true,
      reorderPoint: true,
      binLocation: true,
      priceBookItem: {
        select: { id: true, sku: true, name: true, reorderPoint: true },
      },
    },
  });

  return levels
    .map((level) => {
      const onHand = toMilli(level.quantity.toString());
      // The stock location's own point wins: a van works to a different level than the
      // warehouse that supplies it.
      const point = level.reorderPoint ?? level.priceBookItem.reorderPoint;

      return {
        priceBookItemId: level.priceBookItem.id,
        sku: level.priceBookItem.sku,
        name: level.priceBookItem.name,
        quantity: level.quantity.toString(),
        avgCostCents: level.avgCostCents,
        valueCents: level.valueCents,
        reorderPoint: point?.toString() ?? null,
        isLow: point !== null && point !== undefined && onHand <= toMilli(point.toString()),
        binLocation: level.binLocation,
      };
    })
    .filter((row) => toMilli(row.quantity) !== 0n || row.isLow)
    .sort((a, b) => Number(b.valueCents - a.valueCents));
}
