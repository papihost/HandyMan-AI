import { describe, expect, it } from 'vitest';
import {
  coerceBoolean,
  coerceDate,
  coerceMoney,
  coerceEmail,
  detectDateOrder,
  detectDecimalSeparator,
  normalizePhone,
} from './coerce';

describe('detectDateOrder', () => {
  it('settles day-first from any value with a day above twelve', () => {
    const result = detectDateOrder(['03/04/2025', '15/04/2025', '01/05/2025']);
    expect(result.order).toBe('DMY');
    expect(result.ambiguous).toBe(false);
  });

  it('settles month-first the same way', () => {
    const result = detectDateOrder(['03/04/2025', '04/15/2025', '12/31/2025']);
    expect(result.order).toBe('MDY');
    expect(result.ambiguous).toBe(false);
  });

  it('recognises ISO dates', () => {
    expect(detectDateOrder(['2025-04-03', '2025-12-31']).order).toBe('YMD');
  });

  it('says so when every value is ambiguous, rather than pretending to know', () => {
    // 03/04 is March or April depending on where the file came from. Guessing wrong
    // misdates a year of history by up to eleven months.
    const result = detectDateOrder(['03/04/2025', '05/06/2025', '01/02/2025']);
    expect(result.ambiguous).toBe(true);
  });
});

describe('coerceDate', () => {
  it('reads a date according to the column order', () => {
    expect(coerceDate('03/04/2025', 'MDY')).toMatchObject({
      ok: true,
      value: new Date(Date.UTC(2025, 2, 4, 12)),
    });
    expect(coerceDate('03/04/2025', 'DMY')).toMatchObject({
      ok: true,
      value: new Date(Date.UTC(2025, 3, 3, 12)),
    });
  });

  it('reads ISO regardless of the column order', () => {
    expect(coerceDate('2025-04-03', 'MDY')).toMatchObject({
      ok: true,
      value: new Date(Date.UTC(2025, 3, 3, 12)),
    });
  });

  it('reads written months', () => {
    expect(coerceDate('15 Mar 2025')).toMatchObject({ ok: true });
    expect(coerceDate('Mar 15, 2025')).toMatchObject({ ok: true });
  });

  it('expands two-digit years into this century, not the last one', () => {
    const result = coerceDate('01/15/24', 'MDY');
    expect(result.ok && result.value.getUTCFullYear()).toBe(2024);
  });

  it('rejects a date that does not exist instead of rolling it forward', () => {
    expect(coerceDate('02/31/2025', 'MDY')).toMatchObject({ ok: false });
  });

  it('rejects text', () => {
    expect(coerceDate('sometime last spring')).toMatchObject({ ok: false });
  });
});

describe('detectDecimalSeparator', () => {
  it('spots a European decimal comma', () => {
    expect(detectDecimalSeparator(['1.234,56', '99,00', '1.000,10'])).toBe(',');
  });

  it('spots the usual decimal point', () => {
    expect(detectDecimalSeparator(['1,234.56', '99.00', '1,000.10'])).toBe('.');
  });

  it('ignores thousands groups, which have three trailing digits', () => {
    expect(detectDecimalSeparator(['1,234', '5,678'])).toBe('.');
  });
});

describe('coerceMoney', () => {
  it('reads currency symbols, thousands separators and parenthesised negatives', () => {
    expect(coerceMoney('$1,234.56')).toMatchObject({ ok: true, value: 123456n });
    expect(coerceMoney('(45.00)')).toMatchObject({ ok: true, value: -4500n });
    expect(coerceMoney('-45')).toMatchObject({ ok: true, value: -4500n });
  });

  it('reads a European amount when told the column uses a decimal comma', () => {
    // Reading this as a decimal point would be wrong by a factor of a thousand.
    expect(coerceMoney('1.234,56', ',')).toMatchObject({ ok: true, value: 123456n });
  });

  it('treats an empty cell as zero, not as an error', () => {
    expect(coerceMoney('')).toMatchObject({ ok: true, value: 0n });
  });

  it('refuses text', () => {
    expect(coerceMoney('about a hundred')).toMatchObject({ ok: false });
  });
});

describe('coerceBoolean and coerceEmail', () => {
  it('accepts the many ways a spreadsheet says yes', () => {
    for (const value of ['Yes', 'Y', 'TRUE', '1', 'x']) {
      expect(coerceBoolean(value)).toMatchObject({ ok: true, value: true });
    }
    for (const value of ['No', 'N', 'FALSE', '0', '', '-']) {
      expect(coerceBoolean(value)).toMatchObject({ ok: true, value: false });
    }
  });

  it('rejects an unrecognised yes/no value rather than assuming', () => {
    expect(coerceBoolean('maybe')).toMatchObject({ ok: false });
  });

  it('lower-cases email and rejects nonsense', () => {
    expect(coerceEmail('  Dana@Example.COM ')).toMatchObject({ ok: true, value: 'dana@example.com' });
    expect(coerceEmail('not an email')).toMatchObject({ ok: false });
    expect(coerceEmail('')).toMatchObject({ ok: true, value: null });
  });
});

describe('normalizePhone', () => {
  it('reduces every format to the same digits', () => {
    expect(normalizePhone('(480) 555-0142')).toBe('4805550142');
    expect(normalizePhone('+1-480-555-0142')).toBe('4805550142');
    expect(normalizePhone('480.555.0142')).toBe('4805550142');
  });
});
