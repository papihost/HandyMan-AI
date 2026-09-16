import type { LineCategory } from '@prisma/client';
import { ValidationError } from '../errors';
import { multiplyQuantity, sum, ZERO, type Cents } from '../money';
import { computeTax, type TaxAllocation, type TaxRuleView } from '../pricing/tax';

/**
 * Line and document arithmetic, shared by quotes, jobs, change orders and invoices.
 *
 * One implementation because a quote that totals differently from the invoice it becomes
 * is a customer service call, and because tax has to be computed the same way in both
 * places or the number the customer approved is not the number they are billed.
 */

export interface DraftLine {
  category: LineCategory;
  description: string;
  /** Up to three decimal places; hours and fractional quantities are normal here. */
  quantity: string | number;
  unitPriceCents: Cents;
  /** Cost at the time of the document, carried for margin. Redacted for non-finance roles. */
  unitCostCents?: Cents;
  /** Positive amount taken off this line. */
  discountCents?: Cents;
  isTaxExempt?: boolean;
  priceBookItemId?: string | null;
  serviceTypeId?: string | null;
  sortOrder?: number;
}

export interface ComputedLine extends DraftLine {
  /** quantity x unit price, before discount. */
  extendedCents: Cents;
  /** extended - discount. The base for tax and for revenue. */
  netCents: Cents;
  taxCents: Cents;
  /** net + tax. What this line adds to the document total. */
  totalCents: Cents;
  /** quantity x unit cost. */
  costCents: Cents;
}

export interface DocumentTotals {
  lines: ComputedLine[];
  /** Sum of extended amounts, before discounts and tax. */
  subtotalCents: Cents;
  discountCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  costCents: Cents;
  grossMarginCents: Cents;
  grossMarginPercent: number;
  taxAllocations: TaxAllocation[];
}

export function computeDocumentTotals(
  lines: readonly DraftLine[],
  taxRule: TaxRuleView | null,
  options: { customerIsTaxExempt?: boolean } = {},
): DocumentTotals {
  const computed = lines.map((line, index) => {
    const extended = multiplyQuantity(line.unitPriceCents, line.quantity);
    const discount = line.discountCents ?? ZERO;

    if (discount < ZERO) {
      throw new ValidationError(`Line ${index + 1}: discount must be a positive amount`);
    }
    if (discount > extended) {
      throw new ValidationError(
        `Line ${index + 1}: discount of ${discount} exceeds the line amount of ${extended}`,
      );
    }

    return {
      ...line,
      extendedCents: extended,
      netCents: extended - discount,
      taxCents: ZERO,
      totalCents: extended - discount,
      costCents: multiplyQuantity(line.unitCostCents ?? ZERO, line.quantity),
    } satisfies ComputedLine;
  });

  const tax = computeTax(computed, taxRule, options);
  for (const [i, line] of computed.entries()) {
    line.taxCents = tax.perLineCents[i];
    line.totalCents = line.netCents + line.taxCents;
  }

  const subtotal = sum(computed.map((l) => l.extendedCents));
  const discount = sum(computed.map((l) => l.discountCents ?? ZERO));
  const net = subtotal - discount;
  const cost = sum(computed.map((l) => l.costCents));
  const margin = net - cost;

  return {
    lines: computed,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax.totalTaxCents,
    // Tax is collected on behalf of the state; it is never part of margin.
    totalCents: net + tax.totalTaxCents,
    costCents: cost,
    grossMarginCents: margin,
    grossMarginPercent: net === ZERO ? 0 : Number((margin * 10000n) / net) / 100,
    taxAllocations: tax.allocations,
  };
}

/** Group net amounts by category, for the revenue lines of a GL posting. */
export function revenueByCategory(
  lines: readonly ComputedLine[],
): { category: LineCategory; amountCents: Cents; serviceTypeId?: string | null }[] {
  const byCategory = new Map<LineCategory, { amountCents: Cents; serviceTypeId?: string | null }>();

  for (const line of lines) {
    const existing = byCategory.get(line.category);
    if (existing) {
      existing.amountCents += line.netCents;
      // A mixed-service-type bucket cannot claim one service type.
      if (existing.serviceTypeId !== line.serviceTypeId) existing.serviceTypeId = null;
    } else {
      byCategory.set(line.category, {
        amountCents: line.netCents,
        serviceTypeId: line.serviceTypeId ?? null,
      });
    }
  }

  return [...byCategory.entries()]
    .filter(([, v]) => v.amountCents !== ZERO)
    .map(([category, v]) => ({ category, ...v }));
}
