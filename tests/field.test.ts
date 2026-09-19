import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { buildAuthContext, systemContext, type AuthContext } from '../src/lib/auth/context';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { trialBalance } from '../src/lib/accounting/reports';
import { postJournalEntry } from '../src/lib/accounting/ledger';
import { jobCosting, labourRateForJob } from '../src/lib/jobs/costing';
import { createJob, transitionJob } from '../src/lib/jobs/service';
import { receiveStock } from '../src/lib/inventory/service';
import { createInvoiceFromJob, issueInvoice } from '../src/lib/invoices/service';
import { pullFieldData } from '../src/lib/field/pull';
import { conflictsForDevice, pendingOperations, pushOperations } from '../src/lib/field/push';
import type { ClientOperation, FieldOperationType } from '../src/lib/field/operations';
import {
  createPriceBookItem,
  createTaxJurisdiction,
  createTestOrg,
  createTestTechnician,
  createStockLocation,
  setPropertyJurisdiction,
  utc,
  type TestOrg,
} from './factory';
import { createCustomer } from '../src/lib/customers/service';

/**
 * The field app's contract with the server.
 *
 * Everything here models something that actually happens to a tablet: no signal in a
 * crawl space, a lost response on a flaky connection, a job reassigned while the device
 * was away, an invoice raised before the tech's queue drained.
 */

let org: TestOrg;
let admin: AuthContext;
let tech: { technicianId: string; userId: string };
let techCtx: AuthContext;
let vanId: string;
let laborItem: string;
let partItem: string;

const DEVICE = 'ipad-mesa-04';

beforeAll(async () => {
  org = await createTestOrg('Field');
  admin = systemContext(org.organizationId);

  const jurisdiction = await createTaxJurisdiction(org.organizationId);
  tech = await createTestTechnician(org.organizationId, org.locationId);
  techCtx = await buildAuthContext(db, tech.userId);

  vanId = await createStockLocation(org.organizationId, {
    kind: 'VAN',
    locationId: org.locationId,
    technicianId: tech.technicianId,
    code: 'VAN-FIELD',
  });

  laborItem = await createPriceBookItem(org.organizationId, {
    sku: 'LAB-STD',
    name: 'Technician labor',
    category: 'LABOR',
    kind: 'LABOR',
    costCents: 4056n,
    priceCents: 12500n,
  });
  partItem = await createPriceBookItem(org.organizationId, {
    sku: 'P-WAXRING',
    name: 'Wax ring kit',
    category: 'MATERIAL',
    costCents: 420n,
    priceCents: 1800n,
  });

  await receiveStock(db, admin, {
    stockLocationId: vanId,
    lines: [{ priceBookItemId: partItem, quantity: '20', unitCostCents: 420n }],
    occurredAt: utc(2026, 5, 1),
  });

  void jurisdiction;
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeJob(options: { assign?: boolean; title?: string; scheduledStart?: Date } = {}) {
  const customer = await createCustomer(db, admin, {
    lastName: `Field${randomUUID().slice(0, 6)}`,
    property: {
      addressLine1: '1420 E Broadway Rd',
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85204',
      accessNotes: 'Gate code 4417, dog in back yard',
    },
  });

  const job = await createJob(db, admin, {
    locationId: org.locationId,
    customerId: customer.id,
    propertyId: customer.properties[0].id,
    title: options.title ?? 'Replace toilet',
    scheduledStart: options.scheduledStart ?? new Date(),
  });

  if (options.assign !== false) {
    await db.jobAssignment.create({
      data: { jobId: job.id, technicianId: tech.technicianId, isLead: true },
    });
  }

  return { job, customerId: customer.id, propertyId: customer.properties[0].id };
}

let nextSequence = 1;
function op(
  type: FieldOperationType,
  payload: Record<string, unknown>,
  jobId?: string,
  at = new Date(),
): ClientOperation {
  return {
    clientOpId: randomUUID(),
    sequence: nextSequence++,
    type,
    jobId,
    payload,
    clientTimestamp: at.toISOString(),
  };
}

describe('what a device carries', () => {
  it('brings down only this technician’s work', async () => {
    const mine = await makeJob({ title: 'Mine' });
    await makeJob({ title: 'Somebody else’s', assign: false });

    const pull = await pullFieldData(db, techCtx, {});
    const titles = pull.jobs.map((j) => j.title);

    expect(titles).toContain('Mine');
    expect(titles).not.toContain('Somebody else’s');
    expect(pull.jobs.find((j) => j.id === mine.job.id)).toBeTruthy();
  });

  it('carries no cost anywhere in the payload', async () => {
    await makeJob();
    const pull = await pullFieldData(db, techCtx, {});

    // The whole payload, not just the fields a screen happens to read. A technician who
    // opens dev tools must not find margin sitting in the device's local database.
    const serialized = JSON.stringify(pull, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

    expect(serialized).not.toMatch(/costCents/i);
    expect(serialized).not.toMatch(/grossMargin/i);
    expect(pull.priceBook.length).toBeGreaterThan(0);
    expect(pull.priceBook.every((i) => 'priceCents' in i)).toBe(true);
  });

  it('brings what the technician needs on arrival', async () => {
    const { job } = await makeJob();
    const pull = await pullFieldData(db, techCtx, {});
    const carried = pull.jobs.find((j) => j.id === job.id)!;

    expect(carried.property.accessNotes).toBe('Gate code 4417, dog in back yard');
    expect(carried.customer.name).toBeTruthy();
    expect(carried.customer.phone !== undefined).toBe(true);
  });

  it('includes what the truck is carrying', async () => {
    const pull = await pullFieldData(db, techCtx, {});
    const stock = pull.vanStock.find((s) => s.priceBookItemId === partItem)!;

    expect(stock.quantity).toBe('20');
    expect(stock.sku).toBe('P-WAXRING');
  });

  it('shows what happened at this address before', async () => {
    const { job, customerId, propertyId } = await makeJob({ title: 'Second visit' });

    const earlier = await createJob(db, admin, {
      locationId: org.locationId,
      customerId,
      propertyId,
      title: 'First visit — same leak',
    });
    await transitionJob(db, admin, earlier.id, 'SCHEDULED');
    await transitionJob(db, admin, earlier.id, 'IN_PROGRESS');
    await transitionJob(db, admin, earlier.id, 'COMPLETED');

    const pull = await pullFieldData(db, techCtx, {});
    const carried = pull.jobs.find((j) => j.id === job.id)!;

    expect(carried.history.map((h) => h.title)).toContain('First visit — same leak');
  });

  it('sends only what changed on a delta pull', async () => {
    await makeJob({ title: 'Before the cursor' });
    const first = await pullFieldData(db, techCtx, {});

    const delta = await pullFieldData(db, techCtx, { since: first.serverTime });
    expect(delta.full).toBe(false);
    expect(delta.jobs).toHaveLength(0);

    const { job } = await makeJob({ title: 'After the cursor' });
    const second = await pullFieldData(db, techCtx, { since: first.serverTime });

    expect(second.jobs.map((j) => j.id)).toContain(job.id);
  });

  it('tells a device to drop a job that is no longer its own', async () => {
    const { job } = await makeJob();
    await db.jobAssignment.deleteMany({ where: { jobId: job.id } });

    const pull = await pullFieldData(db, techCtx, { knownJobIds: [job.id] });
    expect(pull.revokedJobIds).toContain(job.id);
  });

  it('refuses an account with no technician record', async () => {
    await expect(pullFieldData(db, admin, {})).rejects.toThrow(/not linked to a technician/);
  });
});

describe('draining the outbox', () => {
  it('applies a queued day in the order the technician did it', async () => {
    const { job } = await makeJob();
    const morning = utc(2026, 5, 12);

    const queue = [
      op('JOB_STATUS', { status: 'DISPATCHED' }, job.id, morning),
      op('JOB_STATUS', { status: 'EN_ROUTE' }, job.id, morning),
      op('JOB_STATUS', { status: 'IN_PROGRESS' }, job.id, morning),
    ];

    // Delivered out of order, the way a network does.
    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [queue[2], queue[0], queue[1]],
    });

    expect(response.applied).toBe(3);
    expect(response.results.map((r) => r.sequence)).toEqual([
      queue[0].sequence,
      queue[1].sequence,
      queue[2].sequence,
    ]);

    const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('IN_PROGRESS');
  });

  it('returns the first answer when a device resends after a lost response', async () => {
    const { job } = await makeJob();
    const operations = [op('ADD_JOB_NOTE', { body: 'Customer says it started Tuesday' }, job.id)];

    const first = await pushOperations(db, techCtx, { deviceId: DEVICE, operations });
    expect(first.applied).toBe(1);

    // The device never saw the reply and sends the same queue again.
    const second = await pushOperations(db, techCtx, { deviceId: DEVICE, operations });
    expect(second.duplicates).toBe(1);
    expect(second.results[0].entityId).toBe(first.results[0].entityId);

    // One note, not two.
    expect(await db.jobNote.count({ where: { jobId: job.id } })).toBe(1);
  });

  it('records each operation once even when a whole day is resent', async () => {
    const { job } = await makeJob();
    const queue = [
      op('JOB_STATUS', { status: 'DISPATCHED' }, job.id),
      op('ADD_JOB_LINES', { lines: [{ priceBookItemId: laborItem, quantity: '2' }] }, job.id),
      op('ADD_JOB_NOTE', { body: 'Replaced the flange as well' }, job.id),
    ];

    await pushOperations(db, techCtx, { deviceId: DEVICE, operations: queue });
    await pushOperations(db, techCtx, { deviceId: DEVICE, operations: queue });

    expect(await db.jobLine.count({ where: { jobId: job.id } })).toBe(1);
    expect(await db.jobNote.count({ where: { jobId: job.id } })).toBe(1);
  });

  it('treats a status the job has already passed as nothing to do', async () => {
    const { job } = await makeJob();
    await transitionJob(db, admin, job.id, 'DISPATCHED');
    await transitionJob(db, admin, job.id, 'IN_PROGRESS');
    await transitionJob(db, admin, job.id, 'COMPLETED');

    // The device queued this hours ago, underground. It is behind, not wrong.
    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [op('JOB_STATUS', { status: 'EN_ROUTE' }, job.id)],
    });

    expect(response.results[0].outcome).toBe('NOOP');
    expect(response.conflicts).toBe(0);
  });

  it('refuses work on a job that was reassigned while the device was away', async () => {
    const { job } = await makeJob();
    await db.jobAssignment.deleteMany({ where: { jobId: job.id } });

    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [op('ADD_JOB_NOTE', { body: 'Queued before the reassignment' }, job.id)],
    });

    expect(response.results[0].outcome).toBe('CONFLICT');
    expect(response.results[0].message).toMatch(/reassigned/);
    expect(await db.jobNote.count({ where: { jobId: job.id } })).toBe(0);
  });

  it('refuses to change a job the office has already invoiced', async () => {
    const { job } = await makeJob();
    await transitionJob(db, admin, job.id, 'DISPATCHED');
    await transitionJob(db, admin, job.id, 'IN_PROGRESS');
    await db.jobLine.create({
      data: {
        jobId: job.id,
        description: 'Flat rate work',
        quantity: '1',
        unitPriceCents: 48500n,
        totalCents: 48500n,
        category: 'LABOR',
      },
    });
    await transitionJob(db, admin, job.id, 'COMPLETED');

    const draft = await createInvoiceFromJob(db, admin, { jobId: job.id });
    await issueInvoice(db, admin, draft.id);

    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [
        op('ADD_JOB_LINES', { lines: [{ priceBookItemId: laborItem, quantity: '1' }] }, job.id),
      ],
    });

    expect(response.results[0].outcome).toBe('CONFLICT');
    expect(response.results[0].message).toMatch(/already been invoiced/);
  });

  it('still records the rest of the day when one operation conflicts', async () => {
    const good = await makeJob({ title: 'Fine' });
    const reassigned = await makeJob({ title: 'Taken away' });
    await db.jobAssignment.deleteMany({ where: { jobId: reassigned.job.id } });

    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [
        op('ADD_JOB_NOTE', { body: 'One' }, good.job.id),
        op('ADD_JOB_NOTE', { body: 'Two' }, reassigned.job.id),
        op('ADD_JOB_NOTE', { body: 'Three' }, good.job.id),
      ],
    });

    expect(response.applied).toBe(2);
    expect(response.conflicts).toBe(1);
    expect(await db.jobNote.count({ where: { jobId: good.job.id } })).toBe(2);
  });

  it('rejects an operation it does not recognise, without stopping the batch', async () => {
    const { job } = await makeJob();
    const response = await pushOperations(db, techCtx, {
      deviceId: DEVICE,
      operations: [
        { ...op('ADD_JOB_NOTE', { body: 'Good' }, job.id) },
        { ...op('ADD_JOB_NOTE', {}, job.id), type: 'DEMOLISH_HOUSE' as FieldOperationType },
      ],
    });

    expect(response.applied).toBe(1);
    expect(response.rejected).toBe(1);
    expect(response.results[1].message).toMatch(/Unknown operation/);
  });

  it('surfaces conflicts for the technician to see', async () => {
    const device = `ipad-${randomUUID().slice(0, 6)}`;
    const { job } = await makeJob();
    await db.jobAssignment.deleteMany({ where: { jobId: job.id } });

    await pushOperations(db, techCtx, {
      deviceId: device,
      operations: [op('ADD_JOB_NOTE', { body: 'Will not land' }, job.id)],
    });

    const status = await pendingOperations(db, techCtx, device);
    expect(status.conflicts).toBe(1);
    expect(status.pending).toBe(0);

    const conflicts = await conflictsForDevice(db, techCtx, device);
    expect(conflicts[0].conflictReason).toMatch(/reassigned/);
  });
});

describe('ledger authority', () => {
  it('a technician cannot post a journal entry of their own', async () => {
    await expect(
      postJournalEntry(db, techCtx, {
        entryDate: new Date(),
        source: 'MANUAL',
        memo: 'Straight into the books',
        lines: [
          { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 100_000n },
          { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 100_000n },
        ],
      }),
    ).rejects.toThrow(/Missing permission: gl:post/);
  });

  it('but their work still posts, attributed to them', async () => {
    const { job } = await makeJob();
    const at = utc(2026, 7, 8);

    const response = await pushOperations(db, techCtx, {
      deviceId: `ipad-${randomUUID().slice(0, 6)}`,
      operations: [
        op('CLOCK_IN', {}, job.id, at),
        op('CLOCK_OUT', {}, job.id, new Date(at.getTime() + 3600_000)),
      ],
    });

    expect(response.applied).toBe(2);

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { organizationId: org.organizationId, sourceType: 'TimeEntry', source: 'PAYROLL' },
      orderBy: { createdAt: 'desc' },
      include: { lines: true },
    });

    // The posting rules carry the authority; the technician carries the attribution.
    expect(entry.createdByUserId).toBe(tech.userId);
    expect(entry.lines.some((l) => l.technicianId === tech.technicianId)).toBe(true);
  });
});

describe('an offline day, replayed', () => {
  it('turns a queued day into posted books', async () => {
    const { job } = await makeJob({ title: 'Replace toilet' });
    const device = `ipad-${randomUUID().slice(0, 6)}`;

    const arrive = utc(2026, 5, 20);
    const leave = new Date(arrive.getTime() + 2.5 * 3600 * 1000);

    // Everything below happened with no signal. It is sent in one go on the way back.
    const response = await pushOperations(db, techCtx, {
      deviceId: device,
      operations: [
        op('JOB_STATUS', { status: 'DISPATCHED' }, job.id, arrive),
        op('JOB_STATUS', { status: 'EN_ROUTE' }, job.id, arrive),
        op('CLOCK_IN', { kind: 'WORK', latitude: 33.4152, longitude: -111.8315 }, job.id, arrive),
        op('JOB_STATUS', { status: 'IN_PROGRESS' }, job.id, arrive),
        op('ADD_PHOTO', { stage: 'BEFORE', storageKey: 'photos/before.jpg', pairKey: 'bowl' }, job.id, arrive),
        op('ADD_JOB_LINES', {
          lines: [
            { priceBookItemId: laborItem, quantity: '2.5' },
            { priceBookItemId: partItem, quantity: '2' },
          ],
        }, job.id, arrive),
        op('CREATE_CHANGE_ORDER', {
          reason: 'Flange cracked under the bowl',
          description: 'Found once the old unit came out',
          lines: [{ priceBookItemId: laborItem, quantity: '1' }],
          signatureStorageKey: 'signatures/change-order.png',
          signerName: 'D. Alvarez',
        }, job.id, arrive),
        op('CONSUME_PARTS', { lines: [{ priceBookItemId: partItem, quantity: '2' }] }, job.id, leave),
        op('ADD_PHOTO', { stage: 'AFTER', storageKey: 'photos/after.jpg', pairKey: 'bowl' }, job.id, leave),
        op('CAPTURE_SIGNATURE', {
          kind: 'COMPLETION',
          signerName: 'D. Alvarez',
          storageKey: 'signatures/completion.png',
          documentHash: 'sha256:abc',
        }, job.id, leave),
        op('CLOCK_OUT', { latitude: 33.4152, longitude: -111.8315 }, job.id, leave),
        op('JOB_STATUS', { status: 'COMPLETED' }, job.id, leave),
      ],
    });

    expect(response.conflicts).toBe(0);
    expect(response.rejected).toBe(0);
    expect(response.applied).toBe(12);

    const after = await db.job.findUniqueOrThrow({
      where: { id: job.id },
      include: { lines: true, photos: true, signatures: true, changeOrders: true },
    });

    expect(after.status).toBe('COMPLETED');
    // Two quoted lines plus the change order's line.
    expect(after.lines).toHaveLength(3);
    expect(after.photos.map((p) => p.stage).sort()).toEqual(['AFTER', 'BEFORE']);
    expect(after.changeOrders[0].status).toBe('APPROVED');
    expect(after.signatures.length).toBeGreaterThanOrEqual(2);

    // The van is two wax rings lighter.
    const stock = await db.stockLevel.findFirstOrThrow({
      where: { stockLocationId: vanId, priceBookItemId: partItem },
    });
    expect(stock.quantity.toString()).toBe('18');

    // And the books already know about the day.
    const costing = await jobCosting(db, admin, job.id);
    expect(costing.laborCents).toBe(7000n); // 2.5 hrs at the 28.00 wage
    expect(costing.burdenCents).toBe(3140n);
    expect(costing.materialCents).toBe(840n); // 2 at 4.20

    /*
     * And what that hour really cost. The hours come back out of the ledger rather than
     * off the timesheet: the posting used this technician's wage, so dividing what was
     * posted by that wage returns the hours that were costed, and the figure on the job
     * page cannot drift from the P&L.
     */
    const rate = await labourRateForJob(db, admin, job.id);
    expect(rate).not.toBeNull();
    expect(rate!.hours).toBe(2.5);
    expect(rate!.baseHourlyCents).toBe(2800n);
    expect(rate!.loadedHourlyCents).toBe(4056n);
    expect(rate!.multiple).toBe(1.44);
    // The wage is roughly seven tenths of the truth, which is the whole point of saying it.
    expect(rate!.loadedHourlyCents * 25n / 10n).toBe(costing.laborCents + costing.burdenCents);

    const tb = await trialBalance(db, admin, {});
    expect(tb.isBalanced).toBe(true);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.COGS_LABOR)!.balanceCents).toBeGreaterThan(0n);

    const time = await db.timeEntry.findFirstOrThrow({ where: { jobId: job.id } });
    expect(time.minutes).toBe(150);
    // Costed at the rate that applied on the day, not whatever it is now.
    expect(time.loadedHourlyCents).toBe(4056n);
    expect(Number(time.startLat)).toBeCloseTo(33.4152, 4);
  });

  it('will not double-post the day if the whole queue is resent', async () => {
    const { job } = await makeJob();
    const device = `ipad-${randomUUID().slice(0, 6)}`;
    const at = utc(2026, 6, 3);

    const queue = [
      op('CLOCK_IN', {}, job.id, at),
      op('CLOCK_OUT', {}, job.id, new Date(at.getTime() + 3600_000)),
    ];

    await pushOperations(db, techCtx, { deviceId: device, operations: queue });
    const before = await trialBalance(db, admin, {});

    await pushOperations(db, techCtx, { deviceId: device, operations: queue });
    const after = await trialBalance(db, admin, {});

    expect(after.totalDebitsCents).toBe(before.totalDebitsCents);
    expect(await db.timeEntry.count({ where: { jobId: job.id } })).toBe(1);
  });
});
