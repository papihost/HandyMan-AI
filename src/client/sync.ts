import { api, OfflineError, type PullPayload, type RawJob } from './api';
import { idb, STORES } from './idb';
import {
  deviceId,
  markSending,
  pending,
  queueDepth,
  requeue,
  settle,
  type OutboxEntry,
} from './outbox';

/**
 * The sync loop.
 *
 * Push before pull, always. The device's own work is the newest truth about a job it has
 * been working, and pulling first would overwrite an unsent change with the server's older
 * copy — the technician would watch their last hour disappear.
 */

const CURSOR = 'cursor';
let running = false;

export interface SyncOutcome {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  offline: boolean;
  error?: string;
}

export type SyncListener = (state: SyncState) => void;

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  unresolvedCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  syncing: false,
  pendingCount: 0,
  unresolvedCount: 0,
  lastSyncedAt: null,
  lastError: null,
};

const listeners = new Set<SyncListener>();

export function subscribe(listener: SyncListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function update(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function syncState(): SyncState {
  return state;
}

export async function refreshQueueDepth(): Promise<void> {
  const depth = await queueDepth();
  update({ pendingCount: depth.pending, unresolvedCount: depth.unresolved });
}

export async function syncNow(): Promise<SyncOutcome> {
  if (running) return { ok: false, pushed: 0, pulled: 0, conflicts: 0, offline: false };
  running = true;
  update({ syncing: true, lastError: null });

  try {
    const pushed = await drainOutbox();
    const pulled = await pullDown();

    await refreshQueueDepth();
    update({
      syncing: false,
      online: true,
      lastSyncedAt: new Date().toISOString(),
    });

    return { ok: true, pushed: pushed.sent, pulled, conflicts: pushed.conflicts, offline: false };
  } catch (error) {
    const offline = error instanceof OfflineError;
    await refreshQueueDepth();
    update({
      syncing: false,
      online: !offline,
      lastError: offline ? null : (error as Error).message,
    });

    return {
      ok: false,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      offline,
      error: offline ? undefined : (error as Error).message,
    };
  } finally {
    running = false;
  }
}

/**
 * Send everything queued, oldest first.
 *
 * Photos are uploaded before the operation that references them, so a record never points
 * at a file the server does not have. If the upload fails the whole operation waits — the
 * evidence and the record of it travel together or not at all.
 */
async function drainOutbox(): Promise<{ sent: number; conflicts: number }> {
  const queue = await pending();
  if (queue.length === 0) return { sent: 0, conflicts: 0 };

  const device = await deviceId();
  const ready: OutboxEntry[] = [];

  for (const entry of queue) {
    if (await uploadAttachments(entry)) ready.push(entry);
  }
  if (ready.length === 0) return { sent: 0, conflicts: 0 };

  await markSending(ready);

  let response;
  try {
    response = await api.push({
      deviceId: device,
      operations: ready.map((entry) => ({
        clientOpId: entry.clientOpId,
        sequence: entry.sequence,
        type: entry.type,
        jobId: entry.jobId,
        payload: entry.payload,
        clientTimestamp: entry.clientTimestamp,
      })),
    });
  } catch (error) {
    // Nothing is discarded on a failed send. The queue is the record; the network is not.
    await requeue(ready, error instanceof OfflineError ? 'No signal' : (error as Error).message);
    throw error;
  }

  for (const result of response.results) {
    await settle(result.clientOpId, result.outcome, result.message);
  }

  return { sent: response.applied + response.duplicates, conflicts: response.conflicts };
}

async function uploadAttachments(entry: OutboxEntry): Promise<boolean> {
  for (const key of entry.blobKeys ?? []) {
    const stored = await idb.get<{ storageKey: string; blob: Blob }>(STORES.blobs, key);
    if (!stored) continue;

    try {
      await api.uploadPhoto(stored.storageKey, stored.blob);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Bring down what changed.
 *
 * The cursor only advances on a completed pull. A half-applied pull that moved it would
 * skip whatever it failed to write, and the device would never learn of those jobs again.
 */
async function pullDown(): Promise<number> {
  const since = await idb.get<string>(STORES.meta, CURSOR);
  const known = (await idb.getAll<RawJob>(STORES.jobs)).map((job) => job.id);

  const payload = await api.pull({ since, knownJobIds: known });
  await applyPull(payload);

  await idb.put(STORES.meta, payload.serverTime, CURSOR);
  return payload.jobs.length;
}

export async function applyPull(payload: PullPayload): Promise<void> {
  if (payload.full) {
    // A first sync, or one after a reset: replace rather than merge, so a job deleted
    // server-side does not linger forever on the device.
    await idb.clear(STORES.jobs);
    await idb.clear(STORES.priceBook);
    await idb.clear(STORES.vanStock);
  }

  await idb.putMany(STORES.jobs, payload.jobs);
  await idb.putMany(STORES.priceBook, payload.priceBook);
  await idb.putMany(
    STORES.vanStock,
    payload.vanStock.map((line) => ({ ...line, id: line.priceBookItemId })),
  );
  await idb.putMany(STORES.checklists, payload.checklistTemplates);

  for (const jobId of payload.revokedJobIds) {
    await idb.delete(STORES.jobs, jobId);
  }
}

/**
 * Keep trying, gently.
 *
 * A tablet that retries every second in a dead zone flattens its battery by lunchtime, so
 * the interval backs off; reconnecting fires an immediate attempt, because the moment a
 * technician drives out of a basement is exactly when their morning should go up.
 */
export function startAutoSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 15_000;
  const MIN = 15_000;
  const MAX = 5 * 60_000;

  const tick = async () => {
    const outcome = await syncNow();
    delay = outcome.ok ? MIN : Math.min(delay * 2, MAX);
    timer = setTimeout(tick, delay);
  };

  const onOnline = () => {
    update({ online: true });
    delay = MIN;
    if (timer) clearTimeout(timer);
    void tick();
  };
  const onOffline = () => update({ online: false });

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  timer = setTimeout(tick, 2_000);

  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

export async function resetDevice(): Promise<void> {
  for (const store of [STORES.jobs, STORES.priceBook, STORES.vanStock, STORES.checklists, STORES.blobs]) {
    await idb.clear(store);
  }
  await idb.delete(STORES.meta, CURSOR);
}
