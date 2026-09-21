import type { JobStatus, PrismaClient } from '@prisma/client';
import {
  customerSignedContextFor,
  postingContextFor,
  systemContext,
  type AuthContext,
} from '../auth/context';
import { NotFoundError, ValidationError } from '../errors';
import { ZERO, type Cents } from '../money';
import { postJournalEntry } from '../accounting/ledger';
import { laborCostedLines } from '../accounting/rules/labor';
import { nextDocumentNumber } from '../accounting/sequences';
import { addJobLines, canTransition } from '../jobs/service';
import { refreshJobRollup } from '../jobs/costing';
import { consumePartsForJob } from '../inventory/service';

/**
 * What a technician's device can do while it is offline.
 *
 * The outbox replays **intent, not state**. A device sends "add these two lines", never
 * "the job's lines are now these" — because a tablet that has been out of signal for three
 * hours holds a stale copy, and last-write-wins on whole records would silently discard
 * whatever the dispatcher changed in the meantime. Intents compose; snapshots overwrite.
 */

export type FieldOperationType =
  | 'JOB_STATUS'
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'ADD_JOB_LINES'
  | 'CONSUME_PARTS'
  | 'ADD_PHOTO'
  | 'CAPTURE_SIGNATURE'
  | 'CREATE_CHANGE_ORDER'
  | 'CREATE_QUOTE'
  | 'COMPLETE_CHECKLIST'
  | 'ADD_JOB_NOTE';

export interface ClientOperation {
  /** Generated on the device. The idempotency key that makes retrying safe. */
  clientOpId: string;
  /** Monotonic per device. Decides the order operations are applied in. */
  sequence: number;
  type: FieldOperationType;
  jobId?: string;
  payload: Record<string, unknown>;
  /** When the technician did it, which is not when the server heard about it. */
  clientTimestamp: string;
}

export type OperationOutcome = 'APPLIED' | 'DUPLICATE' | 'NOOP' | 'CONFLICT' | 'REJECTED';

export interface OperationResult {
  clientOpId: string;
  sequence: number;
  type: FieldOperationType;
  outcome: OperationOutcome;
  message?: string;
  entityId?: string;
  /** Anything the device should adopt, such as a server-assigned id. */
  serverData?: Record<string, unknown>;
}

export interface HandlerContext {
  db: PrismaClient;
  ctx: AuthContext;
  technicianId: string;
  operation: ClientOperation;
  occurredAt: Date;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** A no-op: the server already reflects what the device is asking for. */
export class AlreadyDoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyDoneError';
  }
}

/**
 * The job a field operation targets, with the checks every operation shares.
 *
 * A job can be reassigned or invoiced while a tablet is out of signal. Both are ordinary
 * and both mean the queued change must not simply land.
 */
async function loadTargetJob(handler: HandlerContext, options: { allowBilled?: boolean } = {}) {
  const { db, ctx, operation, technicianId } = handler;
  if (!operation.jobId) throw new ValidationError(`${operation.type} needs a job`);

  const job = await db.job.findFirst({
    where: { id: operation.jobId, organizationId: ctx.organizationId },
    select: {
      id: true,
      jobNo: true,
      status: true,
      locationId: true,
      serviceTypeId: true,
      isBillable: true,
      assignments: { select: { technicianId: true } },
    },
  });
  if (!job) throw new NotFoundError('Job', operation.jobId);

  if (!job.assignments.some((a) => a.technicianId === technicianId)) {
    throw new ConflictError(
      `Job ${job.jobNo} was reassigned while your device was offline — your change was not applied`,
    );
  }

  if (job.status === 'CANCELLED') {
    throw new ConflictError(`Job ${job.jobNo} was cancelled while your device was offline`);
  }

  if (!options.allowBilled && ['INVOICED', 'PAID', 'CLOSED'].includes(job.status)) {
    throw new ConflictError(
      `Job ${job.jobNo} has already been invoiced — your change was not applied. Raise a change order or speak to the office.`,
    );
  }

  return job;
}

type Handler = (handler: HandlerContext) => Promise<{ entityId?: string; serverData?: Record<string, unknown>; message?: string }>;

// ---------------------------------------------------------------- status

/**
 * Status changes queued offline arrive late and often out of date.
 *
 * A device that recorded "en route" an hour ago, when the job has since been completed by
 * another route, is not in conflict — it is behind. Asking for a status the job has
 * already passed is a no-op, not an error, or every reconnection would produce a screenful
 * of failures for work that went fine.
 */
const STATUS_ORDER: JobStatus[] = [
  'DRAFT', 'QUOTED', 'APPROVED', 'SCHEDULED', 'DISPATCHED', 'EN_ROUTE',
  'IN_PROGRESS', 'COMPLETED', 'INVOICED', 'PAID', 'CLOSED',
];

const jobStatus: Handler = async (handler) => {
  const job = await loadTargetJob(handler, { allowBilled: true });
  const target = handler.operation.payload.status as JobStatus;

  if (!STATUS_ORDER.includes(target)) {
    throw new ValidationError(`${target} is not a status a device may set`);
  }

  const currentIndex = STATUS_ORDER.indexOf(job.status);
  const targetIndex = STATUS_ORDER.indexOf(target);

  if (job.status === target || (currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex)) {
    throw new AlreadyDoneError(`Job ${job.jobNo} is already ${job.status}`);
  }
  if (!canTransition(job.status, target)) {
    throw new ConflictError(`Job ${job.jobNo} cannot move from ${job.status} to ${target}`);
  }

  const now = new Date();
  await handler.db.job.update({
    where: { id: job.id },
    data: {
      status: target,
      ...(target === 'IN_PROGRESS' ? { startedAt: handler.occurredAt } : {}),
      ...(target === 'COMPLETED' ? { completedAt: handler.occurredAt } : {}),
      updatedAt: now,
    },
  });

  return { entityId: job.id, message: `Job ${job.jobNo} is now ${target}` };
};

// ---------------------------------------------------------------- time

const clockIn: Handler = async (handler) => {
  const job = handler.operation.jobId ? await loadTargetJob(handler) : null;

  const open = await handler.db.timeEntry.findFirst({
    where: { technicianId: handler.technicianId, endedAt: null },
    select: { id: true, jobId: true },
  });
  if (open) {
    if (open.jobId === (job?.id ?? null)) {
      throw new AlreadyDoneError('Already clocked in to this job');
    }
    throw new ConflictError('Already clocked in to another job — clock out of it first');
  }

  const entry = await handler.db.timeEntry.create({
    data: {
      technicianId: handler.technicianId,
      jobId: job?.id ?? null,
      kind: (handler.operation.payload.kind as 'WORK' | 'TRAVEL') ?? 'WORK',
      startedAt: handler.occurredAt,
      startLat: coord(handler.operation.payload.latitude),
      startLng: coord(handler.operation.payload.longitude),
      isBillable: handler.operation.payload.kind !== 'TRAVEL',
    },
  });

  return { entityId: entry.id, serverData: { timeEntryId: entry.id } };
};

/**
 * Clocking out is where field time becomes cost.
 *
 * The technician's loaded rate is read as it stood on the day the work happened, not as it
 * stands now, so a rate change next month never restates a job that closed today. Wage and
 * burden post separately, so the burden is a number an owner can see rather than one
 * buried inside a labour figure.
 */
const clockOut: Handler = async (handler) => {
  const entry = await handler.db.timeEntry.findFirst({
    where: { technicianId: handler.technicianId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (!entry) throw new AlreadyDoneError('Not clocked in');

  const endedAt = handler.occurredAt;
  if (endedAt <= entry.startedAt) {
    throw new ValidationError('Clock-out is not after clock-in');
  }
  const minutes = Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 60_000);

  const rate = await handler.db.technicianRate.findFirst({
    where: {
      technicianId: handler.technicianId,
      effectiveFrom: { lte: entry.startedAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: entry.startedAt } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  const loaded = rate?.loadedHourlyCents ?? ZERO;
  const base = rate?.baseHourlyCents ?? ZERO;
  const costCents = (BigInt(minutes) * loaded) / 60n;

  await handler.db.timeEntry.update({
    where: { id: entry.id },
    data: {
      endedAt,
      minutes,
      endLat: coord(handler.operation.payload.latitude),
      endLng: coord(handler.operation.payload.longitude),
      loadedHourlyCents: loaded,
      costCents,
      notes: (handler.operation.payload.notes as string) ?? null,
    },
  });

  let journalEntryId: string | null = null;
  if (entry.jobId && entry.isBillable && loaded > ZERO && minutes > 0) {
    const job = await handler.db.job.findUniqueOrThrow({
      where: { id: entry.jobId },
      select: { locationId: true, serviceTypeId: true },
    });

    const hours = (minutes / 60).toFixed(2);
    // A technician has no ledger authority of their own; the posting rules do.
    const posting = await postJournalEntry(handler.db, postingContextFor(handler.ctx), {
      entryDate: entry.startedAt,
      source: 'PAYROLL',
      sourceType: 'TimeEntry',
      sourceId: entry.id,
      memo: `Field time — ${hours} hrs`,
      lines: laborCostedLines({
        jobId: entry.jobId,
        locationId: job.locationId,
        technicianId: handler.technicianId,
        serviceTypeId: job.serviceTypeId,
        hours,
        baseHourlyCents: base,
        loadedHourlyCents: loaded,
      }),
    });
    journalEntryId = posting.id;

    await refreshJobRollup(
      handler.db,
      systemContext(handler.ctx.organizationId, handler.ctx.userId),
      entry.jobId,
    );
  }

  return {
    entityId: entry.id,
    serverData: { minutes, journalEntryId },
    message: `${minutes} minutes recorded`,
  };
};

// ---------------------------------------------------------------- work

const addJobLinesOp: Handler = async (handler) => {
  const job = await loadTargetJob(handler);
  const lines = handler.operation.payload.lines as {
    priceBookItemId?: string;
    description?: string;
    quantity: string;
    unitPriceCents?: string;
    discountCents?: string;
  }[];

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('No lines to add');
  }

  const created = await addJobLines(
    handler.db,
    handler.ctx,
    job.id,
    lines.map((line) => ({
      priceBookItemId: line.priceBookItemId,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents !== undefined ? BigInt(line.unitPriceCents) : undefined,
      discountCents: line.discountCents !== undefined ? BigInt(line.discountCents) : undefined,
    })),
  );

  await handler.db.job.update({ where: { id: job.id }, data: { updatedAt: new Date() } });
  return { entityId: job.id, serverData: { lineCount: created.length } };
};

const consumeParts: Handler = async (handler) => {
  const job = await loadTargetJob(handler);
  const lines = handler.operation.payload.lines as { priceBookItemId: string; quantity: string }[];
  if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError('No parts to record');

  const van = await handler.db.stockLocation.findFirst({
    where: {
      organizationId: handler.ctx.organizationId,
      technicianId: handler.technicianId,
      kind: 'VAN',
      isActive: true,
    },
    select: { id: true },
  });
  if (!van) throw new ValidationError('No van stock location is set up for you');

  const consumed = await consumePartsForJob(handler.db, handler.ctx, {
    jobId: job.id,
    stockLocationId: van.id,
    technicianId: handler.technicianId,
    occurredAt: handler.occurredAt,
    lines,
  });

  return {
    entityId: job.id,
    serverData: { journalEntryId: consumed.journalEntryId },
    message: `${lines.length} part lines taken off the van`,
  };
};

// ---------------------------------------------------------------- evidence

/**
 * Photo metadata. The image itself uploads separately and may arrive much later — a
 * technician on a rural route will queue forty photos and send them over the depot's wifi
 * that evening. The record exists as soon as the shutter closes, so the job's
 * documentation is never waiting on a file transfer.
 */
const addPhoto: Handler = async (handler) => {
  const job = await loadTargetJob(handler, { allowBilled: true });
  const payload = handler.operation.payload;

  const photo = await handler.db.photo.create({
    data: {
      jobId: job.id,
      stage: (payload.stage as 'BEFORE' | 'DURING' | 'AFTER' | 'DAMAGE' | 'RECEIPT') ?? 'OTHER',
      pairKey: (payload.pairKey as string) ?? null,
      storageKey: payload.storageKey as string,
      caption: (payload.caption as string) ?? null,
      takenAt: payload.takenAt ? new Date(payload.takenAt as string) : handler.occurredAt,
      latitude: coord(payload.latitude),
      longitude: coord(payload.longitude),
      exif: (payload.exif as object) ?? undefined,
      contentHash: (payload.contentHash as string) ?? null,
      capturedByUserId: handler.ctx.userId,
      isCustomerVisible: payload.isCustomerVisible !== false,
    },
  });

  return { entityId: photo.id };
};

const captureSignature: Handler = async (handler) => {
  const job = await loadTargetJob(handler, { allowBilled: true });
  const payload = handler.operation.payload;
  const kind = payload.kind as
    | 'QUOTE_APPROVAL'
    | 'CHANGE_ORDER_APPROVAL'
    | 'WORK_AUTHORIZATION'
    | 'COMPLETION'
    | 'PAYMENT_AUTHORIZATION';

  const existing = await handler.db.signature.findFirst({
    where: { jobId: job.id, kind },
    select: { id: true },
  });
  if (existing) {
    throw new AlreadyDoneError('A signature of this kind has already been captured for this job');
  }

  const signature = await handler.db.signature.create({
    data: {
      jobId: job.id,
      kind,
      signerName: payload.signerName as string,
      signerRole: (payload.signerRole as string) ?? null,
      storageKey: payload.storageKey as string,
      signedAt: handler.occurredAt,
      ipAddress: (payload.ipAddress as string) ?? null,
      deviceInfo: (payload.deviceInfo as string) ?? null,
      latitude: coord(payload.latitude),
      longitude: coord(payload.longitude),
      // A hash of what was on screen, so the terms cannot be altered after signing.
      documentHash: (payload.documentHash as string) ?? null,
    },
  });

  return { entityId: signature.id };
};

// ---------------------------------------------------------------- change orders

/**
 * Work found on site, beyond what was quoted.
 *
 * The single biggest margin leak in this trade is a technician opening a wall, finding
 * something, fixing it, and nobody ever billing for it. A change order raised and signed
 * before the extra work starts is what turns that into revenue.
 */
const createChangeOrder: Handler = async (handler) => {
  const job = await loadTargetJob(handler);
  const payload = handler.operation.payload;
  const lines = (payload.lines ?? []) as {
    priceBookItemId?: string;
    description?: string;
    quantity: string;
    unitPriceCents?: string;
  }[];

  if (lines.length === 0) throw new ValidationError('A change order needs at least one line');
  if (!payload.reason) throw new ValidationError('A change order needs a reason');

  return handler.db.$transaction(async (tx) => {
    const count = await tx.changeOrder.count({ where: { jobId: job.id } });
    const changeOrderNo = `CO-${String(count + 1).padStart(2, '0')}`;

    let signatureId: string | null = null;
    if (payload.signatureStorageKey) {
      const signature = await tx.signature.create({
        data: {
          jobId: job.id,
          kind: 'CHANGE_ORDER_APPROVAL',
          signerName: (payload.signerName as string) ?? 'Customer',
          storageKey: payload.signatureStorageKey as string,
          signedAt: handler.occurredAt,
          latitude: coord(payload.latitude),
          longitude: coord(payload.longitude),
          deviceInfo: (payload.deviceInfo as string) ?? null,
        },
      });
      signatureId = signature.id;
    }

    const changeOrder = await tx.changeOrder.create({
      data: {
        jobId: job.id,
        changeOrderNo,
        status: signatureId ? 'APPROVED' : 'PENDING_APPROVAL',
        reason: payload.reason as string,
        description: (payload.description as string) ?? null,
        requestedByTechnicianId: handler.technicianId,
        approvedAt: signatureId ? handler.occurredAt : null,
        signatureId,
      },
    });

    return { changeOrder, job };
  }).then(async ({ changeOrder, job: target }) => {
    // Lines are added through the normal path so they price against the price book and
    // land on the job exactly like any other work.
    await addJobLines(
      handler.db,
      handler.ctx,
      target.id,
      lines.map((line) => ({
        priceBookItemId: line.priceBookItemId,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents !== undefined ? BigInt(line.unitPriceCents) : undefined,
        changeOrderId: changeOrder.id,
      })),
    );

    return {
      entityId: changeOrder.id,
      serverData: { changeOrderNo: changeOrder.changeOrderNo, status: changeOrder.status },
    };
  });
};

// ---------------------------------------------------------------- forms

const completeChecklist: Handler = async (handler) => {
  const job = await loadTargetJob(handler, { allowBilled: true });
  const payload = handler.operation.payload;
  const templateId = payload.templateId as string;

  const template = await handler.db.checklistTemplate.findFirst({
    where: { id: templateId, organizationId: handler.ctx.organizationId },
    select: { id: true },
  });
  if (!template) throw new NotFoundError('Checklist template', templateId);

  const existing = await handler.db.checklistInstance.findFirst({
    where: { jobId: job.id, templateId },
    select: { id: true, completedAt: true },
  });

  if (existing?.completedAt) {
    throw new AlreadyDoneError('This checklist has already been completed for this job');
  }

  const instance = existing
    ? await handler.db.checklistInstance.update({
        where: { id: existing.id },
        data: {
          responses: payload.responses as object,
          completedAt: handler.occurredAt,
          completedByUserId: handler.ctx.userId,
        },
      })
    : await handler.db.checklistInstance.create({
        data: {
          jobId: job.id,
          templateId,
          responses: payload.responses as object,
          completedAt: handler.occurredAt,
          completedByUserId: handler.ctx.userId,
        },
      });

  return { entityId: instance.id };
};

const addJobNote: Handler = async (handler) => {
  const job = await loadTargetJob(handler, { allowBilled: true });
  const note = await handler.db.jobNote.create({
    data: {
      jobId: job.id,
      body: handler.operation.payload.body as string,
      isInternal: handler.operation.payload.isInternal !== false,
      authorUserId: handler.ctx.userId,
      createdAt: handler.occurredAt,
    },
  });
  return { entityId: note.id };
};

// ---------------------------------------------------------------- quoting

/**
 * A quote written at the kitchen table.
 *
 * Work found on site that is not this job's work — a water heater on its last legs noticed
 * while fixing a tap. The technician is standing there, the customer is standing there, and
 * the alternative is a promise to "get someone to call you", which is where most of this
 * trade's revenue quietly goes.
 *
 * Options rather than a single price, because a customer offered one number decides yes or
 * no, and a customer offered three decides which. The price book travels to the device, so
 * this composes offline like everything else: the quote is written at the table and posted
 * when there is signal.
 *
 * A signature approves it on the spot. Approval is the customer's authority, not the
 * technician's — see `customerSignedContextFor` — so without a signature the quote is
 * created and left for the office to chase.
 */
const createQuote: Handler = async (handler) => {
  const { db, ctx, operation, technicianId, occurredAt } = handler;
  const payload = operation.payload;

  const job = await loadTargetJob(handler, { allowBilled: true });

  const options = (payload.options ?? []) as {
    name?: string;
    description?: string;
    isRecommended?: boolean;
    lines?: {
      priceBookItemId?: string;
      description?: string;
      quantity?: string;
      unitPriceCents?: string;
    }[];
  }[];

  const usable = options
    .map((option) => ({
      name: option.name?.trim() || 'Proposed work',
      description: option.description?.trim() || undefined,
      isRecommended: option.isRecommended === true,
      lines: (option.lines ?? [])
        .filter((line) => line.priceBookItemId || line.description)
        .map((line) => ({
          priceBookItemId: line.priceBookItemId,
          description: line.description,
          quantity: line.quantity ?? '1',
          ...(line.unitPriceCents ? { unitPriceCents: amountFrom(line.unitPriceCents) } : {}),
        })),
    }))
    .filter((option) => option.lines.length > 0);

  if (usable.length === 0) throw new ValidationError('A quote needs at least one line');

  const target = await db.job.findUniqueOrThrow({
    where: { id: job.id },
    select: { customerId: true, propertyId: true, locationId: true },
  });

  const { createQuote: create, approveQuote: approve } = await import('../quotes/service');

  const quote = await create(db, ctx, {
    locationId: target.locationId,
    customerId: target.customerId,
    propertyId: target.propertyId,
    title: (payload.title as string) ?? 'Work found on site',
    scopeOfWork: (payload.scopeOfWork as string) ?? undefined,
    presentedByTechnicianId: technicianId,
    validForDays: typeof payload.validForDays === 'number' ? payload.validForDays : undefined,
    options: usable,
  });

  // Signed at the table: the customer accepted before the technician left.
  if (payload.signatureStorageKey) {
    const chosen = payload.selectedOptionName
      ? quote.options.find((option) => option.name === payload.selectedOptionName)
      : quote.options.find((option) => option.isRecommended) ?? quote.options[0];

    await approve(db, customerSignedContextFor(ctx), quote.id, {
      quoteOptionId: chosen?.id,
      signerName: (payload.signerName as string) ?? 'Customer',
      signerRole: (payload.signerRole as string) ?? undefined,
      signatureStorageKey: payload.signatureStorageKey as string,
      deviceInfo: (payload.deviceInfo as string) ?? undefined,
    });
  }

  return {
    entityId: quote.id,
    serverData: {
      quoteNo: quote.quoteNo,
      totalCents: quote.totalCents.toString(),
      approved: Boolean(payload.signatureStorageKey),
      presentedAt: occurredAt.toISOString(),
    },
  };
};

export const HANDLERS: Record<FieldOperationType, Handler> = {
  JOB_STATUS: jobStatus,
  CLOCK_IN: clockIn,
  CLOCK_OUT: clockOut,
  ADD_JOB_LINES: addJobLinesOp,
  CONSUME_PARTS: consumeParts,
  ADD_PHOTO: addPhoto,
  CAPTURE_SIGNATURE: captureSignature,
  CREATE_CHANGE_ORDER: createChangeOrder,
  CREATE_QUOTE: createQuote,
  COMPLETE_CHECKLIST: completeChecklist,
  ADD_JOB_NOTE: addJobNote,
};

function coord(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(7) : null;
}

export function amountFrom(value: unknown): Cents {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
  return ZERO;
}

export { nextDocumentNumber };
