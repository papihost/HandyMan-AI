import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../db';
import { NotFoundError, ValidationError } from '../errors';
import { applyRate, type Cents } from '../money';

/**
 * Price resolution.
 *
 * A price book item has a base price, and may be overridden per location, per customer
 * price tier, or both. Precedence is most specific first, so a Scottsdale commercial
 * customer gets the Scottsdale commercial price if one exists, then the Scottsdale price,
 * then the commercial price, then the base.
 *
 * Overrides are effective-dated, so a price rise scheduled for next month does not change
 * what a quote sent today says.
 */

export interface ResolvedPrice {
  priceBookItemId: string;
  sku: string;
  name: string;
  priceCents: Cents;
  /** Present only for callers permitted to see cost; the caller decides whether to pass it on. */
  costCents: Cents;
  unit: string;
  category: import('@prisma/client').LineCategory;
  isTaxExempt: boolean;
  estimatedHours: string | null;
  serviceTypeId: string | null;
  /** Which override supplied the price, for "why is it this price?" support calls. */
  source: 'BASE' | 'LOCATION' | 'TIER' | 'LOCATION_TIER';
}

export async function resolvePrice(
  db: PrismaClient | Tx,
  organizationId: string,
  priceBookItemId: string,
  options: { locationId?: string | null; priceTier?: string | null; onDate?: Date } = {},
): Promise<ResolvedPrice> {
  const onDate = options.onDate ?? new Date();

  const item = await db.priceBookItem.findFirst({
    where: { id: priceBookItemId, organizationId },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      category: true,
      isTaxExempt: true,
      isActive: true,
      priceCents: true,
      costCents: true,
      estimatedHours: true,
      serviceTypeId: true,
      overrides: {
        where: {
          effectiveFrom: { lte: onDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
        },
      },
    },
  });

  if (!item) throw new NotFoundError('Price book item', priceBookItemId);
  if (!item.isActive) {
    throw new ValidationError(`${item.sku} (${item.name}) is inactive and cannot be sold`);
  }

  const { locationId = null, priceTier = null } = options;
  const match = (l: string | null, t: string | null) =>
    item.overrides.find((o) => o.locationId === l && o.priceTier === t);

  const locationTier = locationId && priceTier ? match(locationId, priceTier) : undefined;
  const location = locationId ? match(locationId, null) : undefined;
  const tier = priceTier ? match(null, priceTier) : undefined;

  const chosen = locationTier ?? location ?? tier;
  const source: ResolvedPrice['source'] = locationTier
    ? 'LOCATION_TIER'
    : location
      ? 'LOCATION'
      : tier
        ? 'TIER'
        : 'BASE';

  return {
    priceBookItemId: item.id,
    sku: item.sku,
    name: item.name,
    priceCents: chosen?.priceCents ?? item.priceCents,
    costCents: item.costCents,
    unit: item.unit,
    category: item.category,
    isTaxExempt: item.isTaxExempt,
    estimatedHours: item.estimatedHours?.toString() ?? null,
    serviceTypeId: item.serviceTypeId,
    source,
  };
}

/** Sell price from cost and a markup percentage. `0.45` means a 45% markup on cost. */
export function priceFromMarkup(costCents: Cents, markup: string | number): Cents {
  return costCents + applyRate(costCents, markup);
}

/** The margin percentage a given cost and price imply. Useful for price-book review screens. */
export function marginPercent(costCents: Cents, priceCents: Cents): number {
  if (priceCents === 0n) return 0;
  return Number(((priceCents - costCents) * 10000n) / priceCents) / 100;
}
