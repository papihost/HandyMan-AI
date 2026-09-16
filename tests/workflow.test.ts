import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { systemContext, type AuthContext } from '../src/lib/auth/context';
import { scopedDb } from '../src/lib/auth/scoped-db';
import { ACCOUNTS } from '../src/lib/accounting/chart-of-accounts';
import { postJournalEntry } from '../src/lib/accounting/ledger';
import { laborCostedLines } from '../src/lib/accounting/rules/labor';
import { partsConsumedLines } from '../src/lib/accounting/rules/inventory';
import { profitByLocation, trialBalance } from '../src/lib/accounting/reports';
import { createCustomer, findDuplicates } from '../src/lib/customers/service';
import { jobCosting } from '../src/lib/jobs/costing';
import { addJobLine, canTransition, transitionJob } from '../src/lib/jobs/service';
import { approveQuote, convertQuoteToJob, createQuote, sendQuote } from '../src/lib/quotes/service';
import { agingReport, createInvoiceFromJob, issueInvoice, recordPayment } from '../src/lib/invoices/service';
import {
  createPriceBookItem,
  createTaxJurisdiction,
  createTestOrg,
  createTestTechnician,
  createTestUser,
  setPropertyJurisdiction,
  type TestOrg,
} from './factory';

/**
 * The demo story, executed as a test: a quote presented in the field becomes a job, the
 * job becomes an invoice, the invoice posts itself to the general ledger, and the margin
 * on that job is readable straight off the same journal lines the P&L is built from.
 *
 * If this passes, the claim the product is sold on is literally true.
 */

let org: TestOrg;
let ctx: AuthContext;
let laborItemId: string;
let partItemId: string;
let tripFeeId: string;
let jurisdictionId: string;

beforeAll(async () => {
  org = await createTestOrg('Workflow');
  ctx = systemContext(org.organizationId);
  jurisdictionId = await createTaxJurisdiction(org.organizationId);

  laborItemId = await createPriceBookItem(org.organizationId, {
    name: 'Handyman labor — standard',
    category: 'LABOR',
    kind: 'LABOR',
    costCents: 4056n, // loaded hourly cost
    priceCents: 12500n,
  });
  partItemId = await createPriceBookItem(org.organizationId, {
    name: 'Wax ring kit',
    category: 'MATERIAL',
    costCents: 420n,
    priceCents: 1800n,
  });
  tripFeeId = await createPriceBookItem(org.organizationId, {
    name: 'Trip charge',
    category: 'FEE',
    kind: 'FEE',
    costCents: 0n,
    priceCents: 8900n,
  });
});

afterAll(async () => {
  await db.$disconnect();
});

async function newCustomerWithProperty(lastName = 'Alvarez') {
  const customer = await createCustomer(db, ctx, {
    firstName: 'Dana',
    lastName,
    email: `dana.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`,
    phone: '(480) 555-0142',
    property: {
      addressLine1: '1420 E Broadway Rd',
      city: 'Mesa',
      state: 'AZ',
      postalCode: '85204',
    },
  });

  const property = customer.properties[0];
  await setPropertyJurisdiction(property.id, jurisdictionId);
  return { customer, propertyId: property.id };
}

describe('customers', () => {
  it('creates a customer with a service address and a generated number', async () => {
    const { customer } = await newCustomerWithProperty();

    expect(customer.customerNo).toMatch(/^C-\d{5}$/);
    expect(customer.properties).toHaveLength(1);
    expect(customer.properties[0].city).toBe('Mesa');
  });

  it('flags a likely duplicate before a second record is created', async () => {
    const { customer } = await newCustomerWithProperty('Nakamura');

    const matches = await findDuplicates(db, ctx, {
      email: customer.email!,
      lastName: 'Nakamura',
      postalCode: '85204',
    });

    expect(matches[0].customerId).toBe(customer.id);
    expect(matches[0].score).toBeGreaterThanOrEqual(80);
    expect(matches[0].reasons).toContain('same email');
  });

  it('matches a phone number written in a different format', async () => {
    await newCustomerWithProperty('Okafor');
    const matches = await findDuplicates(db, ctx, { phone: '+1-480-555-0142' });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].reasons).toContain('same phone');
  });

  it('refuses a customer with no name at all', async () => {
    await expect(createCustomer(db, ctx, { email: 'x@example.com' })).rejects.toThrow(
      /company name or a last name/,
    );
  });
});

describe('quote to job', () => {
  it('prices a three-option quote from the price book and taxes by service address', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();

    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      title: 'Replace toilet',
      options: [
        {
          name: 'Good',
          lines: [
            { priceBookItemId: laborItemId, quantity: '2' },
            { priceBookItemId: partItemId, quantity: '1' },
          ],
        },
        {
          name: 'Better',
          isRecommended: true,
          lines: [
            { priceBookItemId: laborItemId, quantity: '2.5' },
            { priceBookItemId: partItemId, quantity: '2' },
            { priceBookItemId: tripFeeId, quantity: '1' },
          ],
        },
      ],
    });

    expect(quote.quoteNo).toMatch(/^Q-MES-\d{5}$/);
    expect(quote.options).toHaveLength(2);

    // Headline figures follow the recommended option until the customer chooses.
    const better = quote.options.find((o) => o.name === 'Better')!;
    expect(quote.totalCents).toBe(better.totalCents);

    // Better: 2.5 x 125.00 + 2 x 18.00 + 89.00 trip = 437.50 taxable + 89.00 untaxed fee.
    // Tax at 8.3% on 348.50 = 28.93.
    expect(quote.subtotalCents).toBe(43750n);
    expect(quote.taxCents).toBe(2893n);
    expect(quote.totalCents).toBe(46643n);
  });

  it('carries cost onto the quote for margin, and hides it from a technician', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const tech = await createTestUser(org.organizationId, {
      roleKey: 'TECHNICIAN',
      locationIds: [org.locationId],
    });

    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '2' }],
    });

    expect(quote.estimatedCostCents).toBe(8112n); // 2 x 40.56

    const asTech = await scopedDb(db, tech.ctx).quote.findFirst({ where: { id: quote.id } });
    expect('estimatedCostCents' in asTech!).toBe(false);
    expect(asTech!.totalCents).toBe(quote.totalCents);

    const techLines = await scopedDb(db, tech.ctx).quoteLine.findMany({ where: { quoteId: quote.id } });
    expect('unitCostCents' in techLines[0]).toBe(false);
  });

  it('records the signature on approval and converts to a job with the chosen lines', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();

    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      options: [
        { name: 'Good', lines: [{ priceBookItemId: laborItemId, quantity: '1' }] },
        {
          name: 'Best',
          lines: [
            { priceBookItemId: laborItemId, quantity: '4' },
            { priceBookItemId: partItemId, quantity: '3' },
          ],
        },
      ],
    });

    await sendQuote(db, ctx, quote.id);
    const best = quote.options.find((o) => o.name === 'Best')!;

    const approved = await approveQuote(db, ctx, quote.id, {
      quoteOptionId: best.id,
      signerName: 'Dana Alvarez',
      signatureStorageKey: 'signatures/abc.png',
      ipAddress: '203.0.113.7',
    });

    expect(approved.status).toBe('APPROVED');
    expect(approved.totalCents).toBe(best.totalCents);
    expect(approved.signatureId).not.toBeNull();

    const signature = await db.signature.findUniqueOrThrow({ where: { id: approved.signatureId! } });
    expect(signature.signerName).toBe('Dana Alvarez');
    expect(signature.kind).toBe('QUOTE_APPROVAL');

    const job = await convertQuoteToJob(db, ctx, quote.id);
    expect(job.jobNo).toMatch(/^J-MES-\d{5}$/);
    expect(job.lines).toHaveLength(2);
    expect(job.sourceQuoteId).toBe(quote.id);

    const reloaded = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(reloaded.status).toBe('CONVERTED');
  });

  it('refuses to convert a quote twice', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '1' }],
    });
    await approveQuote(db, ctx, quote.id, {
      signerName: 'Dana',
      signatureStorageKey: 'sig.png',
    });
    await convertQuoteToJob(db, ctx, quote.id);

    await expect(convertQuoteToJob(db, ctx, quote.id)).rejects.toThrow(/already been converted/);
  });

  it('refuses to convert a quote that was never approved', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '1' }],
    });

    await expect(convertQuoteToJob(db, ctx, quote.id)).rejects.toThrow(/only an approved quote/);
  });

  it('refuses to approve an expired quote', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '1' }],
    });
    await db.quote.update({
      where: { id: quote.id },
      data: { validUntil: new Date(Date.now() - 86_400_000) },
    });

    await expect(
      approveQuote(db, ctx, quote.id, { signerName: 'Dana', signatureStorageKey: 'sig.png' }),
    ).rejects.toThrow(/expired/);
  });
});

describe('job lifecycle', () => {
  it('permits the real transitions and refuses the impossible ones', () => {
    expect(canTransition('SCHEDULED', 'DISPATCHED')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
    // A multi-visit job goes back to the field rather than being finished at visit one.
    expect(canTransition('ON_HOLD', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('COMPLETED', 'IN_PROGRESS')).toBe(true);

    expect(canTransition('DRAFT', 'PAID')).toBe(false);
    expect(canTransition('CLOSED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('CANCELLED', 'SCHEDULED')).toBe(false);
  });

  it('rejects a transition the lifecycle does not allow', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '1' }],
    });
    await approveQuote(db, ctx, quote.id, { signerName: 'D', signatureStorageKey: 's.png' });
    const job = await convertQuoteToJob(db, ctx, quote.id);

    await expect(transitionJob(db, ctx, job.id, 'PAID')).rejects.toThrow(/cannot move from DRAFT/);
  });
});

describe('the full path: field work to financial statements', () => {
  it('invoices a completed job, posts it, and the margin traces to the ledger', async () => {
    const storyOrg = await createTestOrg('Story');
    const storyCtx = systemContext(storyOrg.organizationId);
    const jurisdiction = await createTaxJurisdiction(storyOrg.organizationId);
    const tech = await createTestTechnician(storyOrg.organizationId, storyOrg.locationId);

    const labor = await createPriceBookItem(storyOrg.organizationId, {
      name: 'Handyman labor',
      category: 'LABOR',
      kind: 'LABOR',
      costCents: 4056n,
      priceCents: 12500n,
    });
    const part = await createPriceBookItem(storyOrg.organizationId, {
      name: 'Wax ring kit',
      category: 'MATERIAL',
      costCents: 420n,
      priceCents: 1800n,
    });

    const customer = await createCustomer(db, storyCtx, {
      lastName: 'Whitfield',
      property: {
        addressLine1: '88 W Main St',
        city: 'Mesa',
        state: 'AZ',
        postalCode: '85201',
      },
    });
    const propertyId = customer.properties[0].id;
    await setPropertyJurisdiction(propertyId, jurisdiction);

    // --- Quote, approved in the field -------------------------------------
    const quote = await createQuote(db, storyCtx, {
      locationId: storyOrg.locationId,
      customerId: customer.id,
      propertyId,
      title: 'Replace toilet',
      lines: [
        { priceBookItemId: labor, quantity: '2.5' },
        { priceBookItemId: part, quantity: '2' },
      ],
    });
    await approveQuote(db, storyCtx, quote.id, {
      signerName: 'R. Whitfield',
      signatureStorageKey: 'signatures/story.png',
    });

    // --- The job ----------------------------------------------------------
    const job = await convertQuoteToJob(db, storyCtx, quote.id, {
      scheduledStart: new Date(Date.UTC(2026, 1, 10, 15, 0)),
    });
    await transitionJob(db, storyCtx, job.id, 'DISPATCHED');
    await transitionJob(db, storyCtx, job.id, 'IN_PROGRESS');

    // Extra part used on site, added by the technician.
    await addJobLine(db, storyCtx, job.id, { priceBookItemId: part, quantity: '1' });
    await transitionJob(db, storyCtx, job.id, 'COMPLETED');

    // --- Actual costs post as the work happens ----------------------------
    const workDate = new Date(Date.UTC(2026, 1, 10, 18, 0));
    await postJournalEntry(db, storyCtx, {
      entryDate: workDate,
      source: 'PAYROLL',
      sourceType: 'TimeEntry',
      lines: laborCostedLines({
        jobId: job.id,
        locationId: storyOrg.locationId,
        technicianId: tech.technicianId,
        hours: '2.5',
        baseHourlyCents: 2800n,
        loadedHourlyCents: 4056n,
      }),
    });
    await postJournalEntry(db, storyCtx, {
      entryDate: workDate,
      source: 'INVENTORY',
      sourceType: 'InventoryTransaction',
      lines: partsConsumedLines({
        jobId: job.id,
        locationId: storyOrg.locationId,
        technicianId: tech.technicianId,
        fromStockKind: 'VAN',
        totalCostCents: 1260n, // 3 x 4.20
      }),
    });

    // --- Invoice ----------------------------------------------------------
    const draft = await createInvoiceFromJob(db, storyCtx, {
      jobId: job.id,
      issueDate: workDate,
    });

    // 2.5 x 125.00 + 3 x 18.00 = 366.50; tax at 8.3% = 30.42.
    expect(draft.subtotalCents).toBe(36650n);
    expect(draft.taxCents).toBe(3042n);
    expect(draft.totalCents).toBe(39692n);
    expect(draft.status).toBe('DRAFT');
    expect(draft.lines).toHaveLength(3);

    const issued = await issueInvoice(db, storyCtx, draft.id);
    expect(issued.invoice.status).toBe('OPEN');
    expect(issued.invoice.balanceCents).toBe(39692n);

    const jobAfterInvoice = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfterInvoice.status).toBe('INVOICED');

    // Every job line is billed exactly once.
    const jobLines = await db.jobLine.findMany({ where: { jobId: job.id } });
    expect(jobLines.every((l) => l.isBilled)).toBe(true);
    await expect(createInvoiceFromJob(db, storyCtx, { jobId: job.id })).rejects.toThrow(
      /no unbilled lines/,
    );

    // --- The posting the invoice produced ---------------------------------
    const entry = await db.journalEntry.findUniqueOrThrow({
      where: { id: issued.journalEntryId },
      include: { lines: { include: { account: true } } },
    });
    expect(entry.sourceType).toBe('Invoice');
    expect(entry.sourceId).toBe(draft.id);

    const amount = (code: string, side: 'debitCents' | 'creditCents') =>
      entry.lines.filter((l) => l.account.code === code).reduce((t, l) => t + l[side], 0n);

    expect(amount(ACCOUNTS.AR, 'debitCents')).toBe(39692n);
    expect(amount(ACCOUNTS.REVENUE_LABOR, 'creditCents')).toBe(31250n);
    expect(amount(ACCOUNTS.REVENUE_MATERIALS, 'creditCents')).toBe(5400n);
    expect(amount(ACCOUNTS.SALES_TAX_PAYABLE, 'creditCents')).toBe(3042n);
    // Every line is tagged with the job, which is what makes costing a query.
    expect(entry.lines.every((l) => l.jobId === job.id)).toBe(true);

    // --- Payment ----------------------------------------------------------
    const payment = await recordPayment(db, storyCtx, {
      customerId: customer.id,
      locationId: storyOrg.locationId,
      method: 'CARD',
      amountCents: 39692n,
      feeCents: 1151n,
      receivedAt: workDate,
      cardLast4: '4242',
      cardBrand: 'visa',
    });

    expect(payment.unappliedCents).toBe(0n);
    const paidInvoice = await db.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(paidInvoice.status).toBe('PAID');
    expect(paidInvoice.balanceCents).toBe(0n);

    const jobAfterPayment = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfterPayment.status).toBe('PAID');

    // --- Job costing, read from the ledger --------------------------------
    const costing = await jobCosting(db, storyCtx, job.id);

    expect(costing.revenueCents).toBe(36650n); // net of tax; tax is never revenue
    expect(costing.laborCents).toBe(7000n); // 2.5 x 28.00 wage
    expect(costing.burdenCents).toBe(3140n); // 2.5 x 12.56 burden
    expect(costing.materialCents).toBe(1260n);
    expect(costing.totalCostCents).toBe(11400n);
    expect(costing.grossMarginCents).toBe(25250n);
    expect(costing.grossMarginPercent).toBeCloseTo(68.89, 1);

    // The job's cached roll-up agrees with the ledger it was derived from.
    const rolled = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(rolled.revenueCents).toBe(costing.revenueCents);
    expect(rolled.laborCostCents).toBe(costing.laborCents + costing.burdenCents);
    expect(rolled.materialCostCents).toBe(costing.materialCents);

    // --- And it ties out to the financial statements ----------------------
    const from = new Date(Date.UTC(2026, 1, 1));
    const to = new Date(Date.UTC(2026, 1, 28));

    const tb = await trialBalance(db, storyCtx, { from, to });
    expect(tb.isBalanced).toBe(true);

    const byLocation = await profitByLocation(db, storyCtx, { from, to });
    const mesa = byLocation.find((r) => r.locationId === storyOrg.locationId)!;
    expect(mesa.revenueCents).toBe(costing.revenueCents);
    expect(mesa.grossProfitCents).toBe(costing.grossMarginCents);

    // Card money sits in clearing until the processor pays out; it is not in the bank yet.
    const clearing = tb.rows.find((r) => r.code === ACCOUNTS.CARD_CLEARING)!;
    expect(clearing.balanceCents).toBe(38541n); // 396.92 less the 11.51 fee
    expect(tb.rows.find((r) => r.code === ACCOUNTS.BANK_OPERATING)).toBeUndefined();
  });

  it('holds a deposit as a liability and relieves it when the invoice is issued', async () => {
    const depositOrg = await createTestOrg('Deposit');
    const depositCtx = systemContext(depositOrg.organizationId);
    const item = await createPriceBookItem(depositOrg.organizationId, {
      name: 'Deck repair',
      category: 'LABOR',
      kind: 'FLAT_RATE',
      costCents: 40000n,
      priceCents: 120000n,
    });

    const customer = await createCustomer(db, depositCtx, {
      lastName: 'Brandt',
      property: { addressLine1: '5 Oak Ln', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });
    const propertyId = customer.properties[0].id;

    const asOf = new Date(Date.UTC(2026, 2, 3));

    // Money up front, before any work is earned.
    await recordPayment(db, depositCtx, {
      customerId: customer.id,
      locationId: depositOrg.locationId,
      method: 'CHECK',
      amountCents: 60000n,
      isDeposit: true,
      receivedAt: asOf,
    });

    let tb = await trialBalance(db, depositCtx, { to: asOf });
    const deposits = tb.rows.find((r) => r.code === ACCOUNTS.CUSTOMER_DEPOSITS)!;
    expect(deposits.balanceCents).toBe(60000n);
    // Critically: not revenue.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.REVENUE_LABOR)).toBeUndefined();

    const quote = await createQuote(db, depositCtx, {
      locationId: depositOrg.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: item, quantity: '1' }],
    });
    await approveQuote(db, depositCtx, quote.id, {
      signerName: 'K. Brandt',
      signatureStorageKey: 'sig.png',
    });
    const job = await convertQuoteToJob(db, depositCtx, quote.id);
    await transitionJob(db, depositCtx, job.id, 'SCHEDULED');
    await transitionJob(db, depositCtx, job.id, 'IN_PROGRESS');
    await transitionJob(db, depositCtx, job.id, 'COMPLETED');

    const draft = await createInvoiceFromJob(db, depositCtx, { jobId: job.id, issueDate: asOf });
    const issued = await issueInvoice(db, depositCtx, draft.id, { applyDepositCents: 60000n });

    expect(issued.invoice.depositAppliedCents).toBe(60000n);
    expect(issued.invoice.balanceCents).toBe(60000n);

    tb = await trialBalance(db, depositCtx, { to: asOf });
    // The liability is discharged, and now it is revenue.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.CUSTOMER_DEPOSITS)!.balanceCents).toBe(0n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.REVENUE_LABOR)!.balanceCents).toBe(120000n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(60000n);
    expect(tb.isBalanced).toBe(true);
  });

  it('refuses to apply more deposit than the customer has on account', async () => {
    const shortOrg = await createTestOrg('ShortDeposit');
    const shortCtx = systemContext(shortOrg.organizationId);
    const item = await createPriceBookItem(shortOrg.organizationId, {
      name: 'Fence repair',
      category: 'LABOR',
      costCents: 1000n,
      priceCents: 50000n,
    });
    const customer = await createCustomer(db, shortCtx, {
      lastName: 'Ferreira',
      property: { addressLine1: '9 Elm', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });

    const quote = await createQuote(db, shortCtx, {
      locationId: shortOrg.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ priceBookItemId: item, quantity: '1' }],
    });
    await approveQuote(db, shortCtx, quote.id, { signerName: 'F', signatureStorageKey: 's.png' });
    const job = await convertQuoteToJob(db, shortCtx, quote.id);
    await transitionJob(db, shortCtx, job.id, 'SCHEDULED');
    await transitionJob(db, shortCtx, job.id, 'IN_PROGRESS');
    await transitionJob(db, shortCtx, job.id, 'COMPLETED');

    const draft = await createInvoiceFromJob(db, shortCtx, { jobId: job.id });
    await expect(
      issueInvoice(db, shortCtx, draft.id, { applyDepositCents: 10000n }),
    ).rejects.toThrow(/unapplied/);
  });

  it('will not invoice warranty rework', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const warranty = await db.job.create({
      data: {
        organizationId: org.organizationId,
        locationId: org.locationId,
        jobNo: `J-WAR-${Date.now()}`,
        customerId: customer.id,
        propertyId,
        title: 'Callback — leak returned',
        isWarranty: true,
        isBillable: false,
        status: 'COMPLETED',
      },
    });

    await expect(createInvoiceFromJob(db, ctx, { jobId: warranty.id })).rejects.toThrow(
      /warranty rework/,
    );
  });

  it('will not issue the same invoice twice', async () => {
    const { customer, propertyId } = await newCustomerWithProperty();
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId,
      lines: [{ priceBookItemId: laborItemId, quantity: '1' }],
    });
    await approveQuote(db, ctx, quote.id, { signerName: 'D', signatureStorageKey: 's.png' });
    const job = await convertQuoteToJob(db, ctx, quote.id);
    await transitionJob(db, ctx, job.id, 'SCHEDULED');
    await transitionJob(db, ctx, job.id, 'IN_PROGRESS');
    await transitionJob(db, ctx, job.id, 'COMPLETED');

    const draft = await createInvoiceFromJob(db, ctx, { jobId: job.id });
    await issueInvoice(db, ctx, draft.id);
    await expect(issueInvoice(db, ctx, draft.id)).rejects.toThrow(/already been issued/);
  });
});

describe('receivables', () => {
  it('ages open balances into buckets', async () => {
    const agingOrg = await createTestOrg('Aging');
    const agingCtx = systemContext(agingOrg.organizationId);
    const item = await createPriceBookItem(agingOrg.organizationId, {
      name: 'Gutter cleaning',
      category: 'LABOR',
      costCents: 2000n,
      priceCents: 15000n,
    });
    const customer = await createCustomer(db, agingCtx, {
      lastName: 'Price',
      property: { addressLine1: '1 A St', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });

    const quote = await createQuote(db, agingCtx, {
      locationId: agingOrg.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ priceBookItemId: item, quantity: '1' }],
    });
    await approveQuote(db, agingCtx, quote.id, { signerName: 'P', signatureStorageKey: 's.png' });
    const job = await convertQuoteToJob(db, agingCtx, quote.id);
    await transitionJob(db, agingCtx, job.id, 'SCHEDULED');
    await transitionJob(db, agingCtx, job.id, 'IN_PROGRESS');
    await transitionJob(db, agingCtx, job.id, 'COMPLETED');

    const issueDate = new Date(Date.UTC(2026, 0, 15));
    const draft = await createInvoiceFromJob(db, agingCtx, { jobId: job.id, issueDate });
    await issueInvoice(db, agingCtx, draft.id);

    const aging = await agingReport(db, agingCtx, new Date(Date.UTC(2026, 1, 20)));
    expect(aging.totalCents).toBe(15000n);
    expect(aging.buckets.days60).toBe(15000n); // 36 days past a same-day due date
    expect(aging.buckets.current).toBe(0n);
  });
});
