import { db } from '../../../lib/db';
import { approveTime, runPayroll } from '../../../lib/payroll/service';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Approving time, and paying it.
 *
 * Two actions with very different weight. Approving is a judgement that can be taken back
 * for as long as nothing has been paid; running payroll moves money and relieves a
 * liability, so it is a posting and it is final.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'approve') {
      const entryIds = Array.isArray(body.entryIds)
        ? body.entryIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (entryIds.length === 0) throw new ValidationError('Which hours?');
      const result = await approveTime(db, ctx, {
        entryIds,
        approved: body.approved !== false,
      });
      return jsonResponse({ changed: result.changed });
    }

    if (body.action === 'run') {
      const periodStart = typeof body.periodStart === 'string' ? new Date(body.periodStart) : null;
      const periodEnd = typeof body.periodEnd === 'string' ? new Date(body.periodEnd) : null;
      if (!periodStart || !periodEnd || Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
        throw new ValidationError('Which period?');
      }
      const payDate = typeof body.payDate === 'string' ? new Date(body.payDate) : undefined;
      const result = await runPayroll(db, ctx, {
        periodStart,
        periodEnd,
        payDate: payDate && !Number.isNaN(payDate.getTime()) ? payDate : undefined,
      });
      return jsonResponse({
        runNo: result.run.runNo,
        totalCostCents: result.run.totalCostCents.toString(),
        journalEntryId: result.journalEntryId,
        people: result.run.lines.length,
      });
    }

    throw new ValidationError('Approve hours, or run payroll');
  } catch (error) {
    return errorResponse(error);
  }
}
