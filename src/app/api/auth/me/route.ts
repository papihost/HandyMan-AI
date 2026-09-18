import { errorResponse, jsonResponse } from '../../../../server/json';
import { currentContext } from '../../../../server/session';

export async function GET() {
  try {
    const ctx = await currentContext();
    if (!ctx) return jsonResponse({ user: null }, { status: 401 });

    return jsonResponse({
      user: {
        id: ctx.userId,
        name: ctx.displayName,
        email: ctx.email,
        roles: ctx.roleKeys,
        technicianId: ctx.technicianId,
        canReadCost: ctx.canReadCost,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
