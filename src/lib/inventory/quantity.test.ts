import { describe, expect, it } from 'vitest';
import { fromMilli, toMilli, unitCostOf, valueOf } from './quantity';

describe('quantity conversion', () => {
  it('round-trips three decimal places', () => {
    expect(toMilli('1')).toBe(1000n);
    expect(toMilli('2.5')).toBe(2500n);
    expect(toMilli('0.125')).toBe(125n);
    expect(fromMilli(2500n)).toBe('2.500');
    expect(fromMilli(125n)).toBe('0.125');
  });

  it('handles negative quantities, which is how a shortage is expressed', () => {
    expect(toMilli('-3')).toBe(-3000n);
    expect(fromMilli(-3000n)).toBe('-3.000');
  });

  it('refuses more precision than it can store, instead of silently truncating', () => {
    expect(() => toMilli('1.2345')).toThrow(/three decimal places/);
  });

  it('refuses a value that is not a number', () => {
    expect(() => toMilli('abc')).toThrow();
  });
});

describe('valueOf', () => {
  it('values a fractional quantity, rounding half-up', () => {
    expect(valueOf(2500n, 4056n)).toBe(10140n); // 2.5 @ 40.56
    expect(valueOf(3000n, 420n)).toBe(1260n); // 3 @ 4.20
    // 0.333 @ 10.00 = 3.33
    expect(valueOf(333n, 1000n)).toBe(333n);
  });

  it('rounds exactly at the half cent', () => {
    // 1.5 @ 0.01 = 0.015 -> 0.02
    expect(valueOf(1500n, 1n)).toBe(2n);
  });
});

describe('unitCostOf', () => {
  it('derives the average from value and quantity', () => {
    expect(unitCostOf(10140n, 2500n)).toBe(4056n);
    expect(unitCostOf(1260n, 3000n)).toBe(420n);
  });

  it('returns zero for an empty bin rather than dividing by zero', () => {
    expect(unitCostOf(0n, 0n)).toBe(0n);
  });

  it('rounds the derived average half-up', () => {
    // 10.00 over 3 units = 3.3333 -> 3.33
    expect(unitCostOf(1000n, 3000n)).toBe(333n);
  });
});
