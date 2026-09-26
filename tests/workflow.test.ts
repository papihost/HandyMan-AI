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
import {
  agingReport,
  billJob,
  billJobs,
  createInvoiceFromJob,
  issueInvoice,
  recordPayment,
} from '../src/lib/invoices/service';
import { bankTakings, undepositedPayments } from '../src/lib/invoices/banking';
import { issueCreditMemo, voidInvoice } from '../src/lib/invoices/credits';
import {
  deliveryState,
  hashShareToken,
  resolveShare,
  revokeShares,
  sendDocument,
} from '../src/lib/documents/delivery';
import {
  createPriceBookItem,
  createTaxJurisdiction,
  createTestJob,
  createTestOrg,
  createTestTechnician,
  createTestUser,
  setPropertyJurisdiction,
  utc,
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

    /*
     * And the tax can be shown as a working, not just as a total.
     *
     * Sales tax is the line a customer queries and an office guesses at, so the invoice
     * keeps the jurisdictions it was worked out from — each with the base it was applied
     * to and the rate it was applied at. They have to add up to what was charged and to
     * what was posted, or the breakdown on the invoice page would be a decoration over a
     * number arrived at some other way.
     */
    const taxLines = await db.invoiceTaxLine.findMany({
      where: { invoiceId: draft.id },
      include: { taxJurisdiction: { select: { name: true, level: true } } },
    });
    expect(taxLines.length).toBeGreaterThan(0);
    expect(taxLines.reduce((total, line) => total + line.taxCents, 0n)).toBe(issued.invoice.taxCents);
    expect(taxLines.reduce((total, line) => total + line.taxCents, 0n)).toBe(
      amount(ACCOUNTS.SALES_TAX_PAYABLE, 'creditCents'),
    );
    // The base is the taxable work, not the invoice total: labour here is taxable, and a
    // jurisdiction that taxed something must say what.
    expect(taxLines.every((line) => line.taxableCents > 0n)).toBe(true);
    expect(taxLines.every((line) => Number(line.rate) > 0)).toBe(true);
    expect(taxLines.every((line) => line.taxJurisdiction.name.length > 0)).toBe(true);

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

describe('billing the work that is finished', () => {
  /** A completed job with one line on it, priced and waiting to be invoiced. */
  async function finished(org: TestOrg, ctx: AuthContext, item: string, title: string) {
    const job = await createTestJob(org.organizationId, org.locationId, title);
    await addJobLine(db, ctx, job.jobId, { priceBookItemId: item, quantity: '1' });
    await transitionJob(db, ctx, job.jobId, 'SCHEDULED');
    await transitionJob(db, ctx, job.jobId, 'IN_PROGRESS');
    await transitionJob(db, ctx, job.jobId, 'COMPLETED');
    return job;
  }

  it('bills one job in a single call and consumes what the field already collected', async () => {
    const org = await createTestOrg('Billing');
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Fence repair',
      category: 'LABOR',
      costCents: 4_000n,
      priceCents: 30_000n,
    });

    const job = await finished(org, ctx, item, 'Repair side gate');

    // The technician was handed a cheque on the doorstep before anyone raised an invoice.
    await recordPayment(db, ctx, {
      customerId: job.customerId,
      locationId: org.locationId,
      jobId: job.jobId,
      method: 'CHECK',
      amountCents: 20_000n,
      isDeposit: true,
      receivedAt: utc(2026, 3, 2),
    });

    const result = await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 3, 5) });

    expect(result.invoiceNo).toMatch(/^INV-/);
    expect(result.totalCents).toBe(30_000n);
    expect(result.depositAppliedCents).toBe(20_000n);
    expect(result.balanceCents).toBe(10_000n);

    // Issued, not left as a draft: the job has moved on and the ledger has the entry.
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: result.invoiceId! } });
    expect(invoice.status).toBe('OPEN');
    expect(invoice.journalEntryId).not.toBeNull();
    const after = await db.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(after.status).toBe('INVOICED');
  });

  it('bills a batch and reports the ones it could not, without stranding the rest', async () => {
    const org = await createTestOrg('BillingBatch');
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Door adjustment',
      category: 'LABOR',
      costCents: 3_000n,
      priceCents: 18_000n,
    });

    const first = await finished(org, ctx, item, 'Adjust front door');
    const second = await finished(org, ctx, item, 'Adjust back door');

    // A warranty callback is finished work that nobody may bill, and it sits in the same
    // list as everything else.
    const warranty = await finished(org, ctx, item, 'Callback — door binding again');
    await db.job.update({
      where: { id: warranty.jobId },
      data: { isWarranty: true, isBillable: false },
    });

    const batch = await billJobs(db, ctx, [first.jobId, warranty.jobId, second.jobId], {
      issueDate: utc(2026, 3, 9),
    });

    expect(batch.billedCount).toBe(2);
    expect(batch.totalCents).toBe(36_000n);

    const refused = batch.results.find((row) => row.error);
    expect(refused!.jobId).toBe(warranty.jobId);
    expect(refused!.error).toMatch(/warranty rework/);

    // The two that could be billed were, and in the order they were given.
    const billed = batch.results.filter((row) => row.invoiceNo).map((row) => row.invoiceNo!);
    expect(billed.length).toBe(2);
    expect(billed[0] < billed[1]).toBe(true);

    // And the refused job is still there, still finished, still not invoiced.
    const untouched = await db.job.findUniqueOrThrow({ where: { id: warranty.jobId } });
    expect(untouched.status).toBe('COMPLETED');
    expect(await db.invoice.count({ where: { jobId: warranty.jobId } })).toBe(0);
  });

  it('will not bill the same job twice', async () => {
    const org = await createTestOrg('BillingTwice');
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Tap replacement',
      category: 'LABOR',
      costCents: 2_000n,
      priceCents: 12_000n,
    });
    const job = await finished(org, ctx, item, 'Replace kitchen tap');

    await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 3, 12) });
    const again = await billJobs(db, ctx, [job.jobId], { issueDate: utc(2026, 3, 12) });

    expect(again.billedCount).toBe(0);
    expect(again.results[0].error).toBeTruthy();
    expect(await db.invoice.count({ where: { jobId: job.jobId } })).toBe(1);
  });
});

describe('getting the money to the bank', () => {
  it('holds cash and cheques until a slip is written, then banks them together', async () => {
    const org = await createTestOrg('Banking');
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Gutter clearing',
      category: 'LABOR',
      costCents: 3_000n,
      priceCents: 20_000n,
    });

    const invoices: string[] = [];
    for (const title of ['Clear front gutters', 'Clear back gutters']) {
      const job = await createTestJob(org.organizationId, org.locationId, title);
      await addJobLine(db, ctx, job.jobId, { priceBookItemId: item, quantity: '1' });
      await transitionJob(db, ctx, job.jobId, 'SCHEDULED');
      await transitionJob(db, ctx, job.jobId, 'IN_PROGRESS');
      await transitionJob(db, ctx, job.jobId, 'COMPLETED');
      const billed = await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 8, 3) });
      invoices.push(billed.invoiceId!);
    }

    const [first, second] = await db.invoice.findMany({
      where: { id: { in: invoices } },
      orderBy: { invoiceNo: 'asc' },
    });

    // A cheque in the post and a card payment on the phone, the same afternoon.
    await recordPayment(db, ctx, {
      customerId: first.customerId,
      locationId: org.locationId,
      invoiceId: first.id,
      method: 'CHECK',
      amountCents: first.balanceCents,
      reference: '4471',
      receivedAt: utc(2026, 8, 4),
    });
    await recordPayment(db, ctx, {
      customerId: second.customerId,
      locationId: org.locationId,
      invoiceId: second.id,
      method: 'CARD',
      amountCents: second.balanceCents,
      receivedAt: utc(2026, 8, 4),
    });

    // Only the cheque is in the drawer. The card is the processor's problem.
    const inHand = await undepositedPayments(db, ctx);
    expect(inHand.payments.length).toBe(1);
    expect(inHand.payments[0].method).toBe('CHECK');
    expect(inHand.totalCents).toBe(first.balanceCents);
    // The documents and the postings are two routes to one number, and they agree.
    expect(inHand.ledgerCents).toBe(first.balanceCents);
    expect(inHand.matches).toBe(true);

    const before = await trialBalance(db, ctx, { to: utc(2026, 8, 4) });
    expect(before.rows.find((r) => r.code === ACCOUNTS.UNDEPOSITED_FUNDS)!.balanceCents).toBe(
      first.balanceCents,
    );
    expect(before.rows.find((r) => r.code === ACCOUNTS.BANK_OPERATING)).toBeUndefined();

    const slip = await bankTakings(db, ctx, { depositedAt: utc(2026, 8, 6) });

    expect(slip.depositNo).toMatch(/^DEP-\d{5}$/);
    expect(slip.paymentCount).toBe(1);
    expect(slip.totalCents).toBe(first.balanceCents);

    // The bank line and the payments that made it up point at each other.
    const batch = await db.depositBatch.findFirstOrThrow({
      where: { organizationId: org.organizationId },
      include: { payments: true },
    });
    expect(batch.journalEntryId).toBe(slip.journalEntryId);
    expect(batch.payments.length).toBe(1);
    expect(batch.payments[0].reference).toBe('4471');

    const after = await trialBalance(db, ctx, { to: utc(2026, 8, 6) });
    expect(after.rows.find((r) => r.code === ACCOUNTS.UNDEPOSITED_FUNDS)?.balanceCents ?? 0n).toBe(
      0n,
    );
    expect(after.rows.find((r) => r.code === ACCOUNTS.BANK_OPERATING)!.balanceCents).toBe(
      first.balanceCents,
    );
    expect(after.isBalanced).toBe(true);

    // Nothing left in hand, and a second slip has nothing to write.
    expect((await undepositedPayments(db, ctx)).payments.length).toBe(0);
    const again = await bankTakings(db, ctx, { depositedAt: utc(2026, 8, 7) });
    expect(again.paymentCount).toBe(0);
    expect(again.journalEntryId).toBeNull();
  });

  it('refuses to bank a payment that is already on a slip', async () => {
    const org = await createTestOrg('BankingTwice');
    const ctx = systemContext(org.organizationId);
    const customer = await createCustomer(db, ctx, {
      lastName: 'Ashworth',
      property: { addressLine1: '3 B St', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });

    const payment = await recordPayment(db, ctx, {
      customerId: customer.id,
      locationId: org.locationId,
      method: 'CASH',
      amountCents: 12_000n,
      isDeposit: true,
      receivedAt: utc(2026, 8, 10),
    });

    await bankTakings(db, ctx, { depositedAt: utc(2026, 8, 11) });

    await expect(
      bankTakings(db, ctx, {
        paymentIds: [payment.payment.id],
        depositedAt: utc(2026, 8, 12),
      }),
    ).rejects.toThrow(/already been banked/);
  });
});

describe('undoing a sale', () => {
  async function invoiced(name: string, opts: { tax?: boolean } = {}) {
    const org = await createTestOrg(name);
    const ctx = systemContext(org.organizationId);
    const labour = await createPriceBookItem(org.organizationId, {
      name: 'Repair labour',
      category: 'LABOR',
      costCents: 4_000n,
      priceCents: 30_000n,
    });
    const part = await createPriceBookItem(org.organizationId, {
      name: 'Replacement valve',
      category: 'MATERIAL',
      costCents: 2_000n,
      priceCents: 10_000n,
    });

    const job = await createTestJob(org.organizationId, org.locationId, 'Fix the thing');
    if (opts.tax) {
      const jurisdiction = await createTaxJurisdiction(org.organizationId, { rate: '0.10' });
      await setPropertyJurisdiction(job.propertyId, jurisdiction);
    }
    await addJobLine(db, ctx, job.jobId, { priceBookItemId: labour, quantity: '1' });
    await addJobLine(db, ctx, job.jobId, { priceBookItemId: part, quantity: '1' });
    await transitionJob(db, ctx, job.jobId, 'SCHEDULED');
    await transitionJob(db, ctx, job.jobId, 'IN_PROGRESS');
    await transitionJob(db, ctx, job.jobId, 'COMPLETED');

    const billed = await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 9, 2) });
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: billed.invoiceId! } });
    return { org, ctx, job, invoice };
  }

  it('voids an unbilled-in-error invoice by reversing it, and gives the work back', async () => {
    const { org, ctx, job, invoice } = await invoiced('Voiding');
    expect(invoice.totalCents).toBe(40_000n);

    const result = await voidInvoice(db, ctx, invoice.id, {
      reason: 'Billed to the wrong customer',
      voidedAt: utc(2026, 9, 5),
    });

    expect(result.invoice.status).toBe('VOID');
    expect(result.invoice.balanceCents).toBe(0n);
    expect(result.reversalEntryNo).toMatch(/^JE-/);

    // Nothing owed and nothing earned: the reversal cancels the issue, and the original
    // entry is still there — corrections are postings, not edits.
    const tb = await trialBalance(db, ctx, { to: utc(2026, 9, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)?.balanceCents ?? 0n).toBe(0n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.REVENUE_LABOR)?.balanceCents ?? 0n).toBe(0n);
    expect(tb.isBalanced).toBe(true);
    expect(await db.journalEntry.count({ where: { organizationId: org.organizationId, source: 'INVOICE' } })).toBe(1);

    // The work is billable again, and the screen that finds unbilled work can see it.
    const after = await db.job.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(after.status).toBe('COMPLETED');
    const lines = await db.jobLine.findMany({ where: { jobId: job.jobId } });
    expect(lines.every((line) => !line.isBilled && line.invoiceId === null)).toBe(true);

    const rebilled = await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 9, 6) });
    expect(rebilled.totalCents).toBe(40_000n);
    expect(rebilled.invoiceNo).not.toBe(invoice.invoiceNo);
  });

  it('refuses to void what has been paid, and refuses without a reason', async () => {
    const { ctx, invoice } = await invoiced('VoidingPaid');

    await expect(voidInvoice(db, ctx, invoice.id, { reason: '  ' })).rejects.toThrow(
      /needs a reason/,
    );

    await recordPayment(db, ctx, {
      customerId: invoice.customerId,
      locationId: invoice.locationId,
      invoiceId: invoice.id,
      method: 'CHECK',
      amountCents: 10_000n,
      receivedAt: utc(2026, 9, 4),
    });

    await expect(
      voidInvoice(db, ctx, invoice.id, { reason: 'Changed our minds' }),
    ).rejects.toThrow(/Credit it instead/);
  });

  it('credits part of an invoice, taking the tax back out with it', async () => {
    const { ctx, invoice } = await invoiced('Crediting', { tax: true });

    // 40,000 of work plus 10% tax.
    expect(invoice.taxCents).toBe(4_000n);
    expect(invoice.totalCents).toBe(44_000n);

    const credit = await issueCreditMemo(db, ctx, {
      invoiceId: invoice.id,
      amountCents: 11_000n,
      reason: 'Goodwill after a callback',
      issuedAt: utc(2026, 9, 8),
    });

    expect(credit.creditMemoNo).toMatch(/^CM-\d{5}$/);
    // A quarter of the bill is a quarter of the tax: the liability cannot keep tax that
    // was never collected.
    expect(credit.taxCents).toBe(1_000n);
    expect(credit.revenueCents).toBe(10_000n);
    expect(credit.invoice.balanceCents).toBe(33_000n);
    expect(credit.invoice.status).toBe('OPEN');

    const tb = await trialBalance(db, ctx, { to: utc(2026, 9, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(33_000n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.SALES_TAX_PAYABLE)!.balanceCents).toBe(3_000n);
    // Revenue came down, split the way the invoice was: three quarters of each account.
    expect(tb.rows.find((r) => r.code === ACCOUNTS.REVENUE_LABOR)!.balanceCents).toBe(22_500n);
    expect(tb.rows.find((r) => r.code === ACCOUNTS.REVENUE_MATERIALS)!.balanceCents).toBe(7_500n);
    expect(tb.isBalanced).toBe(true);

    // The original invoice and its posting are untouched: a credit is a second event.
    const original = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(original.totalCents).toBe(44_000n);
    expect(original.voidedAt).toBeNull();
  });

  it('credits the rest, and will not credit more than the invoice', async () => {
    const { ctx, invoice } = await invoiced('CreditingFully');

    await issueCreditMemo(db, ctx, {
      invoiceId: invoice.id,
      amountCents: 15_000n,
      reason: 'Part returned',
      issuedAt: utc(2026, 9, 9),
    });

    // No amount means what is still owed.
    const rest = await issueCreditMemo(db, ctx, {
      invoiceId: invoice.id,
      reason: 'Job abandoned by the customer',
      issuedAt: utc(2026, 9, 10),
    });
    expect(rest.amountCents).toBe(25_000n);
    expect(rest.invoice.balanceCents).toBe(0n);
    expect(rest.invoice.status).toBe('PAID');

    await expect(
      issueCreditMemo(db, ctx, { invoiceId: invoice.id, amountCents: 100n, reason: 'Again' }),
    ).rejects.toThrow(/credited in full/);

    // And a fully credited invoice cannot then be voided as if it never happened.
    await expect(
      voidInvoice(db, ctx, invoice.id, { reason: 'Tidying up' }),
    ).rejects.toThrow(/already been credited/);

    const tb = await trialBalance(db, ctx, { to: utc(2026, 9, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)?.balanceCents ?? 0n).toBe(0n);
    expect(tb.isBalanced).toBe(true);
  });

  it('leaves a credit standing when the customer has already paid', async () => {
    const { ctx, invoice } = await invoiced('CreditingPaid');

    await recordPayment(db, ctx, {
      customerId: invoice.customerId,
      locationId: invoice.locationId,
      invoiceId: invoice.id,
      method: 'CARD',
      amountCents: invoice.totalCents,
      receivedAt: utc(2026, 9, 4),
    });

    const credit = await issueCreditMemo(db, ctx, {
      invoiceId: invoice.id,
      amountCents: 5_000n,
      reason: 'Overcharged for the part',
      issuedAt: utc(2026, 9, 11),
    });
    expect(credit.amountCents).toBe(5_000n);

    // The customer is owed money now, and the receivable says so by going negative — which
    // is the truth until it is refunded or set against their next invoice.
    const tb = await trialBalance(db, ctx, { to: utc(2026, 9, 30) });
    expect(tb.rows.find((r) => r.code === ACCOUNTS.AR)!.balanceCents).toBe(-5_000n);
    expect(tb.isBalanced).toBe(true);
  });
});

describe('getting the document to the customer', () => {
  async function sendable(name: string) {
    const org = await createTestOrg(name);
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Fence panel replacement',
      category: 'LABOR',
      costCents: 5_000n,
      priceCents: 35_000n,
    });
    const job = await createTestJob(org.organizationId, org.locationId, 'Replace fence panel');
    await db.customer.update({
      where: { id: job.customerId },
      data: { email: 'owner@example.com' },
    });
    await addJobLine(db, ctx, job.jobId, { priceBookItemId: item, quantity: '1' });
    await transitionJob(db, ctx, job.jobId, 'SCHEDULED');
    await transitionJob(db, ctx, job.jobId, 'IN_PROGRESS');
    await transitionJob(db, ctx, job.jobId, 'COMPLETED');
    const billed = await billJob(db, ctx, job.jobId, { issueDate: utc(2026, 9, 14) });
    return { org, ctx, invoiceId: billed.invoiceId!, customerId: job.customerId };
  }

  it('makes a link, queues the message, and knows when it was opened', async () => {
    const { ctx, invoiceId } = await sendable('Sending');

    const sent = await sendDocument(db, ctx, { type: 'INVOICE', documentId: invoiceId });
    expect(sent.to).toBe('owner@example.com');
    expect(sent.subject).toMatch(/^Invoice INV-/);
    expect(sent.path).toMatch(/^\/d\/[A-Za-z0-9_-]{20,}$/);

    const token = sent.path.replace('/d/', '');

    // Only the hash is stored: a copy of the database is not a set of working links.
    const share = await db.documentShare.findFirstOrThrow({ where: { documentId: invoiceId } });
    expect(share.tokenHash).not.toContain(token);
    expect(share.tokenHash).toBe(hashShareToken(token));
    expect(share.viewedAt).toBeNull();

    // The message is real and waiting, rather than claimed as sent.
    const message = await db.notification.findFirstOrThrow({
      where: { entityType: 'INVOICE', entityId: invoiceId },
    });
    expect(message.status).toBe('QUEUED');
    expect(message.channel).toBe('EMAIL');
    expect(message.body).toContain(sent.path);

    const before = await deliveryState(db, ctx, 'INVOICE', invoiceId);
    expect(before.sendCount).toBe(1);
    expect(before.viewedAt).toBeNull();

    // The customer opens it. No account, no session — the token is the whole of it.
    const opened = await resolveShare(db, token);
    expect(opened!.id).toBe(share.id);

    const after = await deliveryState(db, ctx, 'INVOICE', invoiceId);
    expect(after.viewedAt).not.toBeNull();
    expect(after.viewCount).toBe(1);

    // And the invoice itself carries it, so the office sees it without going looking.
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.sentAt).not.toBeNull();
    expect(invoice.viewedAt).not.toBeNull();
  });

  it('refuses a wrong, revoked or expired link without saying which', async () => {
    const { ctx, invoiceId } = await sendable('SendingLinks');

    const sent = await sendDocument(db, ctx, { type: 'INVOICE', documentId: invoiceId });
    const token = sent.path.replace('/d/', '');

    expect(await resolveShare(db, 'not-a-real-token-but-long-enough')).toBeNull();
    expect(await resolveShare(db, '')).toBeNull();

    await revokeShares(db, ctx, 'INVOICE', invoiceId);
    expect(await resolveShare(db, token)).toBeNull();

    // A second send makes its own link, so killing one does not kill the other.
    const again = await sendDocument(db, ctx, { type: 'INVOICE', documentId: invoiceId });
    expect(again.path).not.toBe(sent.path);
    expect(await resolveShare(db, again.path.replace('/d/', ''))).not.toBeNull();

    const expired = await sendDocument(db, ctx, {
      type: 'INVOICE',
      documentId: invoiceId,
      expiresInDays: -1,
    });
    expect(await resolveShare(db, expired.path.replace('/d/', ''))).toBeNull();
  });

  it('will not send to nobody, or to something that is not an address', async () => {
    const { ctx, invoiceId, customerId } = await sendable('SendingAddress');

    await expect(
      sendDocument(db, ctx, { type: 'INVOICE', documentId: invoiceId, to: 'not an address' }),
    ).rejects.toThrow(/does not look like an email/);

    await db.customer.update({ where: { id: customerId }, data: { email: null } });
    await expect(
      sendDocument(db, ctx, { type: 'INVOICE', documentId: invoiceId }),
    ).rejects.toThrow(/no email address on file/);
  });

  it('sending a draft quote is what makes it sent', async () => {
    const org = await createTestOrg('SendingQuote');
    const ctx = systemContext(org.organizationId);
    const item = await createPriceBookItem(org.organizationId, {
      name: 'Deck staining',
      category: 'LABOR',
      costCents: 8_000n,
      priceCents: 48_000n,
    });
    const customer = await createCustomer(db, ctx, {
      lastName: 'Okafor',
      email: 'okafor@example.com',
      property: { addressLine1: '9 C St', city: 'Mesa', state: 'AZ', postalCode: '85201' },
    });
    const quote = await createQuote(db, ctx, {
      locationId: org.locationId,
      customerId: customer.id,
      propertyId: customer.properties[0].id,
      lines: [{ priceBookItemId: item, quantity: '1' }],
    });
    expect(quote.status).toBe('DRAFT');

    await sendDocument(db, ctx, { type: 'QUOTE', documentId: quote.id });

    const after = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(after.status).toBe('SENT');
    expect(after.sentAt).not.toBeNull();
  });
});
