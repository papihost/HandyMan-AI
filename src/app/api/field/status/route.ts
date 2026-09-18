import { db } from '../../../../lib/db';
import { conflictsForDevice, pendingOperations } from '../../../../lib/field/push';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';

export async function GET(request: Request) {
  try {
    const ctx = await requireContext();
    const deviceId = new URL(request.url).searchParams.get('deviceId') ?? '';

    const [status, conflicts] = await Promise.all([
      pendingOperations(db, ctx, deviceId),
      conflictsForDevice(db, ctx, deviceId),
    ]);

    return jsonResponse({ ...status, conflicts });
  } catch (error) {
    return errorResponse(error);
  }
}
