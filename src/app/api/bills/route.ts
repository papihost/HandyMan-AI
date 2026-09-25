import { db } from '../../../lib/db';
import { payOpenBills } from '../../../lib/purchasing/service';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Paying what the company owes.
 *
 * Two ways, because there are two: the Friday run that clears everything due, and paying
 * one bill on its own. Both post on the day the money actually leaves, which is today
 * rather than the due date being cleared through — a payment dated into next week is a
 * payment the bank statement cannot be reconciled against.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;
    const reference = typeof body.reference === 'string' ? body.reference : undefined;
    const method = typeof body.method === 'string' ? body.method : undefined;

    if (body.action === 'payRun') {
      const days = typeof body.days === 'number' ? body.days : 0;
      const throughDate = new Date(Date.now() + days * 86_400_000);
      const result = await payOpenBills(db, ctx, {
        throughDate,
        paidAt: new Date(),
        method,
        reference,
      });
      return jsonResponse(result);
    }

    const billIds = Array.isArray(body.billIds)
      ? body.billIds.filter((id): id is string => typeof id === 'string')
      : typeof body.billId === 'string'
        ? [body.billId]
        : [];

    if (billIds.length === 0) throw new ValidationError('Which bill?');

    return jsonResponse(
      await payOpenBills(db, ctx, { billIds, paidAt: new Date(), method, reference }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
