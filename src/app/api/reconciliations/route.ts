import { db } from '../../../lib/db';
import {
  completeReconciliation,
  openReconciliation,
  setCleared,
} from '../../../lib/accounting/reconciliation';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Reconciling an account against a statement.
 *
 * Nothing here posts. A statement is evidence that the bank saw what the books already
 * say — ticking a line changes no balance, and a reconciliation that had to post an
 * adjustment to agree would be hiding the thing it exists to find.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'open') {
      const accountId = typeof body.accountId === 'string' ? body.accountId : '';
      const statementDate = typeof body.statementDate === 'string' ? new Date(body.statementDate) : null;
      if (!accountId || !statementDate || Number.isNaN(statementDate.getTime())) {
        throw new ValidationError('Which account, and to what date?');
      }
      const rec = await openReconciliation(db, ctx, {
        accountId,
        statementDate,
        closingBalanceCents: BigInt(String(body.closingBalanceCents ?? '0')),
      });
      return jsonResponse({ id: rec.id });
    }

    const reconciliationId = typeof body.reconciliationId === 'string' ? body.reconciliationId : '';
    if (!reconciliationId) throw new ValidationError('Which reconciliation?');

    if (body.action === 'clear') {
      const journalLineIds = Array.isArray(body.journalLineIds)
        ? body.journalLineIds.filter((id): id is string => typeof id === 'string')
        : [];
      const sheet = await setCleared(db, ctx, reconciliationId, {
        journalLineIds,
        cleared: body.cleared !== false,
      });
      return jsonResponse({
        clearedCount: sheet.clearedCount,
        clearedBalanceCents: sheet.clearedBalanceCents.toString(),
        differenceCents: sheet.differenceCents.toString(),
      });
    }

    if (body.action === 'complete') {
      const done = await completeReconciliation(db, ctx, reconciliationId);
      return jsonResponse({
        status: done.reconciliation.status,
        clearedCount: done.clearedCount,
        outstandingCount: done.outstandingCount,
        outstandingCents: done.outstandingCents.toString(),
      });
    }

    throw new ValidationError('Open it, tick it, or finish it');
  } catch (error) {
    return errorResponse(error);
  }
}
