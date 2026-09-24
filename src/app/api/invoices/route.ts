import { db } from '../../../lib/db';
import { billJobs } from '../../../lib/invoices/service';
import { unbilledCompletedJobs } from '../../../lib/reporting/dashboard';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/**
 * Billing finished work.
 *
 * The dashboard has always been able to say how much earned work is sitting uninvoiced;
 * this is the button that does something about it. One job or the whole list — the same
 * call either way, because billing thirty jobs is billing one job thirty times and
 * pretending otherwise is how a bulk action ends up with its own subtly different rules.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    const jobIds: string[] = Array.isArray(body.jobIds)
      ? body.jobIds.filter((id): id is string => typeof id === 'string')
      : typeof body.jobId === 'string'
        ? [body.jobId]
        : [];

    if (body.action === 'billAllUnbilled') {
      // Read the list here rather than trusting one the browser assembled: it may be
      // minutes old, and a job invoiced in the meantime must not be invoiced again.
      const unbilled = await unbilledCompletedJobs(db, ctx);
      const result = await billJobs(db, ctx, unbilled.jobs.map((job) => job.id));
      return jsonResponse(result);
    }

    if (jobIds.length === 0) throw new ValidationError('Which job?');

    return jsonResponse(await billJobs(db, ctx, jobIds));
  } catch (error) {
    return errorResponse(error);
  }
}
