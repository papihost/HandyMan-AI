import { describe, expect, it } from 'vitest';
import { allocate, applyRate, formatMoney, multiplyQuantity, parseMoney, sum } from './money';

describe('parseMoney', () => {
  it('parses plain and formatted amounts', () => {
    expect(parseMoney('0')).toBe(0n);
    expect(parseMoney('1')).toBe(100n);
    expect(parseMoney('12.34')).toBe(1234n);
    expect(parseMoney('$1,234.56')).toBe(123456n);
    expect(parseMoney('  1,000  ')).toBe(100000n);
  });

  it('treats parentheses as negative, the way accounting exports do', () => {
    expect(parseMoney('(45.00)')).toBe(-4500n);
    expect(parseMoney('-45.00')).toBe(-4500n);
    expect(parseMoney('($1,234.56)')).toBe(-123456n);
  });

  it('rounds a third decimal place rather than truncating it', () => {
    expect(parseMoney('1.005')).toBe(101n);
    expect(parseMoney('1.004')).toBe(100n);
  });

  it('rejects anything that is not a number', () => {
    expect(() => parseMoney('twelve')).toThrow();
    expect(() => parseMoney('1.2.3')).toThrow();
  });
});

describe('applyRate', () => {
  it('applies a tax rate with half-up rounding', () => {
    // 100.00 at 8.25% = 8.25
    expect(applyRate(10000n, '0.0825')).toBe(825n);
    // 33.33 at 8.25% = 2.7497... -> 2.75
    expect(applyRate(3333n, '0.0825')).toBe(275n);
  });

  it('rounds exactly at the half cent, away from zero on both signs', () => {
    // 1.00 at 0.5% = 0.5 cents -> 1 cent
    expect(applyRate(100n, '0.005')).toBe(1n);
    expect(applyRate(-100n, '0.005')).toBe(-1n);
  });

  it('never loses precision on rates a float would mangle', () => {
    // 0.1 + 0.2 territory: 1,234,567.89 at 7.25%
    expect(applyRate(123456789n, '0.0725')).toBe(8950617n);
  });
});

describe('multiplyQuantity', () => {
  it('handles fractional hours and quantities', () => {
    expect(multiplyQuantity(2800n, '2.5')).toBe(7000n);
    expect(multiplyQuantity(1999n, '3')).toBe(5997n);
    expect(multiplyQuantity(1000n, '0.333')).toBe(333n);
  });

  it('rounds half-up', () => {
    // 10.01 x 1.5 = 15.015 -> 15.02
    expect(multiplyQuantity(1001n, '1.5')).toBe(1502n);
  });
});

describe('allocate', () => {
  it('distributes a remainder so the parts sum to the whole exactly', () => {
    const parts = allocate(1000n, [1n, 1n, 1n]);
    expect(sum(parts)).toBe(1000n);
    expect(parts).toEqual([334n, 333n, 333n]);
  });

  it('weights the split and still loses no cent', () => {
    const parts = allocate(10000n, [7000n, 2000n, 1000n]);
    expect(sum(parts)).toBe(10000n);
    expect(parts).toEqual([7000n, 2000n, 1000n]);
  });

  it('splits evenly when there are no weights to go on', () => {
    const parts = allocate(100n, [0n, 0n, 0n]);
    expect(sum(parts)).toBe(100n);
  });

  it('handles a negative amount without inventing a cent', () => {
    const parts = allocate(-1000n, [1n, 1n, 1n]);
    expect(sum(parts)).toBe(-1000n);
  });
});

describe('formatMoney', () => {
  it('groups thousands and shows negatives in parentheses', () => {
    expect(formatMoney(123456n)).toBe('1,234.56');
    expect(formatMoney(-123456n)).toBe('(1,234.56)');
    expect(formatMoney(5n)).toBe('0.05');
    expect(formatMoney(100000000n)).toBe('1,000,000.00');
  });
});
