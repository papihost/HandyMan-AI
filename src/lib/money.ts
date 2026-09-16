/**
 * Money is BigInt minor units (cents) everywhere in this system. There is no Float
 * anywhere near the ledger, and no Decimal-backed-by-Float either.
 *
 * Rounding happens exactly once, at the boundary where a rate or percentage is applied
 * to an amount, and it is always half-up on the absolute value so that -0.5 and +0.5
 * round away from zero symmetrically (the convention invoicing and tax authorities use).
 */

export type Cents = bigint;

export const ZERO: Cents = 0n;

/** Parse a user- or file-supplied money string into cents. Handles $, commas, and (parens) negatives. */
export function parseMoney(input: string | number | null | undefined): Cents {
  if (input === null || input === undefined || input === '') return ZERO;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`Cannot parse money from ${input}`);
    return roundHalfUp(input * 100);
  }

  let s = input.trim();
  let negative = false;

  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$\s,]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s === '') return ZERO;
  if (!/^\d*(\.\d*)?$/.test(s)) throw new TypeError(`Cannot parse money from "${input}"`);

  const [whole = '0', frac = ''] = s.split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2));
  // A third decimal place rounds the cent.
  const third = frac.charAt(2);
  const rounded = third && Number(third) >= 5 ? cents + 1n : cents;
  return negative ? -rounded : rounded;
}

function roundHalfUp(value: number): Cents {
  const sign = value < 0 ? -1n : 1n;
  return sign * BigInt(Math.round(Math.abs(value)));
}

/** Format cents for display. `formatMoney(123456n)` -> "1,234.56" */
export function formatMoney(cents: Cents, opts: { currency?: string; sign?: boolean } = {}): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = opts.currency === 'USD' || opts.currency === undefined ? '' : '';
  const body = `${symbol}${grouped}.${frac}`;
  if (negative) return `(${body})`;
  return opts.sign ? `+${body}` : body;
}

/**
 * Apply a rate (tax, markup, burden) to an amount. `rate` is a decimal string or number,
 * e.g. "0.0825". Rounds half-up on the absolute value.
 */
export function applyRate(amount: Cents, rate: string | number): Cents {
  const rateStr = typeof rate === 'number' ? rate.toString() : rate.trim();
  if (!/^-?\d*(\.\d+)?$/.test(rateStr)) throw new TypeError(`Invalid rate "${rate}"`);

  const negativeRate = rateStr.startsWith('-');
  const [whole = '0', frac = ''] = rateStr.replace('-', '').split('.');
  const scale = BigInt(10) ** BigInt(frac.length);
  const numerator = BigInt(whole || '0') * scale + BigInt(frac || '0');

  const negative = amount < 0n !== negativeRate;
  const abs = amount < 0n ? -amount : amount;
  // half-up: add half the divisor before integer division
  const product = abs * numerator;
  const rounded = (product * 2n + scale) / (scale * 2n);
  return negative ? -rounded : rounded;
}

/** Multiply an amount by a quantity that may carry up to 3 decimal places. */
export function multiplyQuantity(unitCents: Cents, quantity: string | number): Cents {
  const q = typeof quantity === 'number' ? quantity.toString() : quantity.trim();
  if (!/^-?\d*(\.\d+)?$/.test(q)) throw new TypeError(`Invalid quantity "${quantity}"`);

  const negativeQty = q.startsWith('-');
  const [whole = '0', frac = ''] = q.replace('-', '').split('.');
  const scale = BigInt(10) ** BigInt(frac.length);
  const numerator = BigInt(whole || '0') * scale + BigInt(frac || '0');

  const negative = unitCents < 0n !== negativeQty;
  const abs = unitCents < 0n ? -unitCents : unitCents;
  const rounded = (abs * numerator * 2n + scale) / (scale * 2n);
  return negative ? -rounded : rounded;
}

export function sum(values: Iterable<Cents>): Cents {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

/**
 * Split an amount into n parts that sum exactly to the original, distributing the
 * remainder cent by cent. Used for allocating overhead, discounts and rounding across
 * lines without ever losing or inventing a cent.
 */
export function allocate(amount: Cents, weights: readonly bigint[]): Cents[] {
  const totalWeight = sum(weights);
  if (totalWeight === ZERO) {
    // Even split when there is nothing to weight by.
    const n = BigInt(weights.length);
    if (n === 0n) return [];
    const base = amount / n;
    const result = weights.map(() => base);
    let remainder = amount - base * n;
    const step = remainder < 0n ? -1n : 1n;
    for (let i = 0; remainder !== 0n; i = (i + 1) % weights.length) {
      result[i] += step;
      remainder -= step;
    }
    return result;
  }

  const result = weights.map((w) => (amount * w) / totalWeight);
  let remainder = amount - sum(result);
  const step = remainder < 0n ? -1n : 1n;
  for (let i = 0; remainder !== 0n; i = (i + 1) % weights.length) {
    result[i] += step;
    remainder -= step;
  }
  return result;
}
