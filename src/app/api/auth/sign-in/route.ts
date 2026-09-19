import { cookies } from 'next/headers';
import { db } from '../../../../lib/db';
import { resolveOrganizationForSignIn, signIn } from '../../../../lib/auth/service';
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
    //
    // Resolved from the address being signed in rather than from "the first organization",
    // because a machine that has run the seed more than once — or run the test suite —
    // holds more than one, and picking the oldest signs a presenter into an empty company
    // with their own email and their own password, which looks exactly like a broken
    // product. The newest match wins: that is the seed someone just built.
    const organizationId =
      body.organizationId ?? (await resolveOrganizationForSignIn(db, body.email));

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
