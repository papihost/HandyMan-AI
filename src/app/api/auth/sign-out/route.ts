import { cookies } from 'next/headers';
import { db } from '../../../../lib/db';
import { signOut } from '../../../../lib/auth/service';
import { SESSION_COOKIE } from '../../../../lib/auth/session';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { currentContext } from '../../../../server/session';

export async function POST() {
  try {
    const ctx = await currentContext();
    if (ctx) await signOut(db, ctx);

    const store = await cookies();
    store.delete(SESSION_COOKIE);

    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
