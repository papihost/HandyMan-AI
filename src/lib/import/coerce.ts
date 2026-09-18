import { parseMoney } from '../money';

/**
 * Turning a cell into a value.
 *
 * Kept separate from parsing because this is where the real damage happens in a migration.
 * `03/04/2025` is March in one country and April in another; `(1,234.56)` is negative;
 * `1.234,56` is a European thousand separator, not a fraction. Getting any of these wrong
 * produces data that looks fine and is wrong, which is worse than an error.
 *
 * Every coercion reports failure rather than guessing, so a bad column surfaces in the
 * validation report instead of silently becoming nulls.
 */

export type CoerceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export const ok = <T>(value: T): CoerceResult<T> => ({ ok: true, value });
export const fail = (reason: string): CoerceResult<never> => ({ ok: false, reason });

export type DateOrder = 'MDY' | 'DMY' | 'YMD';

/**
 * Decide whether a column of dates is month-first or day-first.
 *
 * Any value with a first part above 12 settles it. Where every row is ambiguous the
 * caller is told so, and the wizard asks rather than picking — a silent guess here
 * misdates a year of history by up to eleven months.
 */
export function detectDateOrder(samples: readonly string[]): { order: DateOrder; ambiguous: boolean } {
  let sawDayFirst = false;
  let sawMonthFirst = false;
  let sawIso = false;

  for (const sample of samples) {
    const trimmed = sample.trim();
    if (!trimmed) continue;

    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(trimmed)) {
      sawIso = true;
      continue;
    }

    const parts = trimmed.split(/[-/.]/);
    if (parts.length < 3) continue;

    const first = Number(parts[0]);
    const second = Number(parts[1]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) continue;

    if (first > 12 && second <= 12) sawDayFirst = true;
    else if (second > 12 && first <= 12) sawMonthFirst = true;
  }

  if (sawIso && !sawDayFirst && !sawMonthFirst) return { order: 'YMD', ambiguous: false };
  if (sawDayFirst && !sawMonthFirst) return { order: 'DMY', ambiguous: false };
  if (sawMonthFirst && !sawDayFirst) return { order: 'MDY', ambiguous: false };
  if (sawDayFirst && sawMonthFirst) return { order: 'MDY', ambiguous: true };

  // Nothing decisive. US-format exports dominate this market, but say it is a guess.
  return { order: 'MDY', ambiguous: true };
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function coerceDate(raw: string, order: DateOrder = 'MDY'): CoerceResult<Date> {
  const trimmed = raw.trim();
  if (!trimmed) return fail('empty');

  // ISO first, including the timestamps an API export produces.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(trimmed);
  if (iso) {
    return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // "15 Mar 2025", "Mar 15, 2025"
  const named = /^(\d{1,2})[\s-]*([A-Za-z]{3,})[\s,-]*(\d{2,4})$|^([A-Za-z]{3,})[\s-]*(\d{1,2})[\s,-]*(\d{2,4})$/.exec(trimmed);
  if (named) {
    const monthName = (named[2] ?? named[4]).slice(0, 3).toLowerCase();
    const month = MONTHS[monthName];
    if (!month) return fail(`unrecognised month "${named[2] ?? named[4]}"`);
    const day = Number(named[1] ?? named[5]);
    const year = expandYear(Number(named[3] ?? named[6]));
    return buildDate(year, month, day);
  }

  const parts = trimmed.split(/[-/.]/);
  if (parts.length < 3) return fail(`not a date: "${raw}"`);

  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2].slice(0, 4));
  if (![a, b, c].every(Number.isFinite)) return fail(`not a date: "${raw}"`);

  const [year, month, day] =
    order === 'DMY' ? [expandYear(c), b, a] : order === 'YMD' ? [expandYear(a), b, c] : [expandYear(c), a, b];

  return buildDate(year, month, day);
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  // Two-digit years: a service business's data is recent, not Victorian.
  return year <= 69 ? 2000 + year : 1900 + year;
}

function buildDate(year: number, month: number, day: number): CoerceResult<Date> {
  if (month < 1 || month > 12) return fail(`month ${month} is out of range`);
  if (day < 1 || day > 31) return fail(`day ${day} is out of range`);

  const date = new Date(Date.UTC(year, month - 1, day, 12));
  // Rejects 31 February rather than rolling it into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return fail(`${year}-${month}-${day} is not a real date`);
  }
  return ok(date);
}

/**
 * Whether a column of amounts uses a comma or a dot for the decimal point.
 *
 * `1.234,56` and `1,234.56` are the same number written two ways, and reading one as the
 * other is off by a factor of a thousand. The last separator in a value with exactly two
 * trailing digits is the decimal point.
 */
export function detectDecimalSeparator(samples: readonly string[]): '.' | ',' {
  let dot = 0;
  let comma = 0;

  for (const sample of samples) {
    const cleaned = sample.replace(/[^\d.,]/g, '');
    if (!cleaned) continue;

    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastDot === -1 && lastComma === -1) continue;

    const last = Math.max(lastDot, lastComma);
    const trailing = cleaned.length - last - 1;
    // Exactly two trailing digits is the giveaway; three suggests a thousands group.
    if (trailing !== 2) continue;

    if (last === lastDot) dot++;
    else comma++;
  }

  return comma > dot ? ',' : '.';
}

export function coerceMoney(raw: string, decimal: '.' | ',' = '.'): CoerceResult<bigint> {
  const trimmed = raw.trim();
  if (!trimmed) return ok(0n);

  const normalized =
    decimal === ','
      ? trimmed.replace(/\./g, '').replace(/,/g, '.')
      : trimmed;

  try {
    return ok(parseMoney(normalized));
  } catch {
    return fail(`not an amount: "${raw}"`);
  }
}

export function coerceNumber(raw: string): CoerceResult<number> {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed) return fail('empty');
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fail(`not a number: "${raw}"`);
  return ok(value);
}

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1', 't', 'x', 'checked']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0', 'f', '', '-']);

export function coerceBoolean(raw: string): CoerceResult<boolean> {
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return ok(true);
  if (FALSE_VALUES.has(value)) return ok(false);
  return fail(`not a yes/no value: "${raw}"`);
}

export function coerceEmail(raw: string): CoerceResult<string | null> {
  const value = raw.trim().toLowerCase();
  if (!value) return ok(null);
  // Deliberately permissive: rejecting a real address is worse than accepting an odd one,
  // and the customer's old system already accepted it.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return fail(`not an email address: "${raw}"`);
  return ok(value);
}

/** Digits only, with a US country code stripped — matches how customers are deduplicated. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function coerceText(raw: string, maxLength = 1000): CoerceResult<string | null> {
  const value = raw.trim();
  if (!value) return ok(null);
  if (value.length > maxLength) return fail(`longer than ${maxLength} characters`);
  return ok(value);
}
