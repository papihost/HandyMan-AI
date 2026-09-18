import { db } from '../../../../lib/db';
import { pullFieldData } from '../../../../lib/field/pull';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';

export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json().catch(() => ({}))) as {
      since?: string;
      knownJobIds?: string[];
    };

    const result = await pullFieldData(db, ctx, {
      since: body.since ? new Date(body.since) : undefined,
      knownJobIds: body.knownJobIds,
    });

    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
