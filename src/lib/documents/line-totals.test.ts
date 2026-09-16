import { describe, expect, it } from 'vitest';
import { sum } from '../money';
import type { TaxRuleView } from '../pricing/tax';
import { computeDocumentTotals, revenueByCategory, type DraftLine } from './line-totals';

const MESA: TaxRuleView = {
  jurisdictionId: 'jur-mesa',
  jurisdictionName: 'Mesa',
  rate: '0.0830',
  taxLabor: true,
  taxMaterials: true,
  taxServiceAgreements: false,
  taxFees: false,
};

const LINES: DraftLine[] = [
  {
    category: 'LABOR',
    description: 'Journeyman labor',
    quantity: '2.5',
    unitPriceCents: 12500n,
    unitCostCents: 4056n,
  },
  {
    category: 'MATERIAL',
    description: 'Wax ring kit',
    quantity: '2',
    unitPriceCents: 1800n,
    unitCostCents: 420n,
  },
];

describe('computeDocumentTotals', () => {
  it('extends quantity by price and computes tax on the net', () => {
    const totals = computeDocumentTotals(LINES, MESA);

    expect(totals.lines[0].extendedCents).toBe(31250n); // 2.5 x 125.00
    expect(totals.lines[1].extendedCents).toBe(3600n); // 2 x 18.00
    expect(totals.subtotalCents).toBe(34850n);
    expect(totals.taxCents).toBe(2893n); // 348.50 at 8.3%
    expect(totals.totalCents).toBe(37743n);
  });

  it('computes margin on the net, never including tax', () => {
    const totals = computeDocumentTotals(LINES, MESA);

    // Cost: 2.5 x 40.56 + 2 x 4.20 = 101.40 + 8.40 = 109.80
    expect(totals.costCents).toBe(10980n);
    // Margin is against net revenue of 348.50, not the tax-inclusive 377.43.
    expect(totals.grossMarginCents).toBe(23870n);
    expect(totals.grossMarginPercent).toBeCloseTo(68.49, 1);
  });

  it('applies a discount before tax', () => {
    const discounted = computeDocumentTotals(
      [{ ...LINES[0], discountCents: 5000n }, LINES[1]],
      MESA,
    );

    expect(discounted.discountCents).toBe(5000n);
    expect(discounted.lines[0].netCents).toBe(26250n);
    // Tax is on 298.50, not 348.50 — the customer is not taxed on money they did not pay.
    expect(discounted.taxCents).toBe(2478n);
  });

  it('line totals sum exactly to the document total', () => {
    const totals = computeDocumentTotals(LINES, MESA);
    expect(sum(totals.lines.map((l) => l.totalCents))).toBe(totals.totalCents);
  });

  it('refuses a discount larger than the line', () => {
    expect(() =>
      computeDocumentTotals([{ ...LINES[1], discountCents: 999999n }], MESA),
    ).toThrow(/exceeds the line amount/);
  });

  it('refuses a negative discount', () => {
    expect(() => computeDocumentTotals([{ ...LINES[1], discountCents: -100n }], MESA)).toThrow(
      /must be a positive amount/,
    );
  });

  it('handles a document with no tax jurisdiction', () => {
    const totals = computeDocumentTotals(LINES, null);
    expect(totals.taxCents).toBe(0n);
    expect(totals.totalCents).toBe(totals.subtotalCents);
  });
});

describe('revenueByCategory', () => {
  it('groups net amounts for the general ledger posting', () => {
    const totals = computeDocumentTotals(LINES, MESA);
    const revenue = revenueByCategory(totals.lines);

    expect(revenue).toHaveLength(2);
    expect(revenue.find((r) => r.category === 'LABOR')!.amountCents).toBe(31250n);
    expect(revenue.find((r) => r.category === 'MATERIAL')!.amountCents).toBe(3600n);
    // Revenue posted equals net, so the ledger and the invoice can never disagree.
    expect(sum(revenue.map((r) => r.amountCents))).toBe(
      totals.subtotalCents - totals.discountCents,
    );
  });

  it('drops a category that nets to zero', () => {
    const revenue = revenueByCategory(
      computeDocumentTotals([{ ...LINES[1], quantity: '0' }], MESA).lines,
    );
    expect(revenue).toHaveLength(0);
  });
});
