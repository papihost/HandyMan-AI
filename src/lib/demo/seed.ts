import type { LineCategory, Prisma, PrismaClient } from '@prisma/client';
import { systemContext, type AuthContext } from '../auth/context';
import { hashPassword } from '../auth/password';
import { provisionOrganization } from '../accounting/setup';
import { ACCOUNTS } from '../accounting/chart-of-accounts';
import { closePeriod } from '../accounting/periods';
import { postJournalEntry } from '../accounting/ledger';
import { laborCostedLines, loadedHourlyCost } from '../accounting/rules/labor';
import { addJobLines, createJob, transitionJob } from '../jobs/service';
import {
  approveQuote,
  convertQuoteToJob,
  createQuote,
  declineQuote,
  sendQuote,
} from '../quotes/service';
import { createInvoiceFromJob, issueInvoice, recordPayment } from '../invoices/service';
import { bankTakings } from '../invoices/banking';
import { issueCreditMemo } from '../invoices/credits';
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
  /*
   * Who each trade's parts come from.
   *
   * A restock list nobody can act on is just a list: to raise a purchase order you have to
   * know who sells the thing. Real shops buy plumbing from the plumbing house and fasteners
   * from the hardware place, so the trade on each part decides its supplier.
   */
  const vendorSeeds: {
    name: string;
    kind: 'supply' | 'sub';
    terms: number;
    is1099: boolean;
    supplies?: ServiceCode[];
  }[] = [
    { name: 'Copper State Supply', kind: 'supply', terms: 30, is1099: false, supplies: ['PLM', 'APL'] },
    { name: 'Desert Builders Wholesale', kind: 'supply', terms: 30, is1099: false, supplies: ['DRY', 'CRP'] },
    { name: 'Valley Hardware & Fasteners', kind: 'supply', terms: 15, is1099: false, supplies: ['GEN', 'DRS'] },
    { name: 'Sunbelt Electrical Supply', kind: 'supply', terms: 30, is1099: false, supplies: ['ELE'] },
    { name: 'Rivera Tile & Stone (sub)', kind: 'sub', terms: 15, is1099: true },
    { name: 'Ahmadi Glazing (sub)', kind: 'sub', terms: 15, is1099: true },
  ];

  /** Trade → the supply house that sells its parts. */
  const vendorByTrade = new Map<ServiceCode, string>();

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
    for (const trade of seed.supplies ?? []) vendorByTrade.set(trade, vendor.id);
  }

  // Every stocked part gets a supplier, so the reorder list can be turned into orders.
  for (const part of PART_ITEMS) {
    const vendorId = part.serviceCode ? vendorByTrade.get(part.serviceCode) : undefined;
    if (!vendorId) continue;
    await db.priceBookItem.updateMany({
      where: { organizationId: org.id, sku: part.sku },
      data: { preferredVendorId: vendorId },
    });
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

  // Upsert, not update: nothing has allocated a customer number yet, so the sequence row
  // does not exist and an update would match nothing and report success. The next customer
  // anyone adds would then be handed C-00001, which already belongs to someone.
  await db.documentSequence.upsert({
    where: {
      organizationId_docType_locationCode: {
        organizationId: org.id,
        docType: 'CUSTOMER',
        locationCode: '',
      },
    },
    create: {
      organizationId: org.id,
      docType: 'CUSTOMER',
      locationCode: '',
      prefix: 'C-',
      padding: 5,
      nextValue: firstCustomerNo + customerTarget,
    },
    update: { nextValue: firstCustomerNo + customerTarget },
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
  /*
   * Stock is loaded month by month, inside the job loop below, rather than all at once up
   * front.
   *
   * A fixed monthly trickle cannot work: a van gets through eleven boxes of screws a month
   * and one GFCI receptacle, so any single number is far too little for one and far too
   * much for the other. Sending the same handful of everything to every van produced a
   * company where a third of all van stock lines had gone negative — parts consumed that
   * were never received, which is not a demo of an inventory system, it is a demo of not
   * having one.
   *
   * So each month every van is topped back up to a par of roughly two months of what that
   * technician actually gets through, and the warehouse orders what the vans are about to
   * take. It is what a well-run shop does, and it is self-correcting: a trade that starts
   * using more of something is carrying more of it by the following month.
   */
  const stockLines = PART_ITEMS.map((p) => ({ sku: p.sku, id: itemBySku.get(p.sku)! }));

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

  /**
   * History stops a few days short of today, and the days either side of now are laid out
   * deliberately below.
   *
   * Left to the random month generator, "today" gets whatever jobs happen to land on it —
   * which is frequently none, and a demo that opens on a technician with an empty morning
   * is over before it starts.
   */
  const CURRENT_WINDOW_BACK_DAYS = jobTarget >= 1000 ? 3 : 1;
  const CURRENT_WINDOW_FORWARD_DAYS = jobTarget >= 1000 ? 5 : 1;
  const JOBS_PER_TECH_PER_DAY = Math.max(
    jobTarget >= 1000 ? 2 : 1,
    Math.min(3, Math.round(jobTarget / (12 * 22 * TECHNICIANS.length))),
  );
  const historyEnd = new Date(today.getTime() - CURRENT_WINDOW_BACK_DAYS * 86_400_000);

  // Finished work that never got invoiced. Nine jobs is a believable tail for a shop
  // this size — enough that the oldest has been sitting for weeks, small enough that
  // it reads as an oversight rather than a broken billing process.
  const UNBILLED_JOB_COUNT = jobTarget >= 1000 ? 9 : 2;
  const UNBILLED_WINDOW_DAYS = 30;
  let unbilledRemaining = UNBILLED_JOB_COUNT;

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
    // The trucks are loaded before the month's work, from what last month actually used.
    await resupplyVans(db, ctx, {
      monthStart: new Date(month.start.getTime() + 9 * 3600 * 1000),
      monthOffset: index,
      rng,
      warehouseByCode,
      techs,
      stockLines,
    });

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
      if (workDate > historyEnd) continue;

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
        vendorIds,
      });
    }

    // The oldest eligible jobs are the ones left unbilled, so the dashboard can say how
    // long the worst of it has been waiting — a number that only means something if the
    // completion date is real, which is why transitions are backdated above.
    if (unbilledRemaining > 0) {
      const cutoff = today.getTime() - UNBILLED_WINDOW_DAYS * 86_400_000;
      const eligible = specs
        .filter((spec) => spec.workDate.getTime() >= cutoff)
        .sort((a, b) => a.workDate.getTime() - b.workDate.getTime());

      // Spread across the window rather than taken off the front: nine jobs that all
      // stopped being billed on the same afternoon reads as a data problem, and a real
      // billing tail is a few from each week.
      const stride = Math.max(1, Math.floor(eligible.length / Math.max(unbilledRemaining, 1)));
      for (let i = 0; i < eligible.length && unbilledRemaining > 0; i += stride) {
        eligible[i].leaveUnbilled = true;
        unbilledRemaining--;
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
    // The month containing today is left open: this week's work belongs to it, and has
    // not been created yet. It is costed and closed once it has.
    const isCurrentMonth = index === monthWeights.length - 1;
    if (!isCurrentMonth) {
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
    }

    log(`  ${month.start.toISOString().slice(0, 7)}: ${monthJobs} jobs`);
  }

  // ---------------------------------------------------------------- this week
  const thisWeek = await scheduleCurrentWeek(db, ctx, {
    rng,
    today,
    backDays: CURRENT_WINDOW_BACK_DAYS,
    forwardDays: CURRENT_WINDOW_FORWARD_DAYS,
    perTechPerDay: JOBS_PER_TECH_PER_DAY,
    techs,
    customers,
    locationByCode,
    serviceTypeByCode,
    itemBySku,
    vendorIds,
  });

  jobsCreated += thisWeek.created;
  for (const [technicianId, hours] of thisWeek.billableHours) {
    billableHours.set(technicianId, (billableHours.get(technicianId) ?? 0) + hours);
  }
  completedJobs.push(...thisWeek.completedJobs);

  const currentMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  await postUnbilledTechnicianTime(db, ctx, {
    month: currentMonth,
    today,
    techs,
    billableHours,
  });
  billableHours = new Map();

  await postMonthEnd(db, ctx, {
    month: currentMonth,
    today,
    rng,
    locationByCode,
    technicianCountByCode: Object.fromEntries(
      LOCATIONS.map((l) => [l.code, techs.filter((t) => t.locationCode === l.code).length]),
    ),
  });

  log(
    `  this week: ${thisWeek.created} jobs — ${thisWeek.todayCount} today, ` +
      `${thisWeek.inFlightCount} already under way`,
  );

  // ---------------------------------------------------------------- callbacks
  // Warranty rework, linked to the original job. Non-billable, but it still costs, which
  // is exactly why it belongs on a technician's scorecard.
  let callbacks = 0;

  /*
   * Chosen by count rather than by a coin flip per job, so a small demo dataset still has
   * rework in it. Selection is weighted by each technician's own callback rate, so the
   * differences between them — which is the whole point of the scorecard — survive.
   *
   * Only jobs old enough for somebody to have called back about are eligible. Filtering
   * after the draw instead of before it meant the "at least one" floor was not a floor:
   * pick the one candidate whose callback would land next week and you get none at all,
   * which is how a company with four and a half thousand jobs ended up with a scorecard
   * claiming nobody had ever gone back.
   */
  const MIN_CALLBACK_GAP_DAYS = 3;
  const MAX_CALLBACK_GAP_DAYS = 45;
  const eligible = completedJobs.filter(
    (job) => job.date.getTime() + MIN_CALLBACK_GAP_DAYS * 86_400_000 <= today.getTime(),
  );

  const callbackTarget = Math.max(
    eligible.length > 0 ? 1 : 0,
    Math.round(
      eligible.reduce(
        (total, job) => total + (techs.find((t) => t.technicianId === job.techId)?.callbackRate ?? 0),
        0,
      ),
    ),
  );

  const weighted = eligible
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
    const latestGap = Math.min(
      MAX_CALLBACK_GAP_DAYS,
      Math.floor((today.getTime() - job.date.getTime()) / 86_400_000),
    );
    const callbackDate = new Date(
      job.date.getTime() + rng.int(MIN_CALLBACK_GAP_DAYS, latestGap) * 86_400_000,
    );

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

    // The technician who did the original goes back — which is exactly why the callback
    // belongs on their scorecard, so the assignment has to exist for it to be counted.
    await db.jobAssignment.create({
      data: { jobId: callback.id, technicianId: tech.technicianId, isLead: true },
    });

    await transitionJob(db, ctx, callback.id, 'IN_PROGRESS', { occurredAt: callbackDate });
    await transitionJob(db, ctx, callback.id, 'COMPLETED', {
      occurredAt: new Date(callbackDate.getTime() + 90 * 60_000),
    });

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
  /*
   * Everything up to two months back is closed, which leaves a month sitting ready to be
   * closed on screen and the one behind it carrying a reason not to — the finished jobs
   * nobody invoiced. That pair is the whole of the close screen's story.
   */
  const closeThrough = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 0));
  const closable = await db.accountingPeriod.findMany({
    where: { organizationId: org.id, endDate: { lte: closeThrough }, status: 'OPEN' },
    orderBy: [{ fiscalYear: 'asc' }, { periodNumber: 'asc' }],
  });
  for (const period of closable) {
    await closePeriod(db, ctx, period.id);
  }
  // Reported from the last period actually closed. The cutoff date falls on the first of
  // a month and a period ends at midnight on its last day, so naming the cutoff claimed a
  // month that is in fact still open — which is the month a presenter is about to close.
  const lastClosed = closable[closable.length - 1];
  log(
    `Periods: ${closable.length} closed` +
      (lastClosed
        ? ` through ${lastClosed.fiscalYear}-${String(lastClosed.periodNumber).padStart(2, '0')}`
        : ''),
  );

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

/** How long a quote stays good for, matching the engine's default validity window. */
const QUOTE_VALID_DAYS = 30;

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
  /**
   * Where this job stops. Undefined means it runs all the way through to an invoice;
   * anything else leaves it sitting at that status, which is what gives the dispatch
   * board and a technician's phone something to actually look at.
   */
  stopAt?: 'SCHEDULED' | 'DISPATCHED' | 'EN_ROUTE' | 'IN_PROGRESS';
  /**
   * Worked and costed, but never invoiced — the finished job somebody forgot to bill.
   * Every shop has a tail of these and it is the most actionable number on the
   * dashboard, so the demo company has one rather than a suspiciously perfect zero.
   */
  leaveUnbilled?: boolean;
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
    // Quoted first, booked after. A pipeline where every quote was raised at the instant
    // the seed ran has no ageing in it, and ageing is the only thing a pipeline report is
    // really for — the oldest unanswered quote is the one somebody should be ringing.
    const quotedAt = new Date(
      Math.min(workDate.getTime() - rng.int(3, 24) * 86_400_000, Date.now()),
    );

    const quote = await createQuote(db, ctx, {
      locationId: input.locationId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      title: chosen.length > 1 ? `${task.name} + ${chosen.length - 1} more` : task.name,
      presentedByTechnicianId: tech.technicianId,
      lines: lines.map((l) => ({ priceBookItemId: l.priceBookItemId, quantity: l.quantity })),
      createdAt: quotedAt,
    });
    await sendQuote(db, ctx, quote.id, { at: quotedAt });

    /*
     * A close rate a shop would recognize.
     *
     * The ones that did not close do not sit in the pipeline for ever. A quote is good for
     * thirty days; past that the customer has decided, whether or not they said so, and a
     * pipeline still showing last spring's quotes as live is a pipeline nobody trusts. So
     * an old one is written off and only the recent ones stay open — which is also what
     * makes the close rate a real fraction rather than a number that only falls.
     */
    if (!rng.bool(0.62)) {
      const ageDays = (Date.now() - quotedAt.getTime()) / 86_400_000;
      if (ageDays > QUOTE_VALID_DAYS) {
        await declineQuote(
          db,
          ctx,
          quote.id,
          rng.pick([
            'Went with another contractor',
            'Customer decided to leave it',
            'No answer after three attempts',
            'Out of budget this year',
          ]),
          { at: new Date(quotedAt.getTime() + QUOTE_VALID_DAYS * 86_400_000) },
        );
      }
      return { jobId: quote.id, completed: false };
    }

    // Signed somewhere between the quote and the work, which is when it actually is.
    await approveQuote(db, ctx, quote.id, {
      signerName: 'Customer signature',
      signatureStorageKey: `demo/signatures/${quote.id}.png`,
      ipAddress: '198.51.100.24',
      deviceInfo: 'iPad (field)',
      approvedAt: new Date(quotedAt.getTime() + (workDate.getTime() - quotedAt.getTime()) / 2),
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

  // ------------------------------------------------- how far this job has got
  // Every transition is stamped with when it happened on this job's day, not with when
  // the seed ran. Otherwise a year of history all completes at the same instant, and
  // anything that reads completedAt — ageing, a monthly scorecard — reads a lie.
  const at = (minutes: number) => new Date(workDate.getTime() + minutes * 60_000);

  if (input.stopAt) {
    if (input.stopAt !== 'SCHEDULED') {
      await transitionJob(db, ctx, jobId, 'DISPATCHED', { occurredAt: at(-45) });
    }
    if (input.stopAt === 'EN_ROUTE' || input.stopAt === 'IN_PROGRESS') {
      await transitionJob(db, ctx, jobId, 'EN_ROUTE', { occurredAt: at(-20) });
    }
    if (input.stopAt === 'IN_PROGRESS') {
      await transitionJob(db, ctx, jobId, 'IN_PROGRESS', { occurredAt: at(5) });
    }
    return { jobId, completed: false };
  }

  await transitionJob(db, ctx, jobId, 'DISPATCHED', { occurredAt: at(-45) });
  await transitionJob(db, ctx, jobId, 'IN_PROGRESS', { occurredAt: at(0) });

  // ------------------------------------------------- actual cost
  const quotedHours = chosen.reduce((t, c) => t + Number(c.estimatedHours ?? '2'), 0);
  const actualHours = rng.normal(quotedHours, quotedHours * 0.22, 0.5, quotedHours * 2).toFixed(2);

  await transitionJob(db, ctx, jobId, 'COMPLETED', {
    occurredAt: at(Math.round(Number(actualHours) * 60)),
  });

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
  if (input.leaveUnbilled) {
    /*
     * Some of the work nobody invoiced was paid for anyway.
     *
     * The technician was standing there and asked, so the money is in the bank while the
     * paperwork is still nowhere. It sits as a deposit against the job — a liability,
     * because the work has not been billed — and it is the most uncomfortable figure on
     * the receivables screen: cash the company is holding for work it has not charged for.
     */
    if (rng.bool(0.38)) {
      const worked = await db.jobLine.aggregate({
        where: { jobId },
        _sum: { totalCents: true },
      });
      const takenCents = worked._sum.totalCents ?? 0n;
      if (takenCents > 0n) {
        await recordPayment(db, ctx, {
          customerId: input.customerId,
          locationId: input.locationId,
          jobId,
          collectedByTechnicianId: tech.technicianId,
          method: rng.weighted([['CHECK', 52], ['CASH', 48]] as const),
          amountCents: takenCents,
          receivedAt: workDate,
          isDeposit: true,
        });
      }
    }
    return { jobId, completed: true, hours: Number(actualHours) };
  }

  const invoice = await createInvoiceFromJob(db, ctx, { jobId, issueDate: workDate });
  await issueInvoice(db, ctx, invoice.id);

  /*
   * Most residential work is paid on the spot; commercial terms mean some is still open.
   *
   * The rest is chased, because a real company chases. A fixed share left unpaid for ever
   * looks reasonable on one month and absurd on twelve: it accumulates into hundreds of
   * invoices over ninety days old and a receivables screen saying this company has never
   * collected anything, which is the opposite of what an ageing report is there to show.
   * So an invoice that is not settled quickly is settled slowly, and only a small tail —
   * the genuinely delinquent — is still open when it is old.
   */
  const paidImmediately = rng.bool(0.72);
  const paidLater = !paidImmediately && rng.bool(0.6);
  const chasedAndPaid = !paidImmediately && !paidLater && rng.bool(0.82);

  if (paidImmediately || paidLater || chasedAndPaid) {
    const paidAt = paidImmediately
      ? workDate
      : new Date(
          workDate.getTime() +
            (paidLater ? rng.int(8, 52) : rng.int(55, 115)) * 86_400_000,
        );

    if (paidAt <= new Date()) {
      /*
       * Who took the money decides how it was taken. Nobody pays by bank transfer on a
       * doorstep, and nobody hands cash to the office three weeks later.
       */
      const onSite = paidImmediately && rng.bool(0.55);
      const method = onSite
        ? rng.weighted([
            ['CARD', 44],
            ['CHECK', 34],
            ['CASH', 22],
          ] as const)
        : rng.weighted([
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
        ...(onSite ? { jobId, collectedByTechnicianId: tech.technicianId } : {}),
        ...(method === 'CARD'
          ? { cardLast4: String(rng.int(1000, 9999)), cardBrand: rng.pick(['visa', 'mastercard', 'amex']) }
          : {}),
      });
    }
  }

  /*
   * Sometimes money goes back.
   *
   * A part came back, a price was argued down, a callback earned somebody a discount they
   * were never going to be talked out of. Every shop issues a few, and a demo with none
   * has an implausibly tidy revenue line — and nothing at all on the screen that handles
   * the awkward half of billing.
   */
  if (rng.bool(0.018)) {
    const creditedAt = new Date(
      Math.min(workDate.getTime() + rng.int(3, 21) * 86_400_000, Date.now()),
    );
    if (creditedAt > workDate) {
      await issueCreditMemo(db, ctx, {
        invoiceId: invoice.id,
        amountCents: (invoice.totalCents * BigInt(rng.int(12, 40))) / 100n,
        reason: rng.pick([
          'Goodwill after a return visit',
          'Part returned unused',
          'Price agreed down after the visit',
          'Billed for an hour the technician did not work',
        ]),
        issuedAt: creditedAt,
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
  //
  // Through the same paying-in slip the office uses, rather than a journal entry that
  // moves the balance and leaves the payments looking unbanked. A demo whose Undeposited
  // Funds account is empty while every cheque in it says it is still in the drawer is a
  // demo that falls apart on the first click.
  //
  // What came in over the last few days is still in a van or a drawer: somebody has to
  // carry it, and they have not been yet. That lag is the demo's opening state on this
  // screen, and it is the state every shop is actually in.
  await bankTakings(db, ctx, {
    depositedAt: entryDate,
    receivedThrough: new Date(entryDate.getTime() - 4 * 86_400_000),
  });

  const clearing = await accountBalance(db, ctx.organizationId, ACCOUNTS.CARD_CLEARING, entryDate);
  if (clearing > 0n) {
    // The processor holds a few days' takings back, so the sweep is not quite complete —
    // which is exactly the sort of timing difference a bank reconciliation exists for.
    //
    // The holdback compounds down in a quiet month: six percent of six percent, and so on,
    // until what is left is pennies and 94% of it rounds to nothing. A processor does not
    // sit on a penny for ever, so once the holdback rounds away the residue goes over
    // whole — which also keeps the ledger from being asked to post a zero.
    const holdback = (clearing * 94n) / 100n;
    const settled = holdback > 0n ? holdback : clearing;
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

  /*
   * A month that has not finished yet has not paid a full month's wages. Charging 173
   * hours against nineteen days of work would report the current month as heavily
   * unprofitable for no reason other than the calendar — and the current month is the one
   * an owner looks at first.
   */
  const daysInMonth = monthEnd.getUTCDate();
  const daysElapsed = monthEnd > input.today ? input.today.getUTCDate() : daysInMonth;
  const paidHours = (PAID_HOURS_PER_MONTH * daysElapsed) / daysInMonth;

  const lines: Parameters<typeof postJournalEntry>[2]['lines'] = [];
  let total = 0n;

  for (const tech of input.techs) {
    const billed = input.billableHours.get(tech.technicianId) ?? 0;
    const unbilled = paidHours - billed;
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

interface CurrentWeekInput {
  rng: Rng;
  today: Date;
  backDays: number;
  forwardDays: number;
  /** Jobs per technician per working day. Derived from company volume, not guessed. */
  perTechPerDay: number;
  techs: SeededTech[];
  customers: { id: string; propertyId: string; locationCode: string; priceTier: string | null }[];
  locationByCode: Map<string, string>;
  serviceTypeByCode: Map<string, string>;
  itemBySku: Map<string, string>;
  vendorIds: { supply: string[]; sub: string[] };
}

interface CurrentWeekResult {
  created: number;
  todayCount: number;
  inFlightCount: number;
  billableHours: Map<string, number>;
  completedJobs: {
    jobId: string;
    techId: string;
    date: Date;
    serviceCode: ServiceCode;
    locationCode: string;
  }[];
}

/** The working day, in the order a technician drives it. */
const DAY_SLOTS = [
  { hour: 8, minute: 0 },
  { hour: 10, minute: 30 },
  { hour: 13, minute: 0 },
  { hour: 15, minute: 30 },
];

const SLOT_LENGTH_MS = 2.5 * 60 * 60 * 1000;

/**
 * The days either side of now, laid out deliberately.
 *
 * Left to the random month generator, "today" gets whatever jobs happen to land on it,
 * which is frequently none — and a demo that opens on a technician with an empty morning
 * is over before it starts. More than that, a dispatch board is only worth looking at when
 * it shows a day in progress: some calls finished, one technician mid-job, the afternoon
 * still ahead, and the rest of the week filling up behind it.
 *
 * Status follows the clock. A slot that finished before now is completed and invoiced; the
 * slot containing now is under way; the next one is on its way; the rest are dispatched or
 * scheduled. Run at nine in the morning or four in the afternoon, the board looks right
 * either way.
 */
async function scheduleCurrentWeek(
  db: PrismaClient,
  ctx: AuthContext,
  input: CurrentWeekInput,
): Promise<CurrentWeekResult> {
  const { rng, today } = input;

  /*
   * How far the working day has got.
   *
   * Scheduled times are real — an eight o'clock job is at eight o'clock. But a demo run at
   * six in the morning, or at ten at night, would show a board with nothing under way and
   * every call still ahead, which is accurate and useless: the thing worth looking at is a
   * day in progress. Outside working hours the *status* question is answered as if it were
   * mid-morning, so a salesperson gets a live-looking board whenever they run the seed.
   */
  const WORKING_DAY_START = 8;
  const WORKING_DAY_END = 17;
  const DEMO_HOUR = 11;

  const hour = today.getUTCHours();
  const withinWorkingHours = hour >= WORKING_DAY_START && hour < WORKING_DAY_END;
  const now = withinWorkingHours
    ? today.getTime()
    : Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), DEMO_HOUR, 15);

  const specs: OneJobInput[] = [];
  let todayCount = 0;

  // Sunday is emergencies only, and a demo does not need them.
  const days: { date: Date; offset: number }[] = [];
  for (let offset = -input.backDays; offset <= input.forwardDays; offset++) {
    const date = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset),
    );
    if (date.getUTCDay() !== 0) days.push({ date, offset });
  }

  // The next day anyone actually works — which on a Saturday is Monday, not Sunday.
  const nextWorkingDay = days.find((d) => d.offset > 0)?.offset ?? null;

  for (const { date: day, offset } of days) {
    for (const tech of input.techs) {
      const count = Math.min(
        DAY_SLOTS.length,
        Math.max(1, input.perTechPerDay + rng.weighted([[-0, 55], [1, 30], [-1, 15]] as const)),
      );

      // Whoever is working, works the early slots; nobody starts their day at half three.
      const slots = DAY_SLOTS.slice(0, count);
      let inProgressUsed = false;

      for (const slot of slots) {
        const candidates = input.customers.filter((c) => c.locationCode === tech.locationCode);
        if (candidates.length === 0) continue;

        const customer = rng.pick(candidates);
        const serviceCode = rng.pick(tech.skills);
        const start = new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            slot.hour,
            slot.minute,
          ),
        );

        let stopAt: OneJobInput['stopAt'];

        if (offset < 0) {
          stopAt = undefined; // finished and invoiced
        } else if (offset === 0) {
          const slotEnd = start.getTime() + SLOT_LENGTH_MS;
          if (slotEnd <= now) {
            stopAt = undefined;
          } else if (start.getTime() <= now && !inProgressUsed) {
            stopAt = 'IN_PROGRESS';
            inProgressUsed = true;
          } else if (start.getTime() - now <= 90 * 60 * 1000) {
            stopAt = 'EN_ROUTE';
          } else {
            stopAt = 'DISPATCHED';
          }
          todayCount++;
        } else {
          // The next working day is already assigned to a technician; further out is only
          // booked in, because dispatch has not decided who is taking it yet.
          stopAt = offset === nextWorkingDay ? 'DISPATCHED' : 'SCHEDULED';
        }

        specs.push({
          rng: new Rng(rng.int(1, 2 ** 30)),
          workDate: start,
          tech,
          serviceCode,
          locationId: input.locationByCode.get(tech.locationCode)!,
          locationCode: tech.locationCode,
          customerId: customer.id,
          propertyId: customer.propertyId,
          itemBySku: input.itemBySku,
          serviceTypeId: input.serviceTypeByCode.get(serviceCode)!,
          stopAt,
          vendorIds: input.vendorIds,
        });
      }
    }
  }

  const results = await inBatches(specs, 8, (spec) => seedOneJob(db, ctx, spec));

  const billableHours = new Map<string, number>();
  const completedJobs: CurrentWeekResult['completedJobs'] = [];
  let created = 0;
  let inFlightCount = 0;

  for (const [index, outcome] of results.entries()) {
    if (!outcome) continue;
    const spec = specs[index];
    created++;

    if (spec.stopAt) inFlightCount++;
    if (outcome.hours) {
      billableHours.set(
        spec.tech.technicianId,
        (billableHours.get(spec.tech.technicianId) ?? 0) + outcome.hours,
      );
    }
    if (outcome.completed) {
      completedJobs.push({
        jobId: outcome.jobId,
        techId: spec.tech.technicianId,
        date: spec.workDate,
        serviceCode: spec.serviceCode,
        locationCode: spec.locationCode,
      });
    }
  }

  return { created, todayCount, inFlightCount, billableHours, completedJobs };
}

/** A van carries at least this much of anything it is sent, however rarely it is used. */
const VAN_PAR_FLOOR = 6;
/** Two months of what a technician actually gets through. */
const VAN_PAR_MONTHS = 2;

interface ResupplyInput {
  monthStart: Date;
  monthOffset: number;
  rng: Rng;
  warehouseByCode: Map<string, string>;
  techs: SeededTech[];
  stockLines: { sku: string; id: string }[];
}

/**
 * The monthly resupply: top every van back to par, and buy what the vans are about to take.
 *
 * Par is measured rather than guessed — two months of what this technician has actually
 * been getting through, read out of the consumption already posted. With no history yet it
 * falls back to a floor, which is the first month only.
 *
 * Each van's reorder point is set to about a month of its own burn at the same time, so
 * the level a truck works to is the level that truck needs. A van having a heavier month
 * than usual drops under it and shows up as something to restock, which is the point of
 * having the number at all.
 */
async function resupplyVans(
  db: PrismaClient,
  ctx: AuthContext,
  input: ResupplyInput,
): Promise<void> {
  const since = new Date(input.monthStart.getTime() - 60 * 86_400_000);

  for (const location of LOCATIONS) {
    const warehouse = input.warehouseByCode.get(location.code)!;
    const branchTechs = input.techs.filter((t) => t.locationCode === location.code);

    const vanOrders: { vanId: string; lines: { priceBookItemId: string; quantity: string }[] }[] = [];
    const needByItem = new Map<string, number>();

    for (const tech of branchTechs) {
      const [levels, burn] = await Promise.all([
        db.stockLevel.findMany({
          where: { stockLocationId: tech.vanStockLocationId },
          select: { priceBookItemId: true, quantity: true },
        }),
        db.inventoryTransaction.groupBy({
          by: ['priceBookItemId'],
          where: {
            organizationId: ctx.organizationId,
            kind: 'CONSUMPTION',
            fromStockLocationId: tech.vanStockLocationId,
            occurredAt: { gte: since, lt: input.monthStart },
          },
          _sum: { quantity: true },
        }),
      ]);

      const onHand = new Map(levels.map((l) => [l.priceBookItemId, Number(l.quantity)]));
      const perMonth = new Map(
        burn.map((row) => [row.priceBookItemId, Number(row._sum.quantity ?? 0) / 2]),
      );

      const lines: { priceBookItemId: string; quantity: string }[] = [];
      for (const part of input.stockLines) {
        const monthly = perMonth.get(part.id) ?? 0;
        const par = Math.max(VAN_PAR_FLOOR, Math.ceil(monthly * VAN_PAR_MONTHS));
        const need = par - (onHand.get(part.id) ?? 0);

        // The level this truck works to, which is its own and not the warehouse's.
        const point = Math.max(3, Math.ceil(monthly));
        await db.stockLevel.updateMany({
          where: { stockLocationId: tech.vanStockLocationId, priceBookItemId: part.id },
          data: { reorderPoint: String(point), reorderQty: String(par - point) },
        });

        if (need <= 0) continue;
        lines.push({ priceBookItemId: part.id, quantity: String(need) });
        needByItem.set(part.id, (needByItem.get(part.id) ?? 0) + need);
      }

      if (lines.length > 0) vanOrders.push({ vanId: tech.vanStockLocationId, lines });
    }

    // What the warehouse has to buy: what the vans are about to take, less what is already
    // on the shelf, plus a little to sit on.
    const shelfLevels = await db.stockLevel.findMany({
      where: { stockLocationId: warehouse },
      select: { priceBookItemId: true, quantity: true },
    });
    const shelf = new Map(shelfLevels.map((l) => [l.priceBookItemId, Number(l.quantity)]));

    const receiptLines = input.stockLines
      .map((part) => {
        const order =
          (needByItem.get(part.id) ?? 0) + input.rng.int(8, 20) - (shelf.get(part.id) ?? 0);
        return { part, order: Math.ceil(order) };
      })
      .filter((row) => row.order > 0)
      .map((row) => {
        const seed = PART_ITEMS.find((p) => p.sku === row.part.sku)!;
        // Supplier prices drift; that is what makes a moving average worth having.
        const drift = 1 + input.rng.float(-0.04, 0.09) + input.monthOffset * 0.004;
        return {
          priceBookItemId: row.part.id,
          quantity: String(row.order),
          unitCostCents: BigInt(Math.round(Number(seed.costCents) * drift)),
        };
      });

    const stamp = input.monthStart.toISOString().slice(0, 7);
    if (receiptLines.length > 0) {
      await receiveStock(db, ctx, {
        stockLocationId: warehouse,
        occurredAt: input.monthStart,
        reference: `PO-${location.code}-${stamp}`,
        lines: receiptLines,
      });
    }

    for (const order of vanOrders) {
      await transferStock(db, ctx, {
        fromStockLocationId: warehouse,
        toStockLocationId: order.vanId,
        occurredAt: new Date(input.monthStart.getTime() + 3 * 3600 * 1000),
        reference: `Van resupply ${stamp}`,
        lines: order.lines,
      });
    }
  }
}
