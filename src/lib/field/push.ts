import { Prisma, type PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { AppError, ValidationError } from '../errors';
import {
  AlreadyDoneError,
  ConflictError,
  HANDLERS,
  type ClientOperation,
  type OperationOutcome,
  type OperationResult,
} from './operations';

/**
 * Draining a device's outbox.
 *
 * Three properties have to hold, and each one corresponds to something that genuinely
 * happens to a tablet in the field.
 *
 * **Replaying is safe.** A device sends its queue, the response is lost on a flaky
 * connection, and it sends the same queue again. Every operation carries an id generated on
 * the device, unique per device in the database, so the second attempt returns the first
 * attempt's answer rather than doing the work twice. Without this, one dropped response
 * bills a customer twice.
 *
 * **Order is preserved.** Operations apply in the device's own sequence, so "en route",
 * "in progress" and "completed", queued over three hours underground, land in that order
 * rather than in whatever order the network delivers them.
 *
 * **One failure does not strand the rest.** Each operation is settled independently. A
 * technician whose second job was reassigned still gets the other five recorded, and is
 * told plainly about the one that was not.
 */

export interface PushRequest {
  deviceId: string;
  operations: ClientOperation[];
}

export interface PushResponse {
  serverTime: Date;
  results: OperationResult[];
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
}

const MAX_BATCH = 500;

export async function pushOperations(
  db: PrismaClient,
  ctx: AuthContext,
  request: PushRequest,
): Promise<PushResponse> {
  requirePermission(ctx, PERMISSIONS.FIELD_APP);

  if (!ctx.technicianId) {
    throw new ValidationError('This account is not linked to a technician record');
  }
  if (!request.deviceId) throw new ValidationError('A device id is required');
  if (request.operations.length > MAX_BATCH) {
    throw new ValidationError(`Send at most ${MAX_BATCH} operations at a time`);
  }

  const serverTime = new Date();
  const ordered = [...request.operations].sort((a, b) => a.sequence - b.sequence);
  const results: OperationResult[] = [];

  for (const operation of ordered) {
    results.push(await settleOne(db, ctx, request.deviceId, operation));
  }

  return {
    serverTime,
    results,
    applied: results.filter((r) => r.outcome === 'APPLIED' || r.outcome === 'NOOP').length,
    duplicates: results.filter((r) => r.outcome === 'DUPLICATE').length,
    conflicts: results.filter((r) => r.outcome === 'CONFLICT').length,
    rejected: results.filter((r) => r.outcome === 'REJECTED').length,
  };
}

async function settleOne(
  db: PrismaClient,
  ctx: AuthContext,
  deviceId: string,
  operation: ClientOperation,
): Promise<OperationResult> {
  const base = {
    clientOpId: operation.clientOpId,
    sequence: operation.sequence,
    type: operation.type,
  };

  const handler = HANDLERS[operation.type];
  if (!handler) {
    return { ...base, outcome: 'REJECTED', message: `Unknown operation ${operation.type}` };
  }

  const clientTimestamp = new Date(operation.clientTimestamp);
  if (Number.isNaN(clientTimestamp.getTime())) {
    return { ...base, outcome: 'REJECTED', message: 'Invalid timestamp' };
  }

  // Claim the operation before doing the work. The unique index on (deviceId, clientOpId)
  // is what makes this a claim rather than a hope: a concurrent retry loses the insert and
  // takes the branch below instead of running the handler a second time.
  let claimed = false;
  try {
    await db.syncOperation.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        deviceId,
        clientOpId: operation.clientOpId,
        sequence: operation.sequence,
        entityType: operation.type,
        entityId: operation.jobId ?? null,
        operation: operation.type,
        payload: operation.payload as Prisma.InputJsonValue,
        status: 'PENDING',
        clientTimestamp,
      },
    });
    claimed = true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
  }

  if (!claimed) {
    return describeExisting(db, deviceId, operation, base);
  }

  try {
    const outcome = await handler({
      db,
      ctx,
      technicianId: ctx.technicianId!,
      operation,
      // The technician's own clock: when the work happened, not when the server heard.
      occurredAt: clientTimestamp,
    });

    await db.syncOperation.updateMany({
      where: { deviceId, clientOpId: operation.clientOpId },
      data: {
        status: 'APPLIED',
        appliedAt: new Date(),
        entityId: outcome.entityId ?? operation.jobId ?? null,
        resolvedPayload: {
          outcome: 'APPLIED',
          entityId: outcome.entityId ?? null,
          message: outcome.message ?? null,
          serverData: outcome.serverData ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      ...base,
      outcome: 'APPLIED',
      entityId: outcome.entityId,
      serverData: outcome.serverData,
      message: outcome.message,
    };
  } catch (error) {
    return settleFailure(db, deviceId, operation, base, error);
  }
}

async function settleFailure(
  db: PrismaClient,
  deviceId: string,
  operation: ClientOperation,
  base: Pick<OperationResult, 'clientOpId' | 'sequence' | 'type'>,
  error: unknown,
): Promise<OperationResult> {
  // Already true on the server: the device was behind, not wrong. Recorded as settled so a
  // replay does not keep re-reporting it.
  if (error instanceof AlreadyDoneError) {
    await markSettled(db, deviceId, operation, 'APPLIED', 'NOOP', error.message);
    return { ...base, outcome: 'NOOP', message: error.message };
  }

  if (error instanceof ConflictError) {
    await markSettled(db, deviceId, operation, 'CONFLICT', 'CONFLICT', error.message);
    return { ...base, outcome: 'CONFLICT', message: error.message };
  }

  if (error instanceof AppError) {
    await markSettled(db, deviceId, operation, 'REJECTED', 'REJECTED', error.message);
    return { ...base, outcome: 'REJECTED', message: error.message };
  }

  // Something unexpected. The claim row is removed so the device's next attempt is a fresh
  // one rather than being told, forever, that a previous attempt is still in progress.
  await db.syncOperation.deleteMany({ where: { deviceId, clientOpId: operation.clientOpId } });
  throw error;
}

async function markSettled(
  db: PrismaClient,
  deviceId: string,
  operation: ClientOperation,
  status: 'APPLIED' | 'CONFLICT' | 'REJECTED',
  outcome: OperationOutcome,
  message: string,
): Promise<void> {
  await db.syncOperation.updateMany({
    where: { deviceId, clientOpId: operation.clientOpId },
    data: {
      status,
      appliedAt: new Date(),
      conflictReason: status === 'APPLIED' ? null : message,
      resolvedPayload: { outcome, message } as Prisma.InputJsonValue,
    },
  });
}

/**
 * An operation this device has sent before.
 *
 * The stored answer is returned rather than the work being redone. A row still marked
 * pending means an earlier attempt started and never finished — a crash or a lost
 * connection mid-write — and that is reported honestly instead of being retried blindly,
 * because a half-applied operation replayed is how a customer gets billed twice.
 */
async function describeExisting(
  db: PrismaClient,
  deviceId: string,
  operation: ClientOperation,
  base: Pick<OperationResult, 'clientOpId' | 'sequence' | 'type'>,
): Promise<OperationResult> {
  const existing = await db.syncOperation.findUnique({
    where: { deviceId_clientOpId: { deviceId, clientOpId: operation.clientOpId } },
    select: { status: true, conflictReason: true, entityId: true, resolvedPayload: true },
  });

  if (!existing) {
    return { ...base, outcome: 'REJECTED', message: 'Operation could not be recorded' };
  }

  const stored = (existing.resolvedPayload ?? {}) as {
    outcome?: OperationOutcome;
    message?: string | null;
    serverData?: Record<string, unknown> | null;
  };

  if (existing.status === 'PENDING') {
    return {
      ...base,
      outcome: 'REJECTED',
      message:
        'A previous attempt at this operation did not finish. It has been left alone — check the job before sending it again.',
    };
  }

  return {
    ...base,
    outcome: existing.status === 'APPLIED' ? 'DUPLICATE' : (stored.outcome ?? 'CONFLICT'),
    entityId: existing.entityId ?? undefined,
    serverData: stored.serverData ?? undefined,
    message: stored.message ?? existing.conflictReason ?? 'Already received',
  };
}

/** What a device still has outstanding — for a "not yet synced" badge in the field app. */
export async function pendingOperations(
  db: PrismaClient,
  ctx: AuthContext,
  deviceId: string,
): Promise<{ pending: number; conflicts: number; lastSyncedAt: Date | null }> {
  requirePermission(ctx, PERMISSIONS.FIELD_APP);

  const [pending, conflicts, last] = await Promise.all([
    db.syncOperation.count({
      where: { organizationId: ctx.organizationId, deviceId, status: 'PENDING' },
    }),
    db.syncOperation.count({
      where: { organizationId: ctx.organizationId, deviceId, status: 'CONFLICT' },
    }),
    db.syncOperation.findFirst({
      where: { organizationId: ctx.organizationId, deviceId, status: 'APPLIED' },
      orderBy: { appliedAt: 'desc' },
      select: { appliedAt: true },
    }),
  ]);

  return { pending, conflicts, lastSyncedAt: last?.appliedAt ?? null };
}

/** Conflicts a technician needs to see, newest first. */
export async function conflictsForDevice(
  db: PrismaClient,
  ctx: AuthContext,
  deviceId: string,
) {
  requirePermission(ctx, PERMISSIONS.FIELD_APP);

  return db.syncOperation.findMany({
    where: { organizationId: ctx.organizationId, deviceId, status: 'CONFLICT' },
    orderBy: { receivedAt: 'desc' },
    take: 50,
    select: {
      clientOpId: true,
      operation: true,
      entityId: true,
      conflictReason: true,
      clientTimestamp: true,
      receivedAt: true,
    },
  });
}
