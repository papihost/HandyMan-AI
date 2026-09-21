import type { PrismaClient } from '@prisma/client';
import { requireLocation, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { ZERO, type Cents } from '../money';
import { nextDocumentNumber } from '../accounting/sequences';
import { receiveStock } from '../inventory/service';
import { reorderSuggestions } from '../inventory/reports';

/**
 * Purchase orders.
 *
 * The narrow, honest version: a PO says what was ordered and from whom, and receiving it
 * puts the stock on the shelf and the money in payables in one step. A larger system
 * separates the goods arriving from the invoice arriving and parks the difference in a
 * clearing account; that matters when the two are weeks apart, and it is not what happens
 * at a supply house counter, which is where these are received.
 */

export interface PurchaseOrderLineInput {
  priceBookItemId: string;
  quantity: string;
  /** Defaults to what the price book says the part costs. */
  unitCostCents?: Cents;
}

export interface CreatePurchaseOrderInput {
  vendorId: string;
  receiveToStockLocationId: string;
  lines: PurchaseOrderLineInput[];
  expectedAt?: Date;
  notes?: string;
  createdAt?: Date;
}

const qty = (value: string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError('Order quantity must be positive');
  return n;
};

const extended = (unitCostCents: Cents, quantity: string) =>
  (unitCostCents * BigInt(Math.round(qty(quantity) * 1000))) / 1000n;

export async function createPurchaseOrder(
  db: PrismaClient,
  ctx: AuthContext,
  input: CreatePurchaseOrderInput,
) {
  requirePermission(ctx, PERMISSIONS.PO_WRITE);
  if (input.lines.length === 0) throw new ValidationError('A purchase order needs a line');

  return db.$transaction(async (tx) => {
    const [vendor, stockLocation] = await Promise.all([
      tx.vendor.findFirst({
        where: { id: input.vendorId, organizationId: ctx.organizationId },
        select: { id: true, name: true },
      }),
      tx.stockLocation.findFirst({
        where: { id: input.receiveToStockLocationId, organizationId: ctx.organizationId },
        select: { id: true, code: true, locationId: true },
      }),
    ]);
    if (!vendor) throw new NotFoundError('Vendor', input.vendorId);
    if (!stockLocation) throw new NotFoundError('Stock location', input.receiveToStockLocationId);
    if (stockLocation.locationId) requireLocation(ctx, stockLocation.locationId);

    const items = await tx.priceBookItem.findMany({
      where: {
        organizationId: ctx.organizationId,
        id: { in: input.lines.map((line) => line.priceBookItemId) },
      },
      select: { id: true, sku: true, name: true, costCents: true },
    });
    const itemById = new Map(items.map((item) => [item.id, item]));

    const lines = input.lines.map((line) => {
      const item = itemById.get(line.priceBookItemId);
      if (!item) throw new NotFoundError('Price book item', line.priceBookItemId);

      const unitCostCents = line.unitCostCents ?? item.costCents;
      if (unitCostCents <= ZERO) {
        throw new ValidationError(`${item.name} has no cost on the price book to order it at`);
      }

      return {
        priceBookItemId: item.id,
        description: `${item.sku} · ${item.name}`,
        quantity: line.quantity,
        unitCostCents,
        totalCents: extended(unitCostCents, line.quantity),
      };
    });

    const subtotal = lines.reduce((total, line) => total + line.totalCents, ZERO);
    const poNo = await nextDocumentNumber(tx, ctx.organizationId, 'PURCHASE_ORDER');

    return tx.purchaseOrder.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: stockLocation.locationId,
        poNo,
        vendorId: vendor.id,
        status: 'DRAFT',
        receiveToStockLocationId: stockLocation.id,
        expectedAt: input.expectedAt ?? null,
        subtotalCents: subtotal,
        totalCents: subtotal,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        lines: { create: lines },
      },
      include: { lines: true, vendor: { select: { name: true } } },
    });
  });
}

/** Sent to the vendor. Nothing posts: ordering something is not yet a cost. */
export async function submitPurchaseOrder(
  db: PrismaClient,
  ctx: AuthContext,
  purchaseOrderId: string,
  options: { at?: Date } = {},
) {
  requirePermission(ctx, PERMISSIONS.PO_WRITE);

  const order = await db.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, organizationId: ctx.organizationId },
  });
  if (!order) throw new NotFoundError('Purchase order', purchaseOrderId);
  if (order.status !== 'DRAFT') {
    throw new ValidationError(`Purchase order ${order.poNo} is already ${order.status}`);
  }

  return db.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { status: 'SUBMITTED', orderedAt: options.at ?? new Date() },
  });
}

export interface ReceivePurchaseOrderInput {
  /** Omit to receive everything still outstanding. */
  lines?: { purchaseOrderLineId: string; quantity: string }[];
  vendorInvoiceNo?: string;
  receivedAt?: Date;
}

/**
 * The van pulls up and the stock goes on the shelf.
 *
 * Receiving is the moment a purchase order becomes money: stock rises at what was actually
 * paid for it, and payables rises by the same amount. `receiveStock` does both — it holds
 * the row lock, recomputes the moving average and posts Dr inventory / Cr payables — so
 * this adds the document the payable hangs off rather than posting a second time.
 *
 * Partial receipts are the normal case, not the exception: a supply house is out of one
 * thing and sends the rest.
 */
export async function receivePurchaseOrder(
  db: PrismaClient,
  ctx: AuthContext,
  purchaseOrderId: string,
  input: ReceivePurchaseOrderInput = {},
) {
  requirePermission(ctx, PERMISSIONS.PO_WRITE);
  requirePermission(ctx, PERMISSIONS.BILL_WRITE);

  const order = await db.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, organizationId: ctx.organizationId },
    include: { lines: true, vendor: { select: { id: true, name: true, paymentTermsDays: true } } },
  });
  if (!order) throw new NotFoundError('Purchase order', purchaseOrderId);
  if (order.status === 'CANCELLED') {
    throw new ValidationError(`Purchase order ${order.poNo} was cancelled`);
  }
  if (order.status === 'RECEIVED' || order.status === 'CLOSED') {
    throw new ValidationError(`Purchase order ${order.poNo} has already been received`);
  }
  if (!order.receiveToStockLocationId) {
    throw new ValidationError(`Purchase order ${order.poNo} has nowhere to receive into`);
  }

  const outstanding = new Map(
    order.lines.map((line) => [
      line.id,
      Number(line.quantity) - Number(line.receivedQty),
    ]),
  );

  const requested = input.lines
    ? input.lines.map((line) => ({ id: line.purchaseOrderLineId, quantity: qty(line.quantity) }))
    : order.lines
        .filter((line) => (outstanding.get(line.id) ?? 0) > 0)
        .map((line) => ({ id: line.id, quantity: outstanding.get(line.id)! }));

  if (requested.length === 0) throw new ValidationError('Nothing left to receive');

  const lineById = new Map(order.lines.map((line) => [line.id, line]));
  const receiving = requested.map((row) => {
    const line = lineById.get(row.id);
    if (!line) throw new NotFoundError('Purchase order line', row.id);
    if (!line.priceBookItemId) {
      throw new ValidationError(`${line.description} is not a stocked item`);
    }

    const left = outstanding.get(line.id) ?? 0;
    if (row.quantity > left + 0.0005) {
      throw new ValidationError(
        `${line.description}: ${row.quantity} is more than the ${left} still outstanding`,
      );
    }
    return { line, quantity: row.quantity };
  });

  const receivedAt = input.receivedAt ?? new Date();

  /*
   * Claim the quantities under a row lock before anything posts.
   *
   * Two people can receive the same delivery at once — the counter hand and whoever is
   * watching the screen in the office — and without this both pass the outstanding check
   * and both post, so the stock arrives twice and the vendor is owed double. The claim
   * settles who has it. If the posting then fails, which a closed period will do, the
   * claim is given back and the order is exactly as it was.
   */
  const complete = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${order.id} FOR UPDATE`;

    const current = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id } });
    const byId = new Map(current.map((line) => [line.id, line]));

    for (const { line, quantity } of receiving) {
      const now = byId.get(line.id)!;
      const left = Number(now.quantity) - Number(now.receivedQty);
      if (quantity > left + 0.0005) {
        throw new ValidationError(
          `${line.description}: ${quantity} is more than the ${left} still outstanding`,
        );
      }
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQty: String(Number(now.receivedQty) + quantity) },
      });
    }

    const after = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id } });
    const all = after.every((line) => Number(line.receivedQty) >= Number(line.quantity) - 0.0005);

    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        status: all ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        receivedAt: all ? receivedAt : null,
      },
    });

    return all;
  });

  const releaseClaim = () =>
    db.$transaction(async (tx) => {
      for (const { line } of receiving) {
        await tx.purchaseOrderLine.update({
          where: { id: line.id },
          data: { receivedQty: line.receivedQty },
        });
      }
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: order.status, receivedAt: order.receivedAt },
      });
    });

  // Stock next: it posts Dr inventory / Cr payables and returns the entry the bill hangs
  // off, so the document and the posting can never describe different amounts.
  let receipt: Awaited<ReturnType<typeof receiveStock>>;
  try {
    receipt = await receiveStock(db, ctx, {
      stockLocationId: order.receiveToStockLocationId,
      vendorId: order.vendorId,
      purchaseOrderId: order.id,
      reference: order.poNo,
      occurredAt: receivedAt,
      lines: receiving.map(({ line, quantity }) => ({
        priceBookItemId: line.priceBookItemId!,
        quantity: String(quantity),
        unitCostCents: line.unitCostCents,
      })),
    });
  } catch (error) {
    await releaseClaim();
    throw error;
  }

  return db.$transaction(async (tx) => {
    const billNo = await nextDocumentNumber(tx, ctx.organizationId, 'VENDOR_BILL');
    const bill = await tx.vendorBill.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: order.locationId,
        billNo,
        vendorInvoiceNo: input.vendorInvoiceNo ?? null,
        vendorId: order.vendorId,
        purchaseOrderId: order.id,
        status: 'OPEN',
        billDate: receivedAt,
        dueDate: new Date(
          receivedAt.getTime() + order.vendor.paymentTermsDays * 86_400_000,
        ),
        subtotalCents: receipt.totalCostCents,
        totalCents: receipt.totalCostCents,
        journalEntryId: receipt.journalEntryId,
      },
    });

    const updated = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lines: true },
    });

    return { order: updated, billId: bill.id, complete, ...receipt };
  });
}

export interface DraftedOrder {
  vendorId: string;
  vendorName: string;
  stockLocationId: string;
  stockLocationCode: string;
  lines: { priceBookItemId: string; sku: string; name: string; quantity: string }[];
}

/**
 * What the reorder list would buy, grouped the way it has to be ordered.
 *
 * One purchase order per vendor per stock location, because that is what a supply house
 * receives and what a van gets loaded from. An item with nobody to buy it from is left out
 * rather than guessed at — a PO sent to the wrong vendor is worse than one not sent.
 */
export async function draftOrdersFromReorder(
  db: PrismaClient,
  ctx: AuthContext,
  filter: { stockLocationId?: string; locationId?: string } = {},
): Promise<{ drafts: DraftedOrder[]; unassigned: { sku: string; name: string }[] }> {
  requirePermission(ctx, PERMISSIONS.PO_WRITE);

  const suggestions = await reorderSuggestions(db, ctx, filter);

  const vendorIds = [
    ...new Set(suggestions.map((s) => s.preferredVendorId).filter((id): id is string => !!id)),
  ];
  const vendors = await db.vendor.findMany({
    where: { id: { in: vendorIds }, organizationId: ctx.organizationId },
    select: { id: true, name: true },
  });
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));

  const grouped = new Map<string, DraftedOrder>();
  const unassigned: { sku: string; name: string }[] = [];

  for (const suggestion of suggestions) {
    if (!suggestion.preferredVendorId || !vendorName.has(suggestion.preferredVendorId)) {
      unassigned.push({ sku: suggestion.sku, name: suggestion.name });
      continue;
    }

    const key = `${suggestion.preferredVendorId}|${suggestion.stockLocationId}`;
    const draft = grouped.get(key) ?? {
      vendorId: suggestion.preferredVendorId,
      vendorName: vendorName.get(suggestion.preferredVendorId)!,
      stockLocationId: suggestion.stockLocationId,
      stockLocationCode: suggestion.stockLocationCode,
      lines: [],
    };
    draft.lines.push({
      priceBookItemId: suggestion.priceBookItemId,
      sku: suggestion.sku,
      name: suggestion.name,
      quantity: suggestion.suggestedQty,
    });
    grouped.set(key, draft);
  }

  return { drafts: [...grouped.values()], unassigned };
}
