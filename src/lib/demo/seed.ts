import type { LineCategory, Prisma, PrismaClient } from '@prisma/client';
import { systemContext, type AuthContext } from '../auth/context';
import { hashPassword } from '../auth/password';
import { provisionOrganization } from '../accounting/setup';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { closePeriod } from '../accounting/periods';
import { postJournalEntry } from '../accounting/ledger';
import { laborCostedLines, loadedHourlyCost } from '../accounting/rules/labor';
import { addJobLines, createJob, transitionJob } from '../jobs/service';
import { approveQuote, convertQuoteToJob, createQuote, sendQuote } from '../quotes/service';
import { createInvoiceFromJob, issueInvoice, recordPayment } from '../invoices/service';
import { consumePartsForJob, receiveStock, transferStock } from '../inventory/service';
import { payOpenBills, recordJobPurchase } from '../purchasing/service';
import { Rng } from './random';
import {
  ALL_PRICE_ITEMS,
  COMMERCIAL_NAMES,
  COMPANY,
  FIRST_NAMES,
  LAST_NAMES,
  LEAD_SOURCES,
  LOCATIONS,
  OFFICE_STAFF,
  PARTS_BY_SERVICE,
  PART_ITEMS,
  SEASONALITY,
  SERVICE_TYPES,
  STREET_NAMES,
  TASK_ITEMS,
  TECHNICIANS,
  type ServiceCode,
} from './catalog';

/**
 * The demo company.
 *
 * Everything financial here goes through the same posting engine the product uses. No
 * journal entry is written directly and no dashboard figure is hardcoded, because the
 * first thing a prospect's controller does is drill into a number — and if the trail ends
 * at a fixture, the demo is over.
 *
 * Reference data (customers, properties) is written in bulk for speed; every transaction
 * is not.
 */

export const DEMO_PASSWORD = 'apex-demo-2026!';

interface SeededTech {
  technicianId: string;
  vanStockLocationId: string;
  locationId: string;
  locationCode: string;
  baseHourlyCents: bigint;
  loadedHourlyCents: bigint;
  laborSku: string;
  callbackRate: number;
  skills: ServiceCode[];
  name: string;
}

export interface SeedOptions {
  /** Same seed, same company, every time. */
  seed?: number;
  /**
   * Jobs across the whole twelve months and all three branches. Left unset, it is derived
   * from technician headcount and a realistic utilization rate.
   */
  jobCount?: number;
  customerCount?: number;
  /** Anchors the twelve-month window. Defaults to today. */
  today?: Date;
  onProgress?: (message: string) => void;
}

export interface SeedResult {
  organizationId: string;
  counts: {
    locations: number;
    users: number;
    technicians: number;
    customers: number;
    properties: number;
    priceBookItems: number;
    jobs: number;
    invoices: number;
    payments: number;
    journalEntries: number;
  };
  signIn: { email: string; password: string }[];
  elapsedMs: number;
}

export async function seedDemoCompany(
  db: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const startedAt = Date.now();
  const rng = new Rng(options.seed ?? 20260917);
  const log = options.onProgress ?? (() => {});
  const today = options.today ?? new Date();
  const PAID_HOURS_PER_MONTH = 173;
  const TARGET_UTILIZATION = 0.62;
  const AVERAGE_JOB_HOURS = 3.6;
  // Derived, not guessed: technician count, paid hours and a realistic utilization rate
  // determine how much work there has to be. Anything else makes the P&L incoherent.
  const jobTarget =
    options.jobCount ??
    Math.round(
      (TECHNICIANS.length * PAID_HOURS_PER_MONTH * 12 * TARGET_UTILIZATION) / AVERAGE_JOB_HOURS,
    );
  const customerTarget = options.customerCount ?? 600;

  // ---------------------------------------------------------------- organization
  const org = await db.organization.create({
    data: {
      name: COMPANY.name,
      legalName: COMPANY.legalName,
      dataMode: 'DEMO',
      timezone: COMPANY.timezone,
      fiscalYearStartMo: 1,
      costingMethod: 'AVERAGE',
      defaultBurdenRate: '0.2165',
    },
  });
  const ctx = systemContext(org.id);

  const years = [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1];
  await provisionOrganization(db, org.id, { fiscalYears: years, fiscalYearStartMonth: 1 });
  log('Chart of accounts, roles and fiscal years provisioned');

  // ---------------------------------------------------------------- locations
  const locationByCode = new Map<string, string>();
  const jurisdictionByCode = new Map<string, string>();

  for (const seed of LOCATIONS) {
    const location = await db.location.create({
      data: {
        organizationId: org.id,
        code: seed.code,
        name: seed.name,
        addressLine1: seed.addressLine1,
        city: seed.city,
        state: 'AZ',
        postalCode: seed.postalCode,
        phone: seed.phone,
        serviceAreas: {
          create: { name: `${seed.name} service area`, postalCodes: seed.postalCodes },
        },
      },
    });
    locationByCode.set(seed.code, location.id);

    const jurisdiction = await db.taxJurisdiction.create({
      data: {
        organizationId: org.id,
        name: `AZ — Maricopa — ${seed.city}`,
        level: 'CITY',
        state: 'AZ',
        county: 'Maricopa',
        city: seed.city,
        rules: {
          create: {
            rate: seed.taxRate,
            effectiveFrom: new Date(Date.UTC(years[0] - 1, 0, 1)),
            // Arizona taxes contracting labor and materials alike; permits pass through.
            taxLabor: true,
            taxMaterials: true,
            taxServiceAgreements: false,
            taxFees: false,
          },
        },
      },
    });
    jurisdictionByCode.set(seed.code, jurisdiction.id);
  }

  // ---------------------------------------------------------------- catalog
  const serviceTypeByCode = new Map<string, string>();
  for (const type of SERVICE_TYPES) {
    const created = await db.serviceType.create({
      data: { organizationId: org.id, code: type.code, name: type.name },
    });
    serviceTypeByCode.set(type.code, created.id);
  }

  const itemBySku = new Map<string, string>();
  for (const item of ALL_PRICE_ITEMS) {
    const created = await db.priceBookItem.create({
      data: {
        organizationId: org.id,
        sku: item.sku,
        name: item.name,
        kind: item.kind,
        category: item.category,
        serviceTypeId: item.serviceCode ? serviceTypeByCode.get(item.serviceCode)! : null,
        unit: item.unit ?? 'ea',
        costCents: item.costCents,
        priceCents: item.priceCents,
        estimatedHours: item.estimatedHours ?? null,
        isStocked: item.isStocked ?? false,
        reorderPoint: item.reorderPoint ?? null,
        reorderQty: item.reorderQty ?? null,
        isTaxExempt: item.isTaxExempt ?? false,
      },
    });
    itemBySku.set(item.sku, created.id);
  }
  log(`Price book: ${ALL_PRICE_ITEMS.length} items across ${SERVICE_TYPES.length} service lines`);

  // Scottsdale sells drywall work at the list price it was given in 2023, while its
  // material costs have moved. This is the margin anomaly the owner dashboard surfaces.
  for (const sku of ['DRY-PATCH-S', 'DRY-PATCH-L']) {
    await db.priceOverride.create({
      data: {
        priceBookItemId: itemBySku.get(sku)!,
        locationId: locationByCode.get('SCT')!,
        priceCents:
          TASK_ITEMS.find((t) => t.sku === sku)!.priceCents - 1500n,
        effectiveFrom: new Date(Date.UTC(years[0] - 1, 0, 1)),
      },
    });
  }

  // ---------------------------------------------------------------- people
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const roleByKey = new Map(
    (await db.role.findMany({ where: { organizationId: org.id } })).map((r) => [r.key, r.id]),
  );
  const signIn: { email: string; password: string }[] = [];

  const email = (first: string, last: string) =>
    `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@apexhandyman.test';

  for (const staff of OFFICE_STAFF) {
    const address = email(staff.first, staff.last);
    await db.user.create({
      data: {
        organizationId: org.id,
        email: address,
        passwordHash,
        firstName: staff.first,
        lastName: staff.last,
        userRoles: { create: { roleId: roleByKey.get(staff.role)! } },
        ...(staff.locationCode
          ? { userLocations: { create: { locationId: locationByCode.get(staff.locationCode)!, isPrimary: true } } }
          : {}),
      },
    });
    signIn.push({ email: address, password: DEMO_PASSWORD });
  }

  const techs: SeededTech[] = [];
  const laborSkuByTier = { APPRENTICE: 'LAB-APP', TECHNICIAN: 'LAB-STD', SENIOR: 'LAB-SR' } as const;

  for (const seed of TECHNICIANS) {
    const address = email(seed.first, seed.last);
    const locationId = locationByCode.get(seed.locationCode)!;

    const user = await db.user.create({
      data: {
        organizationId: org.id,
        email: address,
        passwordHash,
        firstName: seed.first,
        lastName: seed.last,
        userRoles: { create: { roleId: roleByKey.get('TECHNICIAN')! } },
        userLocations: { create: { locationId, isPrimary: true } },
      },
    });

    const burden = {
      baseHourlyCents: seed.baseHourlyCents,
      payrollTaxRate: '0.0765',
      workersCompRate: '0.08',
      benefitsRate: '0.06',
      vehicleMonthlyCents: 85000n,
      phoneMonthlyCents: 6000n,
      billableHoursPerMonth: '140',
    };
    const loaded = loadedHourlyCost(burden);

    const technician = await db.technician.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        employeeCode: `T-${seed.last.slice(0, 4).toUpperCase()}`,
        payType: 'HOURLY',
        burdenRates: {
          create: {
            effectiveFrom: new Date(Date.UTC(years[0] - 1, 0, 1)),
            ...burden,
            loadedHourlyCents: loaded,
          },
        },
      },
    });

    const van = await db.stockLocation.create({
      data: {
        organizationId: org.id,
        locationId,
        technicianId: technician.id,
        kind: 'VAN',
        code: `VAN-${seed.locationCode}-${seed.last.slice(0, 3).toUpperCase()}`,
        name: `${seed.first} ${seed.last} — van`,
      },
    });

    techs.push({
      technicianId: technician.id,
      vanStockLocationId: van.id,
      locationId,
      locationCode: seed.locationCode,
      baseHourlyCents: seed.baseHourlyCents,
      loadedHourlyCents: loaded,
      laborSku: laborSkuByTier[seed.tier],
      callbackRate: seed.callbackRate,
      skills: seed.skills,
      name: `${seed.first} ${seed.last}`,
    });
  }
  log(`People: ${OFFICE_STAFF.length} office staff, ${techs.length} technicians with vans`);

  // ---------------------------------------------------------------- vendors
  const vendorIds: { supply: string[]; sub: string[] } = { supply: [], sub: [] };
  const vendorSeeds: { name: string; kind: 'supply' | 'sub'; terms: number; is1099: boolean }[] = [
    { name: 'Copper State Supply', kind: 'supply', terms: 30, is1099: false },
    { name: 'Desert Builders Wholesale', kind: 'supply', terms: 30, is1099: false },
    { name: 'Valley Hardware & Fasteners', kind: 'supply', terms: 15, is1099: false },
    { name: 'Sunbelt Electrical Supply', kind: 'supply', terms: 30, is1099: false },
    { name: 'Rivera Tile & Stone (sub)', kind: 'sub', terms: 15, is1099: true },
    { name: 'Ahmadi Glazing (sub)', kind: 'sub', terms: 15, is1099: true },
  ];

  for (const [index, seed] of vendorSeeds.entries()) {
    const vendor = await db.vendor.create({
      data: {
        organizationId: org.id,
        vendorNo: `V-${String(index + 1).padStart(4, '0')}`,
        name: seed.name,
        paymentTermsDays: seed.terms,
        is1099Vendor: seed.is1099,
        w9OnFile: seed.is1099,
        taxIdLast4: seed.is1099 ? String(rng.int(1000, 9999)) : null,
        city: 'Phoenix',
        state: 'AZ',
      },
    });
    vendorIds[seed.kind].push(vendor.id);
  }

  // ---------------------------------------------------------------- warehouses
  const warehouseByCode = new Map<string, string>();
  for (const seed of LOCATIONS) {
    const warehouse = await db.stockLocation.create({
      data: {
        organizationId: org.id,
        locationId: locationByCode.get(seed.code)!,
        kind: 'WAREHOUSE',
        code: `WH-${seed.code}`,
        name: `${seed.name} warehouse`,
      },
    });
    warehouseByCode.set(seed.code, warehouse.id);
  }

  // ---------------------------------------------------------------- customers
  const windowStart = new Date(
    Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), 1),
  );

  const customers: { id: string; propertyId: string; locationCode: string; priceTier: string | null }[] = [];
  const customerRows: Prisma.CustomerCreateManyInput[] = [];

  // Numbers are allocated in one block rather than one sequence call per row; the
  // sequence is advanced to match so live records carry on from the right place.
  const firstCustomerNo = 1;
  for (let i = 0; i < customerTarget; i++) {
    const location = rng.weighted(LOCATIONS.map((l) => [l, l.volumeWeight] as const));
    const type = rng.weighted([
      ['RESIDENTIAL', 78],
      ['COMMERCIAL', 12],
      ['PROPERTY_MANAGER', 7],
      ['BUILDER', 3],
    ] as const);
    const isBusiness = type !== 'RESIDENTIAL';
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);

    customerRows.push({
      organizationId: org.id,
      customerNo: `C-${String(firstCustomerNo + i).padStart(5, '0')}`,
      type,
      companyName: isBusiness ? `${rng.pick(COMMERCIAL_NAMES)}` : null,
      firstName: first,
      lastName: last,
      email: `${first}.${last}${i}`.toLowerCase() + '@example.test',
      phone: `(${rng.pick(['602', '480', '623'])}) 555-${String(rng.int(100, 9999)).padStart(4, '0')}`,
      phoneNormalized: null,
      billingCity: location.city,
      billingState: 'AZ',
      billingPostal: rng.pick(location.postalCodes),
      paymentTermsDays: isBusiness ? rng.pick([15, 30, 30, 45]) : 0,
      priceTier: type === 'PROPERTY_MANAGER' ? 'CONTRACT' : null,
      source: rng.pick(LEAD_SOURCES),
      createdAt: new Date(
        windowStart.getTime() - rng.int(0, 900) * 86_400_000,
      ),
    });
  }

  await db.customer.createMany({ data: customerRows });
  await db.documentSequence.updateMany({
    where: { organizationId: org.id, docType: 'CUSTOMER', locationCode: '' },
    data: { nextValue: firstCustomerNo + customerTarget },
  });

  const createdCustomers = await db.customer.findMany({
    where: { organizationId: org.id },
    select: { id: true, billingPostal: true, priceTier: true, type: true },
    orderBy: { customerNo: 'asc' },
  });

  const propertyRows: Prisma.PropertyCreateManyInput[] = [];
  for (const customer of createdCustomers) {
    const location =
      LOCATIONS.find((l) => l.postalCodes.includes(customer.billingPostal ?? '')) ?? LOCATIONS[0];
    // A property manager carries a portfolio; a household has one address.
    const propertyCount =
      customer.type === 'PROPERTY_MANAGER' ? rng.int(4, 14) : customer.type === 'BUILDER' ? rng.int(2, 6) : 1;

    for (let p = 0; p < propertyCount; p++) {
      propertyRows.push({
        customerId: customer.id,
        label: propertyCount > 1 ? `Unit ${rng.int(101, 480)}` : null,
        addressLine1: `${rng.int(100, 9899)} ${rng.pick(STREET_NAMES)}`,
        city: location.city,
        state: 'AZ',
        postalCode: rng.pick(location.postalCodes),
        taxJurisdictionId: jurisdictionByCode.get(location.code)!,
        accessNotes: rng.bool(0.25)
          ? rng.pick(['Gate code 4417', 'Dog in back yard', 'Park in alley', 'Lockbox on hose bib'])
          : null,
      });
    }
  }
  await db.property.createMany({ data: propertyRows });

  const properties = await db.property.findMany({
    where: { customer: { organizationId: org.id } },
    select: { id: true, customerId: true, postalCode: true },
  });

  for (const property of properties) {
    const location =
      LOCATIONS.find((l) => l.postalCodes.includes(property.postalCode)) ?? LOCATIONS[0];
    const customer = createdCustomers.find((c) => c.id === property.customerId)!;
    customers.push({
      id: customer.id,
      propertyId: property.id,
      locationCode: location.code,
      priceTier: customer.priceTier,
    });
  }
  log(`Customers: ${createdCustomers.length}, properties: ${properties.length}`);

  // ---------------------------------------------------------------- stock
  // Each branch receives a monthly resupply and pushes stock out to its vans, so van
  // balances, average costs and reorder points all have real history behind them.
  const stockLines = PART_ITEMS.map((p) => ({ sku: p.sku, id: itemBySku.get(p.sku)! }));

  for (let monthOffset = 0; monthOffset <= 12; monthOffset++) {
    const monthStart = new Date(
      Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + monthOffset, 2, 9),
    );
    if (monthStart > today) break;

    for (const location of LOCATIONS) {
      const warehouse = warehouseByCode.get(location.code)!;
      await receiveStock(db, ctx, {
        stockLocationId: warehouse,
        occurredAt: monthStart,
        reference: `PO-${location.code}-${monthStart.toISOString().slice(0, 7)}`,
        lines: stockLines.map((part) => {
          const seed = PART_ITEMS.find((p) => p.sku === part.sku)!;
          // Supplier prices drift; that is what makes a moving average worth having.
          const drift = 1 + rng.float(-0.04, 0.09) + monthOffset * 0.004;
          return {
            priceBookItemId: part.id,
            quantity: String(rng.int(18, 60)),
            unitCostCents: BigInt(Math.round(Number(seed.costCents) * drift)),
          };
        }),
      });

      const branchTechs = techs.filter((t) => t.locationCode === location.code);
      for (const tech of branchTechs) {
        await transferStock(db, ctx, {
          fromStockLocationId: warehouse,
          toStockLocationId: tech.vanStockLocationId,
          occurredAt: new Date(monthStart.getTime() + 3 * 3600 * 1000),
          reference: `Van resupply ${monthStart.toISOString().slice(0, 7)}`,
          lines: stockLines
            .filter(() => rng.bool(0.7))
            .map((part) => ({ priceBookItemId: part.id, quantity: String(rng.int(2, 8)) })),
        });
      }
    }
  }
  log('Inventory: twelve months of warehouse receipts and van resupply');

  // ---------------------------------------------------------------- jobs
  await postJournalEntry(db, ctx, {
    entryDate: new Date(windowStart.getTime() - 3 * 86_400_000),
    source: 'MANUAL',
    memo: 'Owner capital in the operating account at the start of the period',
    lines: [
      { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: 34_000_00n },
      { accountCode: ACCOUNTS.OWNERS_EQUITY, creditCents: 34_000_00n },
    ],
  });

  const monthWeights: { start: Date; weight: number }[] = [];
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + m, 1));
    if (start > today) break;
    monthWeights.push({ start, weight: SEASONALITY[start.getUTCMonth()] });
  }

  const totalWeight = monthWeights.reduce((t, m) => t + m.weight, 0);
  let jobsCreated = 0;
  /** Billable hours booked to jobs this month, by technician. */
  let billableHours = new Map<string, number>();
  const completedJobs: { jobId: string; techId: string; date: Date; serviceCode: ServiceCode; locationCode: string }[] = [];

  for (const [index, month] of monthWeights.entries()) {
    const monthJobs = Math.round((jobTarget * month.weight) / totalWeight);

    const specs: OneJobInput[] = [];
    for (let j = 0; j < monthJobs; j++) {
      const location = rng.weighted(LOCATIONS.map((l) => [l, l.volumeWeight] as const));
      const branchTechs = techs.filter((t) => t.locationCode === location.code);
      const tech = rng.pick(branchTechs);
      const serviceCode = rng.pick(tech.skills);

      const daysInMonth = new Date(
        Date.UTC(month.start.getUTCFullYear(), month.start.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const day = rng.int(1, daysInMonth);
      const workDate = new Date(
        Date.UTC(month.start.getUTCFullYear(), month.start.getUTCMonth(), day, rng.int(8, 16)),
      );
      if (workDate > today) continue;

      const candidate = customers.filter((c) => c.locationCode === location.code);
      if (candidate.length === 0) continue;
      const customer = rng.pick(candidate);

      specs.push({
        // Each job gets its own stream, so a job's own content does not depend on how
        // many jobs happened to run before it finished.
        rng: new Rng(rng.int(1, 2 ** 30)),
        workDate,
        tech,
        serviceCode,
        locationId: locationByCode.get(location.code)!,
        locationCode: location.code,
        customerId: customer.id,
        propertyId: customer.propertyId,
        itemBySku,
        serviceTypeId: serviceTypeByCode.get(serviceCode)!,
        leaveInFlight: false,
        vendorIds,
      });
    }

    // Decided by count rather than per job: a coin flip can leave a small demo dataset
    // with an empty dispatch board, which is the one thing it must never look like.
    if (index === monthWeights.length - 1 && specs.length > 0) {
      const inFlight = Math.max(1, Math.round(specs.length * 0.22));
      for (const spec of rng.shuffle(specs).slice(0, inFlight)) {
        spec.leaveInFlight = true;
      }
    }

    const results = await inBatches(specs, 8, (spec) => seedOneJob(db, ctx, spec));

    for (const [i, created] of results.entries()) {
      if (!created) continue;
      const spec = specs[i];
      jobsCreated++;
      if (created.hours) {
        billableHours.set(
          spec.tech.technicianId,
          (billableHours.get(spec.tech.technicianId) ?? 0) + created.hours,
        );
      }
      if (created.completed) {
        completedJobs.push({
          jobId: created.jobId,
          techId: spec.tech.technicianId,
          date: spec.workDate,
          serviceCode: spec.serviceCode,
          locationCode: spec.locationCode,
        });
      }
    }
    await postUnbilledTechnicianTime(db, ctx, {
      month: month.start,
      today,
      techs,
      billableHours,
    });
    billableHours = new Map();

    await postMonthEnd(db, ctx, {
      month: month.start,
      today,
      rng,
      locationByCode,
      technicianCountByCode: Object.fromEntries(
        LOCATIONS.map((l) => [l.code, techs.filter((t) => t.locationCode === l.code).length]),
      ),
    });

    log(`  ${month.start.toISOString().slice(0, 7)}: ${monthJobs} jobs`);
  }

  // ---------------------------------------------------------------- callbacks
  // Warranty rework, linked to the original job. Non-billable, but it still costs, which
  // is exactly why it belongs on a technician's scorecard.
  let callbacks = 0;

  // Chosen by count rather than by a coin flip per job, so a small demo dataset still has
  // rework in it. Selection is weighted by each technician's own callback rate, so the
  // differences between them — which is the whole point of the scorecard — survive.
  const callbackTarget = Math.max(
    completedJobs.length > 0 ? 1 : 0,
    Math.round(
      completedJobs.reduce(
        (total, job) => total + (techs.find((t) => t.technicianId === job.techId)?.callbackRate ?? 0),
        0,
      ),
    ),
  );

  const weighted = completedJobs
    .map((job) => {
      const rate = techs.find((t) => t.technicianId === job.techId)?.callbackRate ?? 0.001;
      // Efraimidis-Spirakis: the largest keys are a weighted sample without replacement.
      return { job, key: Math.pow(rng.next(), 1 / Math.max(rate, 0.001)) };
    })
    .sort((a, b) => b.key - a.key)
    .slice(0, callbackTarget)
    .map((entry) => entry.job);

  for (const job of weighted) {
    const tech = techs.find((t) => t.technicianId === job.techId)!;
    const callbackDate = new Date(job.date.getTime() + rng.int(3, 45) * 86_400_000);
    if (callbackDate > today) continue;

    const original = await db.job.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { customerId: true, propertyId: true, locationId: true, jobNo: true },
    });

    const callback = await createJob(db, ctx, {
      locationId: original.locationId,
      customerId: original.customerId,
      propertyId: original.propertyId,
      title: `Callback — issue returned after ${original.jobNo}`,
      serviceTypeId: undefined,
      parentJobId: job.jobId,
      isWarranty: true,
      scheduledStart: callbackDate,
    });

    await transitionJob(db, ctx, callback.id, 'IN_PROGRESS');
    await transitionJob(db, ctx, callback.id, 'COMPLETED');

    const hours = rng.float(0.75, 2).toFixed(2);
    await postJournalEntry(db, ctx, {
      entryDate: callbackDate,
      source: 'PAYROLL',
      sourceType: 'TimeEntry',
      sourceId: callback.id,
      memo: `Warranty labor — ${callback.jobNo}`,
      lines: laborCostedLines({
        jobId: callback.id,
        locationId: original.locationId,
        technicianId: tech.technicianId,
        hours,
        baseHourlyCents: tech.baseHourlyCents,
        loadedHourlyCents: tech.loadedHourlyCents,
        description: 'Warranty rework',
      }),
    });
    callbacks++;
  }
  log(`Callbacks: ${callbacks} warranty jobs, costed but not billed`);

  // ---------------------------------------------------------------- period close
  // Everything up to the end of the month before last is closed, so the demo can show a
  // posting being refused and a reopening being audited.
  const closeThrough = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 0));
  const closable = await db.accountingPeriod.findMany({
    where: { organizationId: org.id, endDate: { lte: closeThrough }, status: 'OPEN' },
    orderBy: [{ fiscalYear: 'asc' }, { periodNumber: 'asc' }],
  });
  for (const period of closable) {
    await closePeriod(db, ctx, period.id);
  }
  log(`Periods: ${closable.length} closed through ${closeThrough.toISOString().slice(0, 7)}`);

  const [invoiceCount, paymentCount, entryCount, jobCount] = await Promise.all([
    db.invoice.count({ where: { organizationId: org.id } }),
    db.payment.count({ where: { organizationId: org.id } }),
    db.journalEntry.count({ where: { organizationId: org.id } }),
    db.job.count({ where: { organizationId: org.id } }),
  ]);

  return {
    organizationId: org.id,
    counts: {
      locations: LOCATIONS.length,
      users: OFFICE_STAFF.length + techs.length,
      technicians: techs.length,
      customers: createdCustomers.length,
      properties: properties.length,
      priceBookItems: ALL_PRICE_ITEMS.length,
      jobs: jobCount,
      invoices: invoiceCount,
      payments: paymentCount,
      journalEntries: entryCount,
    },
    signIn,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Run a list of tasks with bounded concurrency, preserving result order. */
async function inBatches<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await run(items[index]);
      }
    }),
  );

  return results;
}

interface OneJobInput {
  rng: Rng;
  workDate: Date;
  tech: SeededTech;
  serviceCode: ServiceCode;
  locationId: string;
  locationCode: string;
  customerId: string;
  propertyId: string;
  itemBySku: Map<string, string>;
  serviceTypeId: string;
  /** Left mid-flight so the dispatch board has live work on it. */
  leaveInFlight: boolean;
  vendorIds: { supply: string[]; sub: string[] };
}

/**
 * One job's whole life, through the same services the application uses: quoted or not,
 * dispatched, worked, parts consumed off the van, labor costed at the technician's loaded
 * rate, invoiced, and usually paid.
 */
async function seedOneJob(
  db: PrismaClient,
  ctx: AuthContext,
  input: OneJobInput,
): Promise<{ jobId: string; completed: boolean; hours?: number } | null> {
  const { rng, workDate, tech, itemBySku } = input;

  const tasks = TASK_ITEMS.filter((t) => t.serviceCode === input.serviceCode);
  if (tasks.length === 0) return null;

  // A visit is rarely one thing. Property managers in particular hand over a punch list,
  // so a job bundles one to three tasks from the same trade.
  const taskCount = rng.weighted([
    [1, 46],
    [2, 34],
    [3, 20],
  ] as const);
  const chosen = rng.shuffle([...tasks]).slice(0, Math.min(taskCount, tasks.length));
  const task = chosen[0];

  const lines: { priceBookItemId: string; quantity: string; category?: LineCategory }[] =
    chosen.map((t) => ({ priceBookItemId: itemBySku.get(t.sku)!, quantity: '1' }));
  // Roughly a third of jobs run over the flat rate and pick up extra hours.
  if (rng.bool(0.34)) {
    lines.push({
      priceBookItemId: itemBySku.get(tech.laborSku)!,
      quantity: rng.float(0.5, 2.5).toFixed(2),
    });
  }
  if (rng.bool(0.4)) {
    lines.push({ priceBookItemId: itemBySku.get('FEE-TRIP')!, quantity: '1' });
  }

  const partSkus = PARTS_BY_SERVICE[input.serviceCode] ?? [];
  const usedParts = partSkus.filter(() => rng.bool(0.45)).slice(0, 3);
  for (const sku of usedParts) {
    lines.push({ priceBookItemId: itemBySku.get(sku)!, quantity: String(rng.int(1, 3)) });
  }

  // ------------------------------------------------- quoted, or booked straight in
  let jobId: string;
  const wasQuoted = rng.bool(0.36);

  if (wasQuoted) {
    const quote = await createQuote(db, ctx, {
      locationId: input.locationId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      title: chosen.length > 1 ? `${task.name} + ${chosen.length - 1} more` : task.name,
      presentedByTechnicianId: tech.technicianId,
      lines: lines.map((l) => ({ priceBookItemId: l.priceBookItemId, quantity: l.quantity })),
    });
    await sendQuote(db, ctx, quote.id);

    // A close rate a shop would recognize. Unclosed quotes stay on the pipeline report.
    if (!rng.bool(0.62)) return { jobId: quote.id, completed: false };

    await approveQuote(db, ctx, quote.id, {
      signerName: 'Customer signature',
      signatureStorageKey: `demo/signatures/${quote.id}.png`,
      ipAddress: '198.51.100.24',
      deviceInfo: 'iPad (field)',
    });
    const job = await convertQuoteToJob(db, ctx, quote.id, {
      scheduledStart: workDate,
      serviceTypeId: input.serviceTypeId,
    });
    jobId = job.id;
  } else {
    const job = await createJob(db, ctx, {
      locationId: input.locationId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      title: chosen.length > 1 ? `${task.name} + ${chosen.length - 1} more` : task.name,
      serviceTypeId: input.serviceTypeId,
      scheduledStart: workDate,
      priority: rng.bool(0.08) ? 'HIGH' : 'NORMAL',
    });
    jobId = job.id;
    await addJobLines(
      db,
      ctx,
      jobId,
      lines.map((line) => ({
        priceBookItemId: line.priceBookItemId,
        quantity: line.quantity,
      })),
    );
  }

  await db.jobAssignment.create({
    data: { jobId, technicianId: tech.technicianId, isLead: true },
  });

  // ------------------------------------------------- work in the most recent weeks
  // Some of the newest jobs are left mid-flight, so the dispatch board is not a graveyard
  // of finished work.
  if (input.leaveInFlight) {
    await transitionJob(db, ctx, jobId, 'DISPATCHED');
    if (rng.bool(0.5)) await transitionJob(db, ctx, jobId, 'IN_PROGRESS');
    return { jobId, completed: false };
  }

  await transitionJob(db, ctx, jobId, 'DISPATCHED');
  await transitionJob(db, ctx, jobId, 'IN_PROGRESS');
  await transitionJob(db, ctx, jobId, 'COMPLETED');

  // ------------------------------------------------- actual cost
  const quotedHours = chosen.reduce((t, c) => t + Number(c.estimatedHours ?? '2'), 0);
  const actualHours = rng.normal(quotedHours, quotedHours * 0.22, 0.5, quotedHours * 2).toFixed(2);

  await postJournalEntry(db, ctx, {
    entryDate: workDate,
    source: 'PAYROLL',
    sourceType: 'TimeEntry',
    sourceId: jobId,
    memo: 'Technician hours',
    lines: laborCostedLines({
      jobId,
      locationId: input.locationId,
      technicianId: tech.technicianId,
      serviceTypeId: input.serviceTypeId,
      hours: actualHours,
      baseHourlyCents: tech.baseHourlyCents,
      loadedHourlyCents: tech.loadedHourlyCents,
    }),
  });

  if (usedParts.length > 0) {
    await consumePartsForJob(db, ctx, {
      jobId,
      stockLocationId: tech.vanStockLocationId,
      technicianId: tech.technicianId,
      occurredAt: workDate,
      deferRollup: true,
      lines: usedParts.map((sku) => ({
        priceBookItemId: itemBySku.get(sku)!,
        quantity: String(lines.find((l) => l.priceBookItemId === itemBySku.get(sku))?.quantity ?? 1),
      })),
    });
  }

  // ------------------------------------------------- bought on the way
  // A third of jobs need something nobody stocks. The technician buys it at the supply
  // house, photographs the receipt, and it lands against this job rather than against
  // next month and nothing in particular.
  if (rng.bool(0.33) && input.vendorIds.supply.length > 0) {
    const jobRevenue = lines.reduce((total, line) => {
      const item = ALL_PRICE_ITEMS.find((i) => itemBySku.get(i.sku) === line.priceBookItemId);
      return total + Number(item?.priceCents ?? 0n) * Number(line.quantity);
    }, 0);
    const spend = Math.round(jobRevenue * rng.float(0.1, 0.3));
    if (spend > 500) {
      await recordJobPurchase(db, ctx, {
        jobId,
        vendorId: rng.pick(input.vendorIds.supply),
        amountCents: BigInt(spend),
        description: rng.pick([
          'Special-order fixture',
          'Non-stock trim and hardware',
          'Job-specific materials',
          'Replacement unit',
        ]),
        receiptPhotoKey: `demo/receipts/${jobId}.jpg`,
        vendorInvoiceNo: `SO-${rng.int(100000, 999999)}`,
        purchasedAt: workDate,
        technicianId: tech.technicianId,
      });
    }
  }

  // A small share of work is subcontracted out — tile, glazing, anything specialised.
  if (rng.bool(0.06) && input.vendorIds.sub.length > 0) {
    await recordJobPurchase(db, ctx, {
      jobId,
      vendorId: rng.pick(input.vendorIds.sub),
      amountCents: BigInt(rng.int(18_000, 95_000)),
      description: 'Subcontracted specialty work',
      purchasedAt: workDate,
      isSubcontract: true,
    });
  }

  // ------------------------------------------------- bill and collect
  const invoice = await createInvoiceFromJob(db, ctx, { jobId, issueDate: workDate });
  await issueInvoice(db, ctx, invoice.id);

  // Most residential work is paid on the spot; commercial terms mean some is still open.
  const paidImmediately = rng.bool(0.72);
  const paidLater = !paidImmediately && rng.bool(0.6);

  if (paidImmediately || paidLater) {
    const paidAt = paidImmediately
      ? workDate
      : new Date(workDate.getTime() + rng.int(8, 52) * 86_400_000);

    if (paidAt <= new Date()) {
      const method = rng.weighted([
        ['CARD', 62],
        ['CHECK', 22],
        ['ACH', 12],
        ['CASH', 4],
      ] as const);
      // Card processing runs about 2.9% plus thirty cents.
      const fee =
        method === 'CARD'
          ? (invoice.totalCents * 29n) / 1000n + 30n
          : 0n;

      await recordPayment(db, ctx, {
        customerId: input.customerId,
        locationId: input.locationId,
        method,
        amountCents: invoice.totalCents,
        feeCents: fee,
        receivedAt: paidAt,
        invoiceId: invoice.id,
        ...(method === 'CARD'
          ? { cardLast4: String(rng.int(1000, 9999)), cardBrand: rng.pick(['visa', 'mastercard', 'amex']) }
          : {}),
      });
    }
  }

  return { jobId, completed: true, hours: Number(actualHours) };
}

/** Signed balance of one account as of a date, read straight off the posted ledger. */
async function accountBalance(
  db: PrismaClient,
  organizationId: string,
  code: string,
  asOf: Date,
): Promise<bigint> {
  const account = await db.account.findFirst({
    where: { organizationId, code },
    select: { id: true },
  });
  if (!account) return 0n;

  const totals = await db.journalLine.aggregate({
    where: {
      accountId: account.id,
      journalEntry: { organizationId, postedAt: { not: null }, entryDate: { lte: asOf } },
    },
    _sum: { debitCents: true, creditCents: true },
  });

  return (totals._sum.debitCents ?? 0n) - (totals._sum.creditCents ?? 0n);
}

interface MonthEndInput {
  month: Date;
  today: Date;
  rng: Rng;
  locationByCode: Map<string, string>;
  technicianCountByCode: Record<string, number>;
}

/**
 * The month-end run.
 *
 * Without this the demo's income statement stops at gross profit, and the first thing a
 * controller notices is that net income equals gross profit — no rent, no advertising, no
 * office payroll. It also moves collected money out of the holding accounts and into the
 * bank, which is what gives the bank reconciliation something to reconcile.
 */
async function postMonthEnd(db: PrismaClient, ctx: AuthContext, input: MonthEndInput): Promise<void> {
  const { month, rng } = input;
  const monthEnd = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0, 17),
  );
  const entryDate = monthEnd > input.today ? input.today : monthEnd;

  // ---- collections move to the bank ---------------------------------------
  const undeposited = await accountBalance(db, ctx.organizationId, ACCOUNTS.UNDEPOSITED_FUNDS, entryDate);
  if (undeposited > 0n) {
    await postJournalEntry(db, ctx, {
      entryDate,
      source: 'DEPOSIT',
      memo: 'Cash and cheque deposit',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: undeposited },
        { accountCode: ACCOUNTS.UNDEPOSITED_FUNDS, creditCents: undeposited },
      ],
    });
  }

  const clearing = await accountBalance(db, ctx.organizationId, ACCOUNTS.CARD_CLEARING, entryDate);
  if (clearing > 0n) {
    // The processor holds a few days' takings back, so the sweep is not quite complete —
    // which is exactly the sort of timing difference a bank reconciliation exists for.
    const settled = (clearing * 94n) / 100n;
    await postJournalEntry(db, ctx, {
      entryDate,
      source: 'PAYMENT',
      memo: 'Card processor settlement',
      lines: [
        { accountCode: ACCOUNTS.BANK_OPERATING, debitCents: settled },
        { accountCode: ACCOUNTS.CARD_CLEARING, creditCents: settled },
      ],
    });
  }

  // ---- sales tax is remitted, not kept ------------------------------------
  const taxOwed = -(await accountBalance(db, ctx.organizationId, ACCOUNTS.SALES_TAX_PAYABLE, entryDate));
  if (taxOwed > 0n) {
    await postJournalEntry(db, ctx, {
      entryDate,
      source: 'TAX_REMITTANCE',
      memo: 'Arizona TPT remittance',
      lines: [
        { accountCode: ACCOUNTS.SALES_TAX_PAYABLE, debitCents: taxOwed },
        { accountCode: ACCOUNTS.BANK_OPERATING, creditCents: taxOwed },
      ],
    });
  }

  // ---- payables ------------------------------------------------------------
  await payOpenBills(db, ctx, { throughDate: entryDate });

  // ---- overhead ------------------------------------------------------------
  const rentByBranch: Record<string, bigint> = { PHX: 8_500_00n, MES: 5_200_00n, SCT: 4_800_00n };
  const branchLines: Parameters<typeof postJournalEntry>[2]['lines'] = [];
  let branchTotal = 0n;

  for (const location of LOCATIONS) {
    const locationId = input.locationByCode.get(location.code)!;
    const techCount = BigInt(input.technicianCountByCode[location.code] ?? 0);
    const jitter = (amount: bigint) =>
      (amount * BigInt(Math.round(rng.float(0.92, 1.09) * 1000))) / 1000n;

    const items: [string, bigint][] = [
      ['6040', rentByBranch[location.code] ?? 5_000_00n], // facility rent
      ['6050', jitter(72_000n)], // utilities
      ['6110', jitter(techCount * 47_000n)], // fuel
      ['6120', jitter(techCount * 18_500n)], // vehicle maintenance
      ['6200', 1_40_000n], // general liability
      ['6010', jitter(2_80_000n)], // advertising
    ];

    for (const [code, amount] of items) {
      if (amount <= 0n) continue;
      branchLines.push({ accountCode: code, debitCents: amount, locationId });
      branchTotal += amount;
    }
  }

  // Company overhead is not attributed to a branch: allocating it would make branch
  // "profit" a function of the allocation formula rather than of the branch.
  const companyItems: [string, bigint][] = [
    ['6020', 42_000_00n], // office salaries — nine office staff across three branches
    ['6030', 3_40_000n], // employer payroll taxes on office staff
    ['6060', 2_40_000n], // software
    ['6070', 90_000n], // company licensing and registrations
    ['6080', 1_20_000n], // training and certification
    ['6400', 1_80_000n], // accounting and legal
    ['6500', 4_20_000n], // depreciation on vans and tools
  ];
  for (const [code, amount] of companyItems) {
    branchLines.push({ accountCode: code, debitCents: amount });
    branchTotal += amount;
  }

  if (branchTotal > 0n) {
    await postJournalEntry(db, ctx, {
      entryDate,
      source: 'MANUAL',
      memo: `Operating expenses — ${month.toISOString().slice(0, 7)}`,
      lines: [
        ...branchLines,
        { accountCode: ACCOUNTS.BANK_OPERATING, creditCents: branchTotal },
      ],
    });
  }
}

interface UnbilledTimeInput {
  month: Date;
  today: Date;
  techs: { technicianId: string; locationId: string; baseHourlyCents: bigint; loadedHourlyCents: bigint }[];
  billableHours: Map<string, number>;
}

/**
 * Paid hours that were not billed to a job.
 *
 * A technician is paid for roughly 173 hours a month. Drive time between calls, shop time,
 * restocking the van, training and the gaps between jobs are all paid, and they are all
 * cost of providing the service — so they belong in COGS, not quietly nowhere.
 *
 * Costing only billable hours is the single most flattering mistake a field service system
 * can make: it reports gross margins in the seventies for a trade that really runs in the
 * forties, and an owner who prices off that number loses money on every job. It also makes
 * technician utilization measurable, which is the number that actually moves profit.
 */
async function postUnbilledTechnicianTime(
  db: PrismaClient,
  ctx: AuthContext,
  input: UnbilledTimeInput,
): Promise<void> {
  const PAID_HOURS_PER_MONTH = 173;
  const monthEnd = new Date(Date.UTC(input.month.getUTCFullYear(), input.month.getUTCMonth() + 1, 0, 17));
  const entryDate = monthEnd > input.today ? input.today : monthEnd;

  const lines: Parameters<typeof postJournalEntry>[2]['lines'] = [];
  let total = 0n;

  for (const tech of input.techs) {
    const billed = input.billableHours.get(tech.technicianId) ?? 0;
    const unbilled = PAID_HOURS_PER_MONTH - billed;
    if (unbilled <= 0.05) continue;

    const hours = BigInt(Math.round(unbilled * 100));
    const wage = (hours * tech.baseHourlyCents) / 100n;
    const burden = (hours * (tech.loadedHourlyCents - tech.baseHourlyCents)) / 100n;
    if (wage + burden <= 0n) continue;

    lines.push({
      accountCode: ACCOUNTS.COGS_LABOR,
      debitCents: wage,
      locationId: tech.locationId,
      technicianId: tech.technicianId,
      memo: `Unbilled paid hours (${unbilled.toFixed(1)})`,
    });
    lines.push({
      accountCode: ACCOUNTS.COGS_BURDEN,
      debitCents: burden,
      locationId: tech.locationId,
      technicianId: tech.technicianId,
      memo: 'Burden on unbilled hours',
    });
    total += wage + burden;
  }

  if (total === 0n) return;

  lines.push({ accountCode: ACCOUNTS.PAYROLL_LIABILITIES, creditCents: total });

  await postJournalEntry(db, ctx, {
    entryDate,
    source: 'PAYROLL',
    memo: `Unbilled technician hours — ${input.month.toISOString().slice(0, 7)}`,
    lines,
  });
}
