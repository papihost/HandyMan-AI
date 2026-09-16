import type { LineCategory, PrismaClient } from '@prisma/client';
import type { Tx } from '../db';
import { allocate, applyRate, sum, ZERO, type Cents } from '../money';

/**
 * Sales tax.
 *
 * Not a rate field. Which jurisdiction applies is decided by the *service address*, not
 * the branch address, and whether a line is taxable depends on what kind of line it is:
 * labor is taxable in some states and not others, and a service agreement may be treated
 * differently from either. So taxability is a rule per jurisdiction per category.
 *
 * Tax is computed on the aggregate taxable base and then allocated back across the lines
 * rather than computed line by line and summed. Rounding each line separately drifts from
 * the invoice total by a cent or two, and a customer who adds up the lines and gets a
 * different answer from the total will call about it.
 */

export interface TaxRuleView {
  jurisdictionId: string;
  jurisdictionName: string;
  /** Decimal string, e.g. "0.0830". */
  rate: string;
  taxLabor: boolean;
  taxMaterials: boolean;
  taxServiceAgreements: boolean;
  taxFees: boolean;
  liabilityAccountCode?: string;
}

export interface TaxableLine {
  category: LineCategory;
  /** Net of discount — tax applies to what the customer actually pays. */
  netCents: Cents;
  isTaxExempt?: boolean;
}

export interface TaxAllocation {
  jurisdictionId: string;
  jurisdictionName: string;
  rate: string;
  taxableCents: Cents;
  taxCents: Cents;
  liabilityAccountCode?: string;
}

export interface TaxResult {
  /** Tax attributed to each input line, in the same order. Sums exactly to totalTaxCents. */
  perLineCents: Cents[];
  allocations: TaxAllocation[];
  totalTaxCents: Cents;
}

/** Whether this jurisdiction taxes this kind of line. */
export function isCategoryTaxable(category: LineCategory, rule: TaxRuleView): boolean {
  switch (category) {
    case 'LABOR':
      return rule.taxLabor;
    case 'MATERIAL':
      return rule.taxMaterials;
    case 'AGREEMENT':
      return rule.taxServiceAgreements;
    case 'FEE':
      return rule.taxFees;
    case 'SUBCONTRACT':
      // Subcontracted work is labor performed for the customer; it follows labor.
      return rule.taxLabor;
  }
}

export function computeTax(
  lines: readonly TaxableLine[],
  rule: TaxRuleView | null,
  options: { customerIsTaxExempt?: boolean } = {},
): TaxResult {
  const none: TaxResult = {
    perLineCents: lines.map(() => ZERO),
    allocations: [],
    totalTaxCents: ZERO,
  };
  if (!rule || options.customerIsTaxExempt) return none;

  const taxableMask = lines.map(
    (line) => !line.isTaxExempt && isCategoryTaxable(line.category, rule) && line.netCents > ZERO,
  );
  const taxableBase = sum(lines.filter((_, i) => taxableMask[i]).map((l) => l.netCents));
  if (taxableBase === ZERO) return none;

  // One rounding, on the aggregate — then spread across the taxable lines by weight.
  const totalTax = applyRate(taxableBase, rule.rate);
  const weights = lines.map((line, i) => (taxableMask[i] ? line.netCents : ZERO));
  const spread = allocate(totalTax, weights);
  // allocate() distributes any remainder from index 0; push it onto taxable lines only.
  const perLine = lines.map((_, i) => (taxableMask[i] ? spread[i] : ZERO));
  const drift = totalTax - sum(perLine);
  if (drift !== ZERO) {
    const firstTaxable = taxableMask.indexOf(true);
    if (firstTaxable >= 0) perLine[firstTaxable] += drift;
  }

  return {
    perLineCents: perLine,
    allocations: [
      {
        jurisdictionId: rule.jurisdictionId,
        jurisdictionName: rule.jurisdictionName,
        rate: rule.rate,
        taxableCents: taxableBase,
        taxCents: totalTax,
        liabilityAccountCode: rule.liabilityAccountCode,
      },
    ],
    totalTaxCents: totalTax,
  };
}

/**
 * The rule in force for a property on a given date. Returns null when the property has no
 * jurisdiction assigned or no rule is effective — the caller then charges no tax, which is
 * correct and visible rather than a guessed rate.
 */
export async function resolveTaxRuleForProperty(
  db: PrismaClient | Tx,
  organizationId: string,
  propertyId: string,
  onDate: Date,
): Promise<TaxRuleView | null> {
  const property = await db.property.findFirst({
    where: { id: propertyId, customer: { organizationId } },
    select: {
      taxJurisdiction: {
        select: {
          id: true,
          name: true,
          isActive: true,
          liabilityAccountId: true,
          rules: {
            where: {
              effectiveFrom: { lte: onDate },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
            },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const jurisdiction = property?.taxJurisdiction;
  const rule = jurisdiction?.rules[0];
  if (!jurisdiction || !jurisdiction.isActive || !rule) return null;

  return {
    jurisdictionId: jurisdiction.id,
    jurisdictionName: jurisdiction.name,
    rate: rule.rate.toString(),
    taxLabor: rule.taxLabor,
    taxMaterials: rule.taxMaterials,
    taxServiceAgreements: rule.taxServiceAgreements,
    taxFees: rule.taxFees,
  };
}
