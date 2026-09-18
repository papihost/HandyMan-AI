// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { idb, STORES } from './idb';
import {
  acknowledge,
  deviceId,
  enqueue,
  markSending,
  nextSequence,
  pending,
  queueDepth,
  requeue,
  settle,
  unresolved,
} from './outbox';

/**
 * The outbox is the only thing standing between a technician's morning and a dead zone.
 * These are the properties it has to hold.
 */

beforeEach(async () => {
  for (const store of Object.values(STORES)) await idb.clear(store);
});

describe('device identity', () => {
  it('mints an id once and keeps it', async () => {
    const first = await deviceId();
    const second = await deviceId();

    expect(first).toBe(second);
    expect(first.startsWith('dev_')).toBe(true);
  });
});

describe('sequence numbers', () => {
  it('increases, and does not reuse a number after the queue drains', async () => {
    const entry = await enqueue('ADD_JOB_NOTE', { body: 'one' }, { jobId: 'job-1' });
    expect(entry.sequence).toBe(1);

    // Acknowledged work leaves the queue. Deriving the next number from the queue's length
    // would hand out 1 again, and the server would apply a morning in the wrong order.
    await settle(entry.clientOpId, 'APPLIED');
    expect(await pending()).toHaveLength(0);

    const next = await enqueue('ADD_JOB_NOTE', { body: 'two' }, { jobId: 'job-1' });
    expect(next.sequence).toBe(2);
  });

  it('keeps counting across a reload', async () => {
    await nextSequence();
    await nextSequence();
    expect(await nextSequence()).toBe(3);
  });
});

describe('queueing', () => {
  it('returns work in the order it was done, not the order it was stored', async () => {
    const a = await enqueue('JOB_STATUS', { status: 'EN_ROUTE' }, { jobId: 'job-1' });
    const b = await enqueue('JOB_STATUS', { status: 'IN_PROGRESS' }, { jobId: 'job-1' });
    const c = await enqueue('JOB_STATUS', { status: 'COMPLETED' }, { jobId: 'job-1' });

    // IndexedDB returns rows by key, which is a random uuid.
    const queue = await pending();
    expect(queue.map((e) => e.clientOpId)).toEqual([a.clientOpId, b.clientOpId, c.clientOpId]);
  });

  it('stamps the technician’s own clock', async () => {
    const at = new Date('2026-05-20T09:15:00.000Z');
    const entry = await enqueue('CLOCK_IN', {}, { jobId: 'job-1', at });

    // A job worked at 9am underground is a 9am job, whenever the server hears about it.
    expect(entry.clientTimestamp).toBe(at.toISOString());
  });

  it('gives every operation its own id', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      ids.add((await enqueue('ADD_JOB_NOTE', { body: String(i) }, { jobId: 'job-1' })).clientOpId);
    }
    expect(ids.size).toBe(25);
  });
});

describe('settling', () => {
  it('clears anything the server has accepted, including a duplicate', async () => {
    for (const outcome of ['APPLIED', 'DUPLICATE', 'NOOP'] as const) {
      const entry = await enqueue('ADD_JOB_NOTE', { body: outcome }, { jobId: 'job-1' });
      await settle(entry.clientOpId, outcome);
    }

    expect(await pending()).toHaveLength(0);
    expect(await unresolved()).toHaveLength(0);
  });

  it('keeps a conflict, with its reason, so the technician is told', async () => {
    const entry = await enqueue('ADD_JOB_LINES', { lines: [] }, { jobId: 'job-1' });
    await settle(entry.clientOpId, 'CONFLICT', 'Job was reassigned');

    const left = await unresolved();
    expect(left).toHaveLength(1);
    expect(left[0].lastError).toBe('Job was reassigned');
    // And it is out of the sending queue, so it is not retried forever.
    expect(await pending()).toHaveLength(0);
  });

  it('drops the photo once its operation is accepted', async () => {
    await idb.put(STORES.blobs, { storageKey: 'jobs/1/a.jpg', blob: new Blob(['x']) });
    const entry = await enqueue(
      'ADD_PHOTO',
      { storageKey: 'jobs/1/a.jpg' },
      { jobId: 'job-1', blobKeys: ['jobs/1/a.jpg'] },
    );

    await settle(entry.clientOpId, 'APPLIED');
    expect(await idb.get(STORES.blobs, 'jobs/1/a.jpg')).toBeUndefined();
  });

  it('keeps the photo while its operation is unresolved', async () => {
    await idb.put(STORES.blobs, { storageKey: 'jobs/1/b.jpg', blob: new Blob(['x']) });
    const entry = await enqueue(
      'ADD_PHOTO',
      { storageKey: 'jobs/1/b.jpg' },
      { jobId: 'job-1', blobKeys: ['jobs/1/b.jpg'] },
    );

    await settle(entry.clientOpId, 'CONFLICT', 'Job closed');
    expect(await idb.get(STORES.blobs, 'jobs/1/b.jpg')).toBeDefined();
  });
});

describe('a failed send', () => {
  it('puts the work back rather than losing it', async () => {
    const entries = [
      await enqueue('ADD_JOB_NOTE', { body: 'one' }, { jobId: 'job-1' }),
      await enqueue('ADD_JOB_NOTE', { body: 'two' }, { jobId: 'job-1' }),
    ];

    await markSending(entries);
    await requeue(entries, 'No signal');

    const queue = await pending();
    expect(queue).toHaveLength(2);
    expect(queue.every((e) => e.status === 'PENDING')).toBe(true);
    expect(queue[0].lastError).toBe('No signal');
    // The attempt is counted, so a persistent failure is visible rather than invisible.
    expect(queue[0].attempts).toBe(1);
  });

  it('does not resurrect something the server settled mid-flight', async () => {
    const entry = await enqueue('ADD_JOB_NOTE', { body: 'one' }, { jobId: 'job-1' });
    await markSending([entry]);
    await settle(entry.clientOpId, 'APPLIED');

    await requeue([entry], 'No signal');
    expect(await pending()).toHaveLength(0);
  });
});

describe('queue depth', () => {
  it('counts what is waiting and what needs a person', async () => {
    await enqueue('ADD_JOB_NOTE', { body: 'waiting' }, { jobId: 'job-1' });
    const conflicted = await enqueue('ADD_JOB_NOTE', { body: 'stuck' }, { jobId: 'job-1' });
    await settle(conflicted.clientOpId, 'CONFLICT', 'Reassigned');

    expect(await queueDepth()).toEqual({ pending: 1, unresolved: 1 });

    await acknowledge(conflicted.clientOpId);
    expect(await queueDepth()).toEqual({ pending: 1, unresolved: 0 });
  });
});
