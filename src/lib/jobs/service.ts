import type { JobStatus, PrismaClient } from '@prisma/client';
import { requireLocation, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { scopedDb } from '../auth/scoped-db';
import { NotFoundError, ValidationError } from '../errors';
import { nextDocumentNumber } from '../accounting/sequences';
import { resolvePrice } from '../pricing/price-book';
import type { DraftLine } from '../documents/line-totals';

/**
 * Jobs — the spine of the system.
 *
 * A job accumulates what was actually done and what it actually cost, which is a different
 * thing from the quote that preceded it. The quote is a proposal; the job is the record.
 */

/**
 * Allowed status transitions.
 *
 * Encoded as data rather than scattered through if-statements so the lifecycle can be
 * read in one place, and so an invalid transition fails loudly instead of leaving a job in
 * a state no screen knows how to render.
 */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  DRAFT: ['QUOTED', 'APPROVED', 'SCHEDULED', 'CANCELLED'],
  QUOTED: ['APPROVED', 'SCHEDULED', 'CANCELLED'],
  APPROVED: ['SCHEDULED', 'DISPATCHED', 'CANCELLED'],
  SCHEDULED: ['DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  DISPATCHED: ['EN_ROUTE', 'IN_PROGRESS', 'ON_HOLD', 'SCHEDULED', 'CANCELLED'],
  EN_ROUTE: ['IN_PROGRESS', 'ON_HOLD', 'SCHEDULED'],
  IN_PROGRESS: ['COMPLETED', 'ON_HOLD'],
  // A job can go back to the field: a multi-visit job is not finished at the first visit.
  ON_HOLD: ['SCHEDULED', 'DISPATCHED', 'IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED', 'IN_PROGRESS'],
  INVOICED: ['PAID', 'COMPLETED'],
  PAID: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CreateJobInput {
  locationId: string;
  customerId: string;
  propertyId: string;
  title: string;
  description?: string;
  serviceTypeId?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'EMERGENCY';
  scheduledStart?: Date;
  scheduledEnd?: Date;
  /** Set for a warranty callback; the job is linked to the original and is not billable. */
  parentJobId?: string;
  isWarranty?: boolean;
  sourceQuoteId?: string;
  agreementId?: string;
}

export async function createJob(db: PrismaClient, ctx: AuthContext, input: CreateJobInput) {
  requirePermission(ctx, PERMISSIONS.JOB_WRITE);
  requireLocation(ctx, input.locationId);

  const property = await db.property.findFirst({
    where: { id: input.propertyId, customerId: input.customerId, customer: { organizationId: ctx.organizationId } },
    select: { id: true },
  });
  if (!property) {
    throw new ValidationError('That property does not belong to this customer');
  }

  return db.$transaction(async (tx) => {
    const location = await tx.location.findUniqueOrThrow({
      where: { id: input.locationId },
      select: { code: true },
    });
    const jobNo = await nextDocumentNumber(tx, ctx.organizationId, 'JOB', location.code);

    return tx.job.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: input.locationId,
        jobNo,
        customerId: input.customerId,
        propertyId: input.propertyId,
        serviceTypeId: input.serviceTypeId ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 'NORMAL',
        scheduledStart: input.scheduledStart ?? null,
        scheduledEnd: input.scheduledEnd ?? null,
        status: input.scheduledStart ? 'SCHEDULED' : 'DRAFT',
        parentJobId: input.parentJobId ?? null,
        isWarranty: input.isWarranty ?? false,
        // Warranty rework is done at our expense: it still costs, but it does not bill.
        isBillable: !(input.isWarranty ?? false),
        sourceQuoteId: input.sourceQuoteId ?? null,
        agreementId: input.agreementId ?? null,
      },
    });
  });
}

export async function transitionJob(
  db: PrismaClient,
  ctx: AuthContext,
  jobId: string,
  to: JobStatus,
) {
  requirePermission(ctx, PERMISSIONS.JOB_WRITE);

  const job = await scopedDb(db, ctx).job.findFirst({
    where: { id: jobId },
    select: { id: true, status: true, locationId: true, jobNo: true },
  });
  if (!job) throw new NotFoundError('Job', jobId);
  requireLocation(ctx, job.locationId);

  if (job.status === to) return db.job.findUniqueOrThrow({ where: { id: jobId } });
  if (!canTransition(job.status, to)) {
    throw new ValidationError(
      `Job ${job.jobNo} cannot move from ${job.status} to ${to}`,
    );
  }

  const now = new Date();
  return db.job.update({
    where: { id: jobId },
    data: {
      status: to,
      ...(to === 'IN_PROGRESS' ? { startedAt: now } : {}),
      ...(to === 'COMPLETED' ? { completedAt: now } : {}),
      ...(to === 'CLOSED' ? { closedAt: now } : {}),
    },
  });
}

export async function assignTechnician(
  db: PrismaClient,
  ctx: AuthContext,
  jobId: string,
  technicianId: string,
  options: { isLead?: boolean; jobVisitId?: string } = {},
) {
  requirePermission(ctx, PERMISSIONS.JOB_DISPATCH);

  const job = await scopedDb(db, ctx).job.findFirst({
    where: { id: jobId },
    select: { id: true, locationId: true },
  });
  if (!job) throw new NotFoundError('Job', jobId);
  requireLocation(ctx, job.locationId);

  const technician = await db.technician.findFirst({
    where: { id: technicianId, organizationId: ctx.organizationId, isActive: true },
    select: { id: true },
  });
  if (!technician) throw new NotFoundError('Technician', technicianId);

  // Not an upsert: a job-level assignment has a null jobVisitId, and Prisma's compound
  // unique selector cannot address a null. A partial unique index on the database side
  // (see the assignment_partial_unique migration) still prevents a duplicate slipping in
  // between this read and the write.
  const existing = await db.jobAssignment.findFirst({
    where: { jobId, technicianId, jobVisitId: options.jobVisitId ?? null },
    select: { id: true },
  });

  if (existing) {
    return db.jobAssignment.update({
      where: { id: existing.id },
      data: { isLead: options.isLead ?? false },
    });
  }

  return db.jobAssignment.create({
    data: {
      jobId,
      technicianId,
      jobVisitId: options.jobVisitId ?? null,
      isLead: options.isLead ?? false,
    },
  });
}

export interface AddJobLineInput {
  priceBookItemId?: string;
  description?: string;
  quantity: string | number;
  /** Overrides the resolved price book price; requires a reason in practice. */
  unitPriceCents?: bigint;
  unitCostCents?: bigint;
  discountCents?: bigint;
  category?: import('@prisma/client').LineCategory;
  changeOrderId?: string;
}

/**
 * Record work performed or parts used. Price and cost are resolved from the price book at
 * the moment the line is added and then stored on the line, so a later price change never
 * restates a job that has already been done.
 */
export async function addJobLine(
  db: PrismaClient,
  ctx: AuthContext,
  jobId: string,
  input: AddJobLineInput,
) {
  requirePermission(ctx, PERMISSIONS.JOB_WRITE);

  const job = await scopedDb(db, ctx).job.findFirst({
    where: { id: jobId },
    select: {
      id: true,
      locationId: true,
      status: true,
      jobNo: true,
      customer: { select: { priceTier: true } },
    },
  });
  if (!job) throw new NotFoundError('Job', jobId);
  requireLocation(ctx, job.locationId);

  if (job.status === 'CLOSED' || job.status === 'CANCELLED') {
    throw new ValidationError(`Job ${job.jobNo} is ${job.status} and cannot take new lines`);
  }

  let description = input.description;
  let unitPriceCents = input.unitPriceCents;
  let unitCostCents = input.unitCostCents;
  let category = input.category;
  let serviceTypeId: string | null = null;

  if (input.priceBookItemId) {
    const price = await resolvePrice(db, ctx.organizationId, input.priceBookItemId, {
      locationId: job.locationId,
      priceTier: job.customer.priceTier,
    });
    description ??= price.name;
    unitPriceCents ??= price.priceCents;
    unitCostCents ??= price.costCents;
    category ??= price.category;
    serviceTypeId = price.serviceTypeId;
  }

  if (!description) throw new ValidationError('A job line needs a description');
  if (unitPriceCents === undefined) throw new ValidationError('A job line needs a unit price');

  const lineCount = await db.jobLine.count({ where: { jobId } });
  const quantity = input.quantity.toString();
  const extended = BigInt(Math.round(Number(quantity) * 1000)) * unitPriceCents / 1000n;

  return db.jobLine.create({
    data: {
      jobId,
      changeOrderId: input.changeOrderId ?? null,
      priceBookItemId: input.priceBookItemId ?? null,
      sortOrder: lineCount,
      category: category ?? 'MATERIAL',
      description,
      quantity,
      unitPriceCents,
      unitCostCents: unitCostCents ?? 0n,
      discountCents: input.discountCents ?? 0n,
      isTaxable: true,
      totalCents: extended - (input.discountCents ?? 0n),
    },
  });
}

/** Unbilled lines, in the order they were added — the basis for the next invoice. */
export async function unbilledJobLines(db: PrismaClient, ctx: AuthContext, jobId: string): Promise<DraftLine[]> {
  const lines = await db.jobLine.findMany({
    where: { jobId, isBilled: false, job: { organizationId: ctx.organizationId } },
    orderBy: { sortOrder: 'asc' },
  });

  return lines.map((l) => ({
    category: l.category,
    description: l.description,
    quantity: l.quantity.toString(),
    unitPriceCents: l.unitPriceCents,
    unitCostCents: l.unitCostCents,
    discountCents: l.discountCents,
    priceBookItemId: l.priceBookItemId,
    sortOrder: l.sortOrder,
  }));
}
