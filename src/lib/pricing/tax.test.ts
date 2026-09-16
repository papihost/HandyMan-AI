import { describe, expect, it } from 'vitest';
import { sum } from '../money';
import { computeTax, isCategoryTaxable, type TaxRuleView } from './tax';

/** Arizona-style: labor on repair work is taxable, materials are taxable, fees are not. */
const MESA: TaxRuleView = {
  jurisdictionId: 'jur-mesa',
  jurisdictionName: 'AZ — Maricopa — Mesa',
  rate: '0.0830',
  taxLabor: true,
  taxMaterials: true,
  taxServiceAgreements: false,
  taxFees: false,
};

/** California-style: labor is not taxable, materials are. This is the case people miss. */
const SAN_JOSE: TaxRuleView = {
  jurisdictionId: 'jur-sj',
  jurisdictionName: 'CA — Santa Clara — San Jose',
  rate: '0.0925',
  taxLabor: false,
  taxMaterials: true,
  taxServiceAgreements: false,
  taxFees: false,
};

describe('taxability by category', () => {
  it('follows the jurisdiction rule rather than a single taxable flag', () => {
    expect(isCategoryTaxable('LABOR', MESA)).toBe(true);
    expect(isCategoryTaxable('LABOR', SAN_JOSE)).toBe(false);
    expect(isCategoryTaxable('MATERIAL', SAN_JOSE)).toBe(true);
    expect(isCategoryTaxable('AGREEMENT', MESA)).toBe(false);
    expect(isCategoryTaxable('FEE', MESA)).toBe(false);
  });

  it('treats subcontracted work as labor', () => {
    expect(isCategoryTaxable('SUBCONTRACT', MESA)).toBe(true);
    expect(isCategoryTaxable('SUBCONTRACT', SAN_JOSE)).toBe(false);
  });
});

describe('computeTax', () => {
  const lines = [
    { category: 'LABOR' as const, netCents: 45000n },
    { category: 'MATERIAL' as const, netCents: 20000n },
    { category: 'FEE' as const, netCents: 8900n },
  ];

  it('taxes only what the jurisdiction says is taxable', () => {
    const mesa = computeTax(lines, MESA);
    // Labor + materials = 650.00 at 8.3% = 53.95. The trip fee is not taxed.
    expect(mesa.allocations[0].taxableCents).toBe(65000n);
    expect(mesa.totalTaxCents).toBe(5395n);
    expect(mesa.perLineCents[2]).toBe(0n);

    const sanJose = computeTax(lines, SAN_JOSE);
    // Only the 200.00 of materials is taxable at 9.25% = 18.50.
    expect(sanJose.allocations[0].taxableCents).toBe(20000n);
    expect(sanJose.totalTaxCents).toBe(1850n);
    expect(sanJose.perLineCents[0]).toBe(0n);
  });

  it('allocates tax across lines so the parts sum exactly to the total', () => {
    // Amounts chosen so per-line rounding would drift from the aggregate.
    const awkward = [
      { category: 'MATERIAL' as const, netCents: 3333n },
      { category: 'MATERIAL' as const, netCents: 3333n },
      { category: 'MATERIAL' as const, netCents: 3334n },
    ];
    const result = computeTax(awkward, MESA);

    expect(sum(result.perLineCents)).toBe(result.totalTaxCents);
    // One rounding on 100.00 at 8.3%, not three roundings on 33.33.
    expect(result.totalTaxCents).toBe(830n);
  });

  it('charges nothing when the customer holds an exemption certificate', () => {
    const result = computeTax(lines, MESA, { customerIsTaxExempt: true });
    expect(result.totalTaxCents).toBe(0n);
    expect(result.allocations).toHaveLength(0);
  });

  it('charges nothing when the property has no jurisdiction, rather than guessing a rate', () => {
    const result = computeTax(lines, null);
    expect(result.totalTaxCents).toBe(0n);
    expect(result.perLineCents.every((c) => c === 0n)).toBe(true);
  });

  it('respects an item marked always exempt', () => {
    const withPermit = [
      { category: 'MATERIAL' as const, netCents: 20000n },
      { category: 'MATERIAL' as const, netCents: 15000n, isTaxExempt: true },
    ];
    const result = computeTax(withPermit, MESA);

    expect(result.allocations[0].taxableCents).toBe(20000n);
    expect(result.perLineCents[1]).toBe(0n);
  });
});
