import { db } from '../../../../lib/db';
import { issueCreditMemo, voidInvoice } from '../../../../lib/invoices/credits';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';
import { ValidationError } from '../../../../lib/errors';

/** Voiding an invoice, and crediting one. Both need a reason; neither is an edit. */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : '';
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (!invoiceId) throw new ValidationError('Which invoice?');

    if (body.action === 'void') {
      const result = await voidInvoice(db, ctx, invoiceId, { reason });
      return jsonResponse({
        status: result.invoice.status,
        reversalEntryNo: result.reversalEntryNo,
      });
    }

    if (body.action === 'credit') {
      const amountCents =
        typeof body.amountCents === 'string' && body.amountCents.length > 0
          ? BigInt(body.amountCents)
          : undefined;
      const result = await issueCreditMemo(db, ctx, { invoiceId, amountCents, reason });
      return jsonResponse({
        creditMemoNo: result.creditMemoNo,
        amountCents: result.amountCents.toString(),
        taxCents: result.taxCents.toString(),
        balanceCents: result.invoice.balanceCents.toString(),
      });
    }

    throw new ValidationError('Void it or credit it');
  } catch (error) {
    return errorResponse(error);
  }
}
