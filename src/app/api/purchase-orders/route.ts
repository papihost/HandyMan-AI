import { db } from '../../../lib/db';
import {
  createPurchaseOrder,
  draftOrdersFromReorder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from '../../../lib/purchasing/orders';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Raising and receiving purchase orders.
 *
 * "raiseFromReorder" is the one the inventory screen calls: it turns the restock list into
 * one order per vendor per stock location and submits them, because a draft nobody sends
 * is the same as no order at all.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'raiseFromReorder') {
      const stockLocationId =
        typeof body.stockLocationId === 'string' ? body.stockLocationId : undefined;

      const { drafts, unassigned } = await draftOrdersFromReorder(db, ctx, { stockLocationId });

      const created = [];
      for (const draft of drafts) {
        const order = await createPurchaseOrder(db, ctx, {
          vendorId: draft.vendorId,
          receiveToStockLocationId: draft.stockLocationId,
          lines: draft.lines.map((line) => ({
            priceBookItemId: line.priceBookItemId,
            quantity: line.quantity,
          })),
          notes: `Raised from the restock list for ${draft.stockLocationCode}`,
        });
        await submitPurchaseOrder(db, ctx, order.id);
        created.push({ id: order.id, poNo: order.poNo, vendor: draft.vendorName });
      }

      return jsonResponse({ created, unassigned });
    }

    const purchaseOrderId = typeof body.purchaseOrderId === 'string' ? body.purchaseOrderId : '';
    if (!purchaseOrderId) throw new ValidationError('Which purchase order?');

    if (body.action === 'submit') {
      const order = await submitPurchaseOrder(db, ctx, purchaseOrderId);
      return jsonResponse({ status: order.status });
    }

    if (body.action === 'receive') {
      const result = await receivePurchaseOrder(db, ctx, purchaseOrderId, {
        vendorInvoiceNo:
          typeof body.vendorInvoiceNo === 'string' ? body.vendorInvoiceNo : undefined,
      });
      return jsonResponse({
        status: result.order.status,
        billId: result.billId,
        totalCostCents: result.totalCostCents,
      });
    }

    throw new ValidationError('Submit it or receive it');
  } catch (error) {
    return errorResponse(error);
  }
}
