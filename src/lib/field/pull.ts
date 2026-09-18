import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { scopedDb } from '../auth/scoped-db';
import { ValidationError } from '../errors';

/**
 * What a technician's device carries.
 *
 * A tablet in a crawl space has no network, so everything needed to work a job has to be
 * on it before the tech arrives: the job, who it is for, how to get in, what was done last
 * time, what the price book says, and what is actually on the truck.
 *
 * Cost is not on that list. The payload is built through `scopedDb`, so item cost, job
 * cost and margin are never fetched, never serialized, and never sit in a device's local
 * database waiting for someone to open it. A technician quoting work sees sell prices.
 */

export interface PullRequest {
  /** Only what changed since this moment. Omit for a first, full sync. */
  since?: Date;
  /** Job ids the device already holds, so the server can say which have left its scope. */
  knownJobIds?: string[];
  /** How far ahead to look. Techs need today, the rest of the week, and a little history. */
  horizonDays?: number;
  lookbackDays?: number;
}

export interface FieldPullResult {
  /** Use as `since` on the next pull. Taken before reading, so nothing falls through the gap. */
  serverTime: Date;
  technicianId: string;
  full: boolean;
  jobs: FieldJob[];
  priceBook: FieldPriceItem[];
  vanStock: FieldStockLine[];
  checklistTemplates: FieldChecklistTemplate[];
  /** Jobs the device holds that are no longer this technician's to work. */
  revokedJobIds: string[];
  counts: { jobs: number; priceBook: number; vanStock: number };
}

export interface FieldJob {
  id: string;
  jobNo: string;
  title: string;
  description: string | null;
  internalNotes: string | null;
  status: string;
  priority: string;
  isWarranty: boolean;
  isBillable: boolean;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  locationId: string;
  serviceTypeId: string | null;
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    isTaxExempt: boolean;
  };
  property: {
    id: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    state: string;
    postalCode: string;
    latitude: string | null;
    longitude: string | null;
    /** Gate codes and where to park. The difference between a completed call and a callback. */
    accessNotes: string | null;
    equipment: { id: string; name: string; modelNumber: string | null; serialNumber: string | null }[];
  };
  lines: FieldJobLine[];
  /** What happened here before, so the tech is not the last to know. */
  history: { jobNo: string; title: string; completedAt: Date | null; isWarranty: boolean }[];
  checklistIds: string[];
  photoCount: number;
}

export interface FieldJobLine {
  id: string;
  description: string;
  quantity: string;
  unitPriceCents: bigint;
  discountCents: bigint;
  category: string;
  priceBookItemId: string | null;
  isBilled: boolean;
}

export interface FieldPriceItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  kind: string;
  unit: string;
  priceCents: bigint;
  estimatedHours: string | null;
  serviceTypeId: string | null;
  isTaxExempt: boolean;
}

export interface FieldStockLine {
  priceBookItemId: string;
  sku: string;
  name: string;
  quantity: string;
  stockLocationId: string;
}

export interface FieldChecklistTemplate {
  id: string;
  name: string;
  serviceTypeId: string | null;
  items: unknown;
}

const DEFAULT_HORIZON_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 7;

export async function pullFieldData(
  db: PrismaClient,
  ctx: AuthContext,
  request: PullRequest = {},
): Promise<FieldPullResult> {
  requirePermission(ctx, PERMISSIONS.FIELD_APP);

  if (!ctx.technicianId) {
    throw new ValidationError('This account is not linked to a technician record');
  }

  // Read the clock before reading data. Taking it afterwards would leave a window in which
  // a change is written, missed by this pull, and then skipped by the next one because it
  // predates the cursor.
  const serverTime = new Date();
  const scoped = scopedDb(db, ctx);

  const horizonDays = request.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const lookbackDays = request.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const from = new Date(serverTime.getTime() - lookbackDays * 86_400_000);
  const to = new Date(serverTime.getTime() + horizonDays * 86_400_000);

  const assignedJobIds = (
    await db.jobAssignment.findMany({
      where: { technicianId: ctx.technicianId, job: { organizationId: ctx.organizationId } },
      select: { jobId: true },
    })
  ).map((a) => a.jobId);

  const inScope = await scoped.job.findMany({
    where: {
      id: { in: assignedJobIds },
      status: { notIn: ['CANCELLED', 'CLOSED'] },
      OR: [
        { scheduledStart: { gte: from, lte: to } },
        // Unscheduled work still belongs on the device; it is the dispatcher's next move.
        { scheduledStart: null, status: { in: ['DRAFT', 'APPROVED', 'SCHEDULED'] } },
        { status: { in: ['DISPATCHED', 'EN_ROUTE', 'IN_PROGRESS', 'ON_HOLD'] } },
      ],
    },
    select: { id: true },
  });
  const inScopeIds = new Set(inScope.map((j) => j.id));

  const changedSince = request.since;
  const jobRows = await scoped.job.findMany({
    where: {
      id: { in: [...inScopeIds] },
      ...(changedSince ? { updatedAt: { gt: changedSince } } : {}),
    },
    orderBy: [{ scheduledStart: 'asc' }, { jobNo: 'asc' }],
    select: {
      id: true,
      jobNo: true,
      title: true,
      description: true,
      internalNotes: true,
      status: true,
      priority: true,
      isWarranty: true,
      isBillable: true,
      scheduledStart: true,
      scheduledEnd: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
      locationId: true,
      serviceTypeId: true,
      customer: { select: { id: true, companyName: true, firstName: true, lastName: true, phone: true, email: true, isTaxExempt: true } },
      property: {
        select: {
          id: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          postalCode: true,
          latitude: true,
          longitude: true,
          accessNotes: true,
          equipment: { select: { id: true, name: true, modelNumber: true, serialNumber: true } },
        },
      },
      lines: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPriceCents: true,
          discountCents: true,
          category: true,
          priceBookItemId: true,
          isBilled: true,
        },
      },
      checklists: { select: { id: true } },
      _count: { select: { photos: true } },
    },
  });

  // Prior visits to the same address, which is what tells a tech this is the third time
  // someone has looked at this water heater.
  const propertyIds = [...new Set(jobRows.map((j) => j.property.id))];
  const historyRows = propertyIds.length
    ? await scoped.job.findMany({
        where: {
          propertyId: { in: propertyIds },
          status: { in: ['COMPLETED', 'INVOICED', 'PAID', 'CLOSED'] },
        },
        orderBy: { completedAt: 'desc' },
        take: 200,
        select: { propertyId: true, jobNo: true, title: true, completedAt: true, isWarranty: true },
      })
    : [];

  const historyByProperty = new Map<string, FieldJob['history']>();
  for (const row of historyRows) {
    const list = historyByProperty.get(row.propertyId) ?? [];
    if (list.length < 5) {
      list.push({
        jobNo: row.jobNo,
        title: row.title,
        completedAt: row.completedAt,
        isWarranty: row.isWarranty,
      });
    }
    historyByProperty.set(row.propertyId, list);
  }

  const jobs: FieldJob[] = jobRows.map((job) => ({
    id: job.id,
    jobNo: job.jobNo,
    title: job.title,
    description: job.description,
    internalNotes: job.internalNotes,
    status: job.status,
    priority: job.priority,
    isWarranty: job.isWarranty,
    isBillable: job.isBillable,
    scheduledStart: job.scheduledStart,
    scheduledEnd: job.scheduledEnd,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
    locationId: job.locationId,
    serviceTypeId: job.serviceTypeId,
    customer: {
      id: job.customer.id,
      name:
        job.customer.companyName ??
        [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' '),
      phone: job.customer.phone,
      email: job.customer.email,
      isTaxExempt: job.customer.isTaxExempt,
    },
    property: {
      id: job.property.id,
      addressLine1: job.property.addressLine1,
      addressLine2: job.property.addressLine2,
      city: job.property.city,
      state: job.property.state,
      postalCode: job.property.postalCode,
      latitude: job.property.latitude?.toString() ?? null,
      longitude: job.property.longitude?.toString() ?? null,
      accessNotes: job.property.accessNotes,
      equipment: job.property.equipment,
    },
    lines: job.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      category: line.category,
      priceBookItemId: line.priceBookItemId,
      isBilled: line.isBilled,
    })),
    history: (historyByProperty.get(job.property.id) ?? []).filter((h) => h.jobNo !== job.jobNo),
    checklistIds: job.checklists.map((c) => c.id),
    photoCount: job._count.photos,
  }));

  // The whole price book goes down, not just what today's jobs need: the work a tech finds
  // on site is by definition not what was scheduled.
  const priceBookRows = await scoped.priceBookItem.findMany({
    where: { isActive: true, ...(changedSince ? { updatedAt: { gt: changedSince } } : {}) },
    orderBy: { sku: 'asc' },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      category: true,
      kind: true,
      unit: true,
      priceCents: true,
      estimatedHours: true,
      serviceTypeId: true,
      isTaxExempt: true,
    },
  });

  const van = await db.stockLocation.findFirst({
    where: { organizationId: ctx.organizationId, technicianId: ctx.technicianId, kind: 'VAN', isActive: true },
    select: { id: true },
  });

  const vanStock: FieldStockLine[] = van
    ? (
        await scoped.stockLevel.findMany({
          where: { stockLocationId: van.id },
          select: {
            quantity: true,
            stockLocationId: true,
            priceBookItemId: true,
            priceBookItem: { select: { sku: true, name: true } },
          },
        })
      ).map((level) => ({
        priceBookItemId: level.priceBookItemId,
        sku: level.priceBookItem.sku,
        name: level.priceBookItem.name,
        quantity: level.quantity.toString(),
        stockLocationId: level.stockLocationId,
      }))
    : [];

  const checklistTemplates = await scoped.checklistTemplate.findMany({
    where: { isActive: true },
    select: { id: true, name: true, serviceTypeId: true, items: true },
  });

  // Jobs the device still holds that are no longer assigned, or have been closed or
  // cancelled. Without this a reassigned job lingers on the wrong truck.
  const revokedJobIds = (request.knownJobIds ?? []).filter((id) => !inScopeIds.has(id));

  return {
    serverTime,
    technicianId: ctx.technicianId,
    full: !changedSince,
    jobs,
    priceBook: priceBookRows.map((item) => ({
      ...item,
      estimatedHours: item.estimatedHours?.toString() ?? null,
    })),
    vanStock,
    checklistTemplates,
    revokedJobIds,
    counts: { jobs: jobs.length, priceBook: priceBookRows.length, vanStock: vanStock.length },
  };
}
