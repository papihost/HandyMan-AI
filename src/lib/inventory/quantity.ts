import { ValidationError } from '../errors';
import type { Cents } from '../money';

/**
 * Quantity arithmetic for inventory.
 *
 * Quantities carry up to three decimal places (feet of wire, gallons of sealant), so they
 * are held as integer thousandths internally. Mixing a decimal quantity with an integer
 * money amount in floating point is how inventory valuations start disagreeing with the
 * general ledger by a few cents a month.
 */

export type Milli = bigint;

export const MILLI = 1000n;

export function toMilli(quantity: string | number): Milli {
  const q = typeof quantity === 'number' ? quantity.toString() : quantity.trim();
  if (!/^-?\d*(\.\d+)?$/.test(q)) throw new ValidationError(`Invalid quantity "${quantity}"`);

  const negative = q.startsWith('-');
  const [whole = '0', frac = ''] = q.replace('-', '').split('.');
  if (frac.length > 3) {
    throw new ValidationError(`Quantity "${quantity}" has more than three decimal places`);
  }
  const value = BigInt(whole || '0') * MILLI + BigInt((frac + '000').slice(0, 3));
  return negative ? -value : value;
}

export function fromMilli(milli: Milli): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = abs / MILLI;
  const frac = (abs % MILLI).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Value of `milli` units at `unitCents` each, rounded half-up to the cent. */
export function valueOf(milli: Milli, unitCents: Cents): Cents {
  const negative = milli < 0n !== unitCents < 0n;
  const absMilli = milli < 0n ? -milli : milli;
  const absUnit = unitCents < 0n ? -unitCents : unitCents;
  const rounded = (absMilli * absUnit * 2n + MILLI) / (MILLI * 2n);
  return negative ? -rounded : rounded;
}

/** Unit cost implied by a value and a quantity, rounded half-up. Zero quantity gives zero. */
export function unitCostOf(valueCents: Cents, milli: Milli): Cents {
  if (milli === 0n) return 0n;
  const negative = valueCents < 0n !== milli < 0n;
  const absValue = valueCents < 0n ? -valueCents : valueCents;
  const absMilli = milli < 0n ? -milli : milli;
  const rounded = (absValue * MILLI * 2n + absMilli) / (absMilli * 2n);
  return negative ? -rounded : rounded;
}
