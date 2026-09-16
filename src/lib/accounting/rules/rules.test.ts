import { describe, expect, it } from 'vitest';
import { sum, ZERO } from '../../money';
import { ACCOUNTS } from '../chart-of-accounts';
import type { PostingLine } from '../ledger';
import { invoiceIssuedLines, invoiceWrittenOffLines } from './invoice';
import { bankDepositLines, paymentReceivedLines } from './payment';
import { cycleCountVarianceLines, partsConsumedLines, stockTransferLines } from './inventory';
import { laborCostedLines, loadedHourlyCost, splitBurden } from './labor';

/** Every rule must produce a balanced set of lines — that is the whole contract. */
function expectBalanced(lines: PostingLine[]): void {
  const debits = sum(lines.map((l) => l.debitCents ?? ZERO));
  const credits = sum(lines.map((l) => l.creditCents ?? ZERO));
  expect(debits).toBe(credits);
  expect(debits).toBeGreaterThan(ZERO);
}

function amountOn(lines: PostingLine[], code: string, side: 'debitCents' | 'creditCents'): bigint {
  return sum(lines.filter((l) => l.accountCode === code).map((l) => l[side] ?? ZERO));
}

describe('invoice issued', () => {
  const base = {
    invoiceNo: 'INV-00001',
    locationId: 'loc-mesa',
    customerId: 'cust-1',
    jobId: 'job-1',
  };

  it('splits labor and material revenue and credits tax to the jurisdiction', () => {
    const lines = invoiceIssuedLines({
      ...base,
      revenueLines: [
        { category: 'LABOR', amountCents: 45000n },
        { category: 'MATERIAL', amountCents: 20000n },
      ],
      taxes: [{ taxCents: 1650n, jurisdictionName: 'Mesa', liabilityAccountCode: '2100' }],
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.AR, 'debitCents')).toBe(66650n);
    expect(amountOn(lines, ACCOUNTS.REVENUE_LABOR, 'creditCents')).toBe(45000n);
    expect(amountOn(lines, ACCOUNTS.REVENUE_MATERIALS, 'creditCents')).toBe(20000n);
    expect(amountOn(lines, ACCOUNTS.SALES_TAX_PAYABLE, 'creditCents')).toBe(1650n);
  });

  it('posts a discount to contra-revenue rather than netting it against revenue', () => {
    const lines = invoiceIssuedLines({
      ...base,
      revenueLines: [{ category: 'LABOR', amountCents: 50000n }],
      discountCents: 5000n,
    });

    expectBalanced(lines);
    // Gross revenue stays visible at 500.00; the discount is its own reportable figure.
    expect(amountOn(lines, ACCOUNTS.REVENUE_LABOR, 'creditCents')).toBe(50000n);
    expect(amountOn(lines, ACCOUNTS.DISCOUNTS, 'debitCents')).toBe(5000n);
    expect(amountOn(lines, ACCOUNTS.AR, 'debitCents')).toBe(45000n);
  });

  it('relieves the deposit liability instead of treating it as new receivable', () => {
    const lines = invoiceIssuedLines({
      ...base,
      revenueLines: [{ category: 'LABOR', amountCents: 100000n }],
      depositAppliedCents: 30000n,
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.CUSTOMER_DEPOSITS, 'debitCents')).toBe(30000n);
    expect(amountOn(lines, ACCOUNTS.AR, 'debitCents')).toBe(70000n);
  });

  it('carries the location dimension onto every line, which is what makes P&L by branch work', () => {
    const lines = invoiceIssuedLines({
      ...base,
      revenueLines: [{ category: 'LABOR', amountCents: 10000n }],
    });
    expect(lines.every((l) => l.locationId === 'loc-mesa')).toBe(true);
    expect(lines.every((l) => l.jobId === 'job-1')).toBe(true);
  });

  it('refuses a deposit larger than the invoice', () => {
    expect(() =>
      invoiceIssuedLines({
        ...base,
        revenueLines: [{ category: 'LABOR', amountCents: 10000n }],
        depositAppliedCents: 20000n,
      }),
    ).toThrow(/exceeds the invoice total/);
  });

  it('refuses an invoice with no revenue', () => {
    expect(() => invoiceIssuedLines({ ...base, revenueLines: [] })).toThrow();
  });

  it('write-off moves the balance to bad debt', () => {
    const lines = invoiceWrittenOffLines({ ...base, amountCents: 25000n });
    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.BAD_DEBT, 'debitCents')).toBe(25000n);
    expect(amountOn(lines, ACCOUNTS.AR, 'creditCents')).toBe(25000n);
  });
});

describe('payment received', () => {
  const base = { paymentNo: 'PMT-00001', locationId: 'loc-mesa', customerId: 'cust-1' };

  it('a deposit credits the liability, never revenue and never AR', () => {
    const lines = paymentReceivedLines({ ...base, method: 'CHECK', amountCents: 200000n, isDeposit: true });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.CUSTOMER_DEPOSITS, 'creditCents')).toBe(200000n);
    expect(amountOn(lines, ACCOUNTS.AR, 'creditCents')).toBe(ZERO);
    expect(amountOn(lines, ACCOUNTS.REVENUE_LABOR, 'creditCents')).toBe(ZERO);
  });

  it('a card payment lands in clearing, not the bank, and expenses the fee', () => {
    const lines = paymentReceivedLines({
      ...base,
      method: 'CARD',
      amountCents: 100000n,
      feeCents: 2900n,
      isDeposit: false,
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.CARD_CLEARING, 'debitCents')).toBe(97100n);
    expect(amountOn(lines, ACCOUNTS.MERCHANT_FEES, 'debitCents')).toBe(2900n);
    expect(amountOn(lines, ACCOUNTS.AR, 'creditCents')).toBe(100000n);
    expect(amountOn(lines, ACCOUNTS.BANK_OPERATING, 'debitCents')).toBe(ZERO);
  });

  it('a cheque lands in undeposited funds until the deposit is recorded', () => {
    const received = paymentReceivedLines({ ...base, method: 'CHECK', amountCents: 50000n, isDeposit: false });
    expect(amountOn(received, ACCOUNTS.UNDEPOSITED_FUNDS, 'debitCents')).toBe(50000n);

    const deposited = bankDepositLines({ depositNo: 'DEP-00001', amountCents: 50000n });
    expectBalanced(deposited);
    expect(amountOn(deposited, ACCOUNTS.UNDEPOSITED_FUNDS, 'creditCents')).toBe(50000n);
    expect(amountOn(deposited, ACCOUNTS.BANK_OPERATING, 'debitCents')).toBe(50000n);
  });

  it('refuses a fee larger than the payment', () => {
    expect(() =>
      paymentReceivedLines({ ...base, method: 'CARD', amountCents: 100n, feeCents: 200n, isDeposit: false }),
    ).toThrow(/exceeds the payment/);
  });
});

describe('inventory', () => {
  it('consuming parts moves van stock to COGS against the job', () => {
    const lines = partsConsumedLines({
      jobId: 'job-1',
      locationId: 'loc-mesa',
      fromStockKind: 'VAN',
      totalCostCents: 8742n,
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.COGS_MATERIALS, 'debitCents')).toBe(8742n);
    expect(amountOn(lines, ACCOUNTS.INVENTORY_VAN, 'creditCents')).toBe(8742n);
    expect(lines.every((l) => l.jobId === 'job-1')).toBe(true);
  });

  it('holds cost in WIP when the organization uses WIP accounting', () => {
    const lines = partsConsumedLines({
      jobId: 'job-1',
      locationId: 'loc-mesa',
      fromStockKind: 'VAN',
      totalCostCents: 8742n,
      useWip: true,
    });
    expect(amountOn(lines, ACCOUNTS.WIP, 'debitCents')).toBe(8742n);
    expect(amountOn(lines, ACCOUNTS.COGS_MATERIALS, 'debitCents')).toBe(ZERO);
  });

  it('a warehouse-to-van transfer never touches the income statement', () => {
    const lines = stockTransferLines({
      reference: 'TR-1',
      totalCostCents: 25000n,
      fromStockKind: 'WAREHOUSE',
      toStockKind: 'VAN',
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.INVENTORY_VAN, 'debitCents')).toBe(25000n);
    expect(amountOn(lines, ACCOUNTS.INVENTORY_WAREHOUSE, 'creditCents')).toBe(25000n);
  });

  it('a shortage is shrinkage; an overage reverses it', () => {
    const short = cycleCountVarianceLines({ countNo: 'CC-1', stockKind: 'VAN', varianceCents: -4500n });
    expectBalanced(short);
    expect(amountOn(short, ACCOUNTS.INVENTORY_SHRINKAGE, 'debitCents')).toBe(4500n);

    const over = cycleCountVarianceLines({ countNo: 'CC-2', stockKind: 'VAN', varianceCents: 4500n });
    expectBalanced(over);
    expect(amountOn(over, ACCOUNTS.INVENTORY_VAN, 'debitCents')).toBe(4500n);
  });
});

describe('labor burden', () => {
  const typical = {
    baseHourlyCents: 2800n, // $28.00/hr
    payrollTaxRate: '0.0765',
    workersCompRate: '0.08',
    benefitsRate: '0.06',
    vehicleMonthlyCents: 85000n, // $850
    phoneMonthlyCents: 6000n, // $60
    billableHoursPerMonth: '140',
  };

  it('loads a $28/hr wage to roughly $44/hr, which is the entire point', () => {
    const loaded = loadedHourlyCost(typical);
    // 28.00 x 1.2165 = 34.06, plus 910.00/140 = 6.50 -> 40.56
    expect(loaded).toBe(4056n);
    expect(loaded).toBeGreaterThan(typical.baseHourlyCents);
  });

  it('refuses a zero billable-hours denominator instead of dividing by it', () => {
    expect(() => loadedHourlyCost({ ...typical, billableHoursPerMonth: '0' })).toThrow();
  });

  it('splits wage and burden so an owner can see what the burden actually is', () => {
    const { wageCents, burdenCents } = splitBurden(2800n, 4056n);
    expect(wageCents).toBe(2800n);
    expect(burdenCents).toBe(1256n);
  });

  it('posts wage and burden to separate COGS accounts against the job', () => {
    const lines = laborCostedLines({
      jobId: 'job-1',
      locationId: 'loc-mesa',
      technicianId: 'tech-1',
      hours: '2.5',
      baseHourlyCents: 2800n,
      loadedHourlyCents: 4056n,
    });

    expectBalanced(lines);
    expect(amountOn(lines, ACCOUNTS.COGS_LABOR, 'debitCents')).toBe(7000n); // 2.5 x 28.00
    expect(amountOn(lines, ACCOUNTS.COGS_BURDEN, 'debitCents')).toBe(3140n); // 2.5 x 12.56
    expect(amountOn(lines, ACCOUNTS.PAYROLL_LIABILITIES, 'creditCents')).toBe(10140n);
    expect(lines.every((l) => l.technicianId === 'tech-1')).toBe(true);
  });

  it('refuses a loaded cost below the base wage', () => {
    expect(() => splitBurden(2800n, 2000n)).toThrow();
  });
});
