import { db } from '../../../lib/db';
import { recordPayment } from '../../../lib/invoices/service';
import { bankTakings } from '../../../lib/invoices/banking';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Money arriving, and money reaching the bank.
 *
 * Two different events that most systems conflate into one. A cheque in the post is
 * received today and banked on Thursday, and the ledger should be able to say so — which
 * is the only reason a bank reconciliation is possible at all.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'bank') {
      const paymentIds = Array.isArray(body.paymentIds)
        ? body.paymentIds.filter((id): id is string => typeof id === 'string')
        : undefined;
      return jsonResponse(await bankTakings(db, ctx, { paymentIds, depositedAt: new Date() }));
    }

    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : '';
    if (!invoiceId) throw new ValidationError('Which invoice?');

    const amountCents = BigInt(String(body.amountCents ?? '0'));
    if (amountCents <= 0n) throw new ValidationError('A payment needs an amount');

    const method = String(body.method ?? '').toUpperCase();
    if (!['CASH', 'CHECK', 'CARD', 'ACH', 'OTHER'].includes(method)) {
      throw new ValidationError('How was it paid?');
    }

    const invoice = await db.invoice.findFirst({
      where: { id: invoiceId, organizationId: ctx.organizationId },
      select: { customerId: true, locationId: true, jobId: true, balanceCents: true },
    });
    if (!invoice) throw new ValidationError('That invoice is not here any more');
    if (amountCents > invoice.balanceCents) {
      throw new ValidationError('That is more than the invoice still owes');
    }

    const result = await recordPayment(db, ctx, {
      customerId: invoice.customerId,
      locationId: invoice.locationId,
      jobId: invoice.jobId ?? undefined,
      invoiceId,
      method: method as 'CASH' | 'CHECK' | 'CARD' | 'ACH' | 'OTHER',
      amountCents,
      reference: typeof body.reference === 'string' ? body.reference : undefined,
      receivedAt: new Date(),
    });

    return jsonResponse({
      paymentNo: result.payment.paymentNo,
      amountCents: result.payment.amountCents.toString(),
      unappliedCents: result.unappliedCents.toString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
