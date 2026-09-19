import { db } from '../../../../lib/db';
import { rollbackImport } from '../../../../lib/import/runner';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';
import { ValidationError } from '../../../../lib/errors';

/**
 * Undo a batch.
 *
 * Records the import created are removed; anything it posted to the ledger is reversed
 * rather than deleted, because a posted entry is never removed from the books — not even
 * one that should not have been made.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();

    const body = (await request.json()) as { batchId?: unknown };
    const batchId = typeof body.batchId === 'string' ? body.batchId : '';
    if (!batchId) throw new ValidationError('Which batch?');

    const result = await rollbackImport(db, ctx, batchId);
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
