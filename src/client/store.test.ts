import { describe, expect, it } from 'vitest';
import { jobTotal, lineTotal, money, type ClientJob, type ClientJobLine } from './store';

const line = (over: Partial<ClientJobLine> = {}): ClientJobLine => ({
  id: 'l1',
  description: 'Technician labor',
  quantity: '2.5',
  unitPriceCents: 12500n,
  discountCents: 0n,
  category: 'LABOR',
  priceBookItemId: 'item-1',
  isBilled: false,
  ...over,
});

describe('money', () => {
  it('formats the way a customer reads a price', () => {
    expect(money(12500n)).toBe('125.00');
    expect(money(5n)).toBe('0.05');
    expect(money(123456789n)).toBe('1,234,567.89');
    expect(money(-4500n)).toBe('-45.00');
  });
});

describe('line and job totals', () => {
  it('extends a fractional quantity without a float', () => {
    expect(lineTotal(line())).toBe(31250n); // 2.5 x 125.00
    expect(lineTotal(line({ quantity: '3', unitPriceCents: 1800n }))).toBe(5400n);
  });

  it('takes the discount off the line', () => {
    expect(lineTotal(line({ discountCents: 1250n }))).toBe(30000n);
  });

  it('adds up the job the same way the invoice will', () => {
    const job = {
      lines: [line(), line({ id: 'l2', quantity: '2', unitPriceCents: 1800n })],
    } as ClientJob;

    expect(jobTotal(job)).toBe(34850n);
  });

  it('handles a quantity with three decimal places', () => {
    expect(lineTotal(line({ quantity: '0.333', unitPriceCents: 1000n }))).toBe(333n);
  });
});
