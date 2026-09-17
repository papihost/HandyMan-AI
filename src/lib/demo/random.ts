/**
 * Deterministic pseudo-randomness.
 *
 * The demo has to be reproducible: a salesperson who points at "Marcus Deleon's callback
 * rate is 6.2%" needs that to still be true after the next reset, and a bug that only
 * appears in one seeded dataset needs to be reproducible from the seed number alone.
 * Math.random would make both impossible.
 *
 * mulberry32 — small, fast, good enough distribution for generating plausible business
 * data. It is not, and must never be used as, a source of cryptographic randomness.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Pick by relative weight. Weights need not sum to anything in particular. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((t, [, w]) => t + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /**
   * Roughly normal, clamped. Real business quantities cluster around a middle and this
   * keeps generated data from looking suspiciously uniform on a chart.
   */
  normal(mean: number, stdDev: number, min: number, max: number): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.min(max, Math.max(min, mean + z * stdDev));
  }
}
