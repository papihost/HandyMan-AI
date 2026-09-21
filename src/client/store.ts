import { idb, STORES } from './idb';
import { enqueue } from './outbox';
import { refreshQueueDepth, syncNow } from './sync';
import type { RawJob, RawPriceItem, RawStock } from './api';

/**
 * The device's own copy of the world, and the actions a technician can take on it.
 *
 * Every action does two things: it queues an intent for the server, and it applies the
 * same change locally so the screen responds now. A tablet in a basement that waited for
 * a round trip before showing a status change would feel broken, and a technician who
 * thinks the app is broken stops using it.
 *
 * The local copy is a cache, not a second source of truth. The next pull overwrites it
 * with whatever the server says — which is how a conflict resolves itself visibly rather
 * than leaving the device quietly wrong.
 */

export interface ClientJob extends Omit<RawJob, 'lines'> {
  lines: ClientJobLine[];
}

export interface ClientJobLine {
  id: string;
  description: string;
  quantity: string;
  unitPriceCents: bigint;
  discountCents: bigint;
  category: string;
  priceBookItemId: string | null;
  isBilled: boolean;
  /** Added on the device and not yet acknowledged. Shown differently so it is honest. */
  pending?: boolean;
}

export interface ClientPriceItem extends Omit<RawPriceItem, 'priceCents'> {
  priceCents: bigint;
}

export interface ClientStockLine extends RawStock {
  id: string;
}

function toJob(raw: RawJob): ClientJob {
  return {
    ...raw,
    lines: raw.lines.map((line) => ({
      ...line,
      unitPriceCents: BigInt(line.unitPriceCents),
      discountCents: BigInt(line.discountCents),
    })),
  };
}

export async function loadJobs(): Promise<ClientJob[]> {
  const raw = await idb.getAll<RawJob>(STORES.jobs);
  return raw
    .map(toJob)
    .sort((a, b) => (a.scheduledStart ?? '9999').localeCompare(b.scheduledStart ?? '9999'));
}

export async function loadJob(id: string): Promise<ClientJob | null> {
  const raw = await idb.get<RawJob>(STORES.jobs, id);
  return raw ? toJob(raw) : null;
}

export async function loadPriceBook(): Promise<ClientPriceItem[]> {
  const raw = await idb.getAll<RawPriceItem>(STORES.priceBook);
  return raw
    .map((item) => ({ ...item, priceCents: BigInt(item.priceCents) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadVanStock(): Promise<ClientStockLine[]> {
  return (await idb.getAll<ClientStockLine>(STORES.vanStock)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** Update the device's copy of a job in place. */
async function patchJob(jobId: string, patch: (job: RawJob) => RawJob): Promise<void> {
  const raw = await idb.get<RawJob>(STORES.jobs, jobId);
  if (!raw) return;
  await idb.put(STORES.jobs, patch(raw));
}

async function act(
  type: string,
  jobId: string,
  payload: Record<string, unknown>,
  local: (job: RawJob) => RawJob,
  blobKeys?: string[],
): Promise<void> {
  await enqueue(type, payload, { jobId, blobKeys });
  await patchJob(jobId, local);
  await refreshQueueDepth();
  // Try immediately; if there is no signal the queue simply keeps it.
  void syncNow();
}

export const actions = {
  setStatus: (jobId: string, status: string) =>
    act('JOB_STATUS', jobId, { status }, (job) => ({
      ...job,
      status,
      startedAt: status === 'IN_PROGRESS' ? new Date().toISOString() : job.startedAt,
      completedAt: status === 'COMPLETED' ? new Date().toISOString() : job.completedAt,
    })),

  clockIn: (jobId: string, position?: GeolocationCoordinates) =>
    act(
      'CLOCK_IN',
      jobId,
      { kind: 'WORK', latitude: position?.latitude, longitude: position?.longitude },
      (job) => job,
    ),

  clockOut: (jobId: string, position?: GeolocationCoordinates, notes?: string) =>
    act(
      'CLOCK_OUT',
      jobId,
      { latitude: position?.latitude, longitude: position?.longitude, notes },
      (job) => job,
    ),

  addLines: (
    jobId: string,
    lines: { priceBookItemId: string; quantity: string; description: string; unitPriceCents: bigint }[],
  ) =>
    act(
      'ADD_JOB_LINES',
      jobId,
      { lines: lines.map((l) => ({ priceBookItemId: l.priceBookItemId, quantity: l.quantity })) },
      (job) => ({
        ...job,
        lines: [
          ...job.lines,
          ...lines.map((line, index) => ({
            // A temporary id: the server assigns the real one, and the next pull replaces
            // this row wholesale.
            id: `pending-${Date.now()}-${index}`,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents.toString(),
            discountCents: '0',
            category: 'MATERIAL',
            priceBookItemId: line.priceBookItemId,
            isBilled: false,
          })),
        ],
      }),
    ),

  consumeParts: async (
    jobId: string,
    lines: { priceBookItemId: string; quantity: string }[],
  ): Promise<void> => {
    await act('CONSUME_PARTS', jobId, { lines }, (job) => job);

    // Take it off the van locally too, or a technician can book out stock they no longer
    // have and only find out at the end of the day.
    for (const line of lines) {
      const stock = await idb.get<ClientStockLine>(STORES.vanStock, line.priceBookItemId);
      if (!stock) continue;
      const remaining = Number(stock.quantity) - Number(line.quantity);
      await idb.put(STORES.vanStock, { ...stock, quantity: String(Math.max(remaining, 0)) });
    }
  },

  capturePhoto: async (
    jobId: string,
    blob: Blob,
    options: { stage: string; caption?: string; pairKey?: string; position?: GeolocationCoordinates },
  ): Promise<string> => {
    const storageKey = `jobs/${jobId}/${crypto.randomUUID()}.jpg`;
    await idb.put(STORES.blobs, { storageKey, blob, jobId, stage: options.stage });

    await act(
      'ADD_PHOTO',
      jobId,
      {
        stage: options.stage,
        storageKey,
        caption: options.caption,
        pairKey: options.pairKey,
        takenAt: new Date().toISOString(),
        latitude: options.position?.latitude,
        longitude: options.position?.longitude,
      },
      (job) => ({ ...job, photoCount: job.photoCount + 1 }),
      [storageKey],
    );

    return storageKey;
  },

  captureSignature: async (
    jobId: string,
    dataUrl: string,
    options: { kind: string; signerName: string; documentHash?: string },
  ): Promise<void> => {
    const blob = await (await fetch(dataUrl)).blob();
    const storageKey = `jobs/${jobId}/signature-${crypto.randomUUID()}.png`;
    await idb.put(STORES.blobs, { storageKey, blob, jobId, stage: 'SIGNATURE' });

    await act(
      'CAPTURE_SIGNATURE',
      jobId,
      {
        kind: options.kind,
        signerName: options.signerName,
        storageKey,
        documentHash: options.documentHash,
        deviceInfo: navigator.userAgent,
      },
      (job) => job,
      [storageKey],
    );
  },

  /**
   * A quote written on site.
   *
   * Nothing about it touches this job, so there is no optimistic local change to make —
   * the quote belongs to the customer and the property, not to the call the technician
   * happens to be on. It queues like everything else and lands when there is signal.
   */
  createQuote: async (
    jobId: string,
    input: {
      title?: string;
      scopeOfWork?: string;
      options: {
        name: string;
        isRecommended?: boolean;
        lines: { priceBookItemId: string; quantity: string }[];
      }[];
      selectedOptionName?: string;
      signatureDataUrl?: string;
      signerName?: string;
    },
  ): Promise<void> => {
    let storageKey: string | undefined;
    const blobKeys: string[] = [];

    if (input.signatureDataUrl) {
      const blob = await (await fetch(input.signatureDataUrl)).blob();
      storageKey = `jobs/${jobId}/quote-${crypto.randomUUID()}.png`;
      await idb.put(STORES.blobs, { storageKey, blob, jobId, stage: 'SIGNATURE' });
      blobKeys.push(storageKey);
    }

    await act(
      'CREATE_QUOTE',
      jobId,
      {
        title: input.title,
        scopeOfWork: input.scopeOfWork,
        options: input.options,
        selectedOptionName: input.selectedOptionName,
        signatureStorageKey: storageKey,
        signerName: input.signerName,
        deviceInfo: navigator.userAgent,
      },
      (job) => job,
      blobKeys,
    );
  },

  createChangeOrder: async (
    jobId: string,
    input: {
      reason: string;
      description?: string;
      lines: { priceBookItemId: string; quantity: string; description: string; unitPriceCents: bigint }[];
      signatureDataUrl?: string;
      signerName?: string;
    },
  ): Promise<void> => {
    let storageKey: string | undefined;
    const blobKeys: string[] = [];

    if (input.signatureDataUrl) {
      const blob = await (await fetch(input.signatureDataUrl)).blob();
      storageKey = `jobs/${jobId}/change-order-${crypto.randomUUID()}.png`;
      await idb.put(STORES.blobs, { storageKey, blob, jobId, stage: 'SIGNATURE' });
      blobKeys.push(storageKey);
    }

    await act(
      'CREATE_CHANGE_ORDER',
      jobId,
      {
        reason: input.reason,
        description: input.description,
        lines: input.lines.map((l) => ({ priceBookItemId: l.priceBookItemId, quantity: l.quantity })),
        signatureStorageKey: storageKey,
        signerName: input.signerName,
        deviceInfo: navigator.userAgent,
      },
      (job) => ({
        ...job,
        lines: [
          ...job.lines,
          ...input.lines.map((line, index) => ({
            id: `pending-co-${Date.now()}-${index}`,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents.toString(),
            discountCents: '0',
            category: 'MATERIAL',
            priceBookItemId: line.priceBookItemId,
            isBilled: false,
          })),
        ],
      }),
      blobKeys,
    );
  },

  addNote: (jobId: string, body: string, isInternal = true) =>
    act('ADD_JOB_NOTE', jobId, { body, isInternal }, (job) => job),
};

/** Local photos for a job, for showing what has been taken before it has uploaded. */
export async function localPhotos(jobId: string): Promise<{ storageKey: string; blob: Blob; stage: string }[]> {
  const all = await idb.getAll<{ storageKey: string; blob: Blob; jobId: string; stage: string }>(
    STORES.blobs,
  );
  return all.filter((b) => b.jobId === jobId && b.stage !== 'SIGNATURE');
}

/** `12500n` → `"125.00"`. */
export function money(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function lineTotal(line: ClientJobLine): bigint {
  const quantityMilli = BigInt(Math.round(Number(line.quantity) * 1000));
  return (quantityMilli * line.unitPriceCents) / 1000n - line.discountCents;
}

export function jobTotal(job: ClientJob): bigint {
  return job.lines.reduce((total, line) => total + lineTotal(line), 0n);
}
