import { db } from '../../../lib/db';
import { closePeriod, reopenPeriod } from '../../../lib/accounting/periods';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Closing and reopening a month.
 *
 * Both are permission-checked and audited in the engine; this only reads the request.
 * Reopening insists on a reason, because "who reopened March and why" is the question an
 * auditor asks and a blank field is not an answer.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();

    const body = (await request.json()) as {
      periodId?: unknown;
      action?: unknown;
      reason?: unknown;
    };

    const periodId = typeof body.periodId === 'string' ? body.periodId : '';
    if (!periodId) throw new ValidationError('Which period?');

    if (body.action === 'close') {
      const period = await closePeriod(db, ctx, periodId);
      return jsonResponse({ status: period.status, closedAt: period.closedAt });
    }

    if (body.action === 'reopen') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      const period = await reopenPeriod(db, ctx, periodId, reason);
      return jsonResponse({ status: period.status, reopenedAt: period.reopenedAt });
    }

    throw new ValidationError('Close it or reopen it');
  } catch (error) {
    return errorResponse(error);
  }
}
