import { cookies } from 'next/headers';
import { db } from '../../../../lib/db';
import { signIn } from '../../../../lib/auth/service';
import { sessionCookieOptions, SESSION_COOKIE } from '../../../../lib/auth/session';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requestMeta } from '../../../../server/session';
import { ValidationError } from '../../../../lib/errors';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      organizationId?: string;
      email?: string;
      password?: string;
      deviceId?: string;
      isFieldDevice?: boolean;
    };

    if (!body.email || !body.password) {
      throw new ValidationError('Email and password are required');
    }

    // One demo company, so a device does not have to know its own tenant id to sign in.
    // A real deployment resolves this from the host name.
    const organizationId =
      body.organizationId ??
      (await db.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } }))
        .id;

    const meta = await requestMeta();
    const { session, context } = await signIn(db, {
      organizationId,
      email: body.email,
      password: body.password,
      deviceId: body.deviceId,
      isFieldDevice: body.isFieldDevice ?? true,
      ...meta,
    });

    const store = await cookies();
    store.set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

    return jsonResponse({
      user: {
        id: context.userId,
        name: context.displayName,
        email: context.email,
        roles: context.roleKeys,
        technicianId: context.technicianId,
        canReadCost: context.canReadCost,
      },
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
