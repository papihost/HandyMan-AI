/**
 * JSON that survives money.
 *
 * Amounts are BigInt minor units, and `JSON.stringify` throws on a BigInt rather than
 * quietly rounding it — which is the right behaviour, but means both ends need a
 * convention. Amounts travel as strings and are turned back into BigInt on arrival, so a
 * figure never passes through a double on its way to a tablet.
 */

export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(toJsonSafe(body)), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

export function errorResponse(error: unknown): Response {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'INTERNAL_ERROR';

  const message = error instanceof Error ? error.message : 'Something went wrong';

  // An unexpected failure is logged in full and reported vaguely: a stack trace on a
  // tablet screen helps nobody and tells an attacker plenty.
  if (status === 500) {
    console.error('[api]', error);
    return jsonResponse({ error: { code, message: 'Something went wrong' } }, { status: 500 });
  }

  return jsonResponse({ error: { code, message } }, { status });
}
