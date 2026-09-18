import { idb, STORES } from './idb';

/**
 * The outbox.
 *
 * Everything a technician does goes in here first and is sent later — including when there
 * is signal. Queuing unconditionally means there is exactly one code path, so the offline
 * case is the case that is exercised all day rather than a rarely-taken branch that breaks
 * quietly in a basement.
 */

export type OutboxStatus = 'PENDING' | 'SENDING' | 'SENT' | 'CONFLICT' | 'REJECTED';

export interface OutboxEntry {
  clientOpId: string;
  sequence: number;
  type: string;
  jobId?: string;
  payload: Record<string, unknown>;
  clientTimestamp: string;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  /** Local blob keys this operation needs uploaded before it can be sent. */
  blobKeys?: string[];
}

const META_DEVICE_ID = 'deviceId';
const META_SEQUENCE = 'sequence';

/**
 * A device's identity, minted once and kept.
 *
 * It is what makes an operation id unique per device, and therefore what makes replaying a
 * queue safe. Losing it would make every queued operation look new to the server.
 */
export async function deviceId(): Promise<string> {
  const existing = await idb.get<string>(STORES.meta, META_DEVICE_ID);
  if (existing) return existing;

  const minted = `dev_${crypto.randomUUID()}`;
  await idb.put(STORES.meta, minted, META_DEVICE_ID);
  return minted;
}

/**
 * The next sequence number.
 *
 * Persisted, never derived from the queue's length: entries are removed once acknowledged,
 * so counting them would hand out a number that had already been used and the server would
 * apply a morning's work in the wrong order.
 */
export async function nextSequence(): Promise<number> {
  const current = (await idb.get<number>(STORES.meta, META_SEQUENCE)) ?? 0;
  const next = current + 1;
  await idb.put(STORES.meta, next, META_SEQUENCE);
  return next;
}

export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  options: { jobId?: string; blobKeys?: string[]; at?: Date } = {},
): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    clientOpId: crypto.randomUUID(),
    sequence: await nextSequence(),
    type,
    jobId: options.jobId,
    payload,
    // The technician's own clock. The server records when the work happened, not when it
    // heard about it — a job worked at 9am underground is a 9am job.
    clientTimestamp: (options.at ?? new Date()).toISOString(),
    status: 'PENDING',
    attempts: 0,
    blobKeys: options.blobKeys,
  };

  await idb.put(STORES.outbox, entry);
  return entry;
}

export async function pending(): Promise<OutboxEntry[]> {
  const all = await idb.getAll<OutboxEntry>(STORES.outbox);
  return all
    .filter((e) => e.status === 'PENDING' || e.status === 'SENDING')
    .sort((a, b) => a.sequence - b.sequence);
}

export async function unresolved(): Promise<OutboxEntry[]> {
  const all = await idb.getAll<OutboxEntry>(STORES.outbox);
  return all.filter((e) => e.status === 'CONFLICT' || e.status === 'REJECTED');
}

export async function markSending(entries: OutboxEntry[]): Promise<void> {
  await idb.putMany(
    STORES.outbox,
    entries.map((e) => ({ ...e, status: 'SENDING' as const, attempts: e.attempts + 1 })),
  );
}

/**
 * Apply the server's answer for one operation.
 *
 * Anything settled leaves the queue. A conflict stays, flagged, because a technician needs
 * to be told that the extra hour they logged did not land — silently dropping it is how
 * people stop trusting the app.
 */
export async function settle(
  clientOpId: string,
  outcome: 'APPLIED' | 'DUPLICATE' | 'NOOP' | 'CONFLICT' | 'REJECTED',
  message?: string,
): Promise<void> {
  const entry = await idb.get<OutboxEntry>(STORES.outbox, clientOpId);
  if (!entry) return;

  if (outcome === 'APPLIED' || outcome === 'DUPLICATE' || outcome === 'NOOP') {
    await idb.delete(STORES.outbox, clientOpId);
    for (const key of entry.blobKeys ?? []) await idb.delete(STORES.blobs, key);
    return;
  }

  await idb.put(STORES.outbox, {
    ...entry,
    status: outcome,
    lastError: message,
  } satisfies OutboxEntry);
}

/** Put an entry back in the queue after a network failure, so the next drain retries it. */
export async function requeue(entries: OutboxEntry[], reason: string): Promise<void> {
  const current = await idb.getAll<OutboxEntry>(STORES.outbox);
  const byId = new Map(current.map((e) => [e.clientOpId, e]));

  await idb.putMany(
    STORES.outbox,
    entries
      .map((e) => byId.get(e.clientOpId))
      .filter((e): e is OutboxEntry => !!e && e.status === 'SENDING')
      .map((e) => ({ ...e, status: 'PENDING' as const, lastError: reason })),
  );
}

/** Dismiss a conflict the technician has read. */
export async function acknowledge(clientOpId: string): Promise<void> {
  await idb.delete(STORES.outbox, clientOpId);
}

export async function queueDepth(): Promise<{ pending: number; unresolved: number }> {
  const all = await idb.getAll<OutboxEntry>(STORES.outbox);
  return {
    pending: all.filter((e) => e.status === 'PENDING' || e.status === 'SENDING').length,
    unresolved: all.filter((e) => e.status === 'CONFLICT' || e.status === 'REJECTED').length,
  };
}
