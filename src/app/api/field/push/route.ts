import { db } from '../../../../lib/db';
import { pushOperations } from '../../../../lib/field/push';
import type { ClientOperation } from '../../../../lib/field/operations';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';

export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as { deviceId: string; operations: ClientOperation[] };

    const result = await pushOperations(db, ctx, {
      deviceId: body.deviceId,
      operations: body.operations ?? [],
    });

    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}
