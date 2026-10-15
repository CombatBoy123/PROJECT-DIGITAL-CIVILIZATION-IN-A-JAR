import { describe, expect, it } from 'vitest';
import { cyrb128, hashString, Rng, rngFor } from '../src/index.js';

describe('hash', () => {
  it('is deterministic and sensitive to input', () => {
    expect(hashString('civilization')).toBe(hashString('civilization'));
    expect(hashString('civilization')).not.toBe(hashString('civilizatioN'));
    expect(hashString('')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('matches a known reference value (guards against accidental algorithm changes)', () => {
    expect(cyrb128('jar')).toEqual(cyrb128('jar'));
    expect(hashString('Digital Civilization in a Jar')).toMatchInlineSnapshot(
      `"7a6b150f60de93c0519faa93d54e7f19"`,
    );
  });
});

describe('Rng', () => {
  it('reproduces the same sequence for the same key', () => {
    const a = rngFor('seed', 'routine', 10, 3);
    const b = rngFor('seed', 'routine', 10, 3);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('produces different sequences for different keys', () => {
    const a = rngFor('seed', 'routine', 10, 3);
    const b = rngFor('seed', 'routine', 10, 4);
    const sa = Array.from({ length: 8 }, () => a.nextUint32());
    const sb = Array.from({ length: 8 }, () => b.nextUint32());
    expect(sa).not.toEqual(sb);
  });

  it('distinguishes key boundaries ("1","23" vs "12","3")', () => {
    expect(rngFor('s', '1', '23').next()).not.toBe(rngFor('s', '12', '3').next());
  });

  it('next() is uniform on [0,1) (coarse histogram check)', () => {
    const rng = new Rng(cyrb128('uniformity'));
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      buckets[Math.floor(x * 10)]! += 1;
    }
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n / 100);
  });

  it('int() covers the inclusive range and rejects invalid ranges', () => {
    const rng = rngFor('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rng.int(2, 5));
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
    expect(() => rng.int(5, 2)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it('weightedIndex follows weights and skips zero weights', () => {
    const rng = rngFor('weights');
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) counts[rng.weightedIndex([1, 0, 3])]! += 1;
    expect(counts[1]).toBe(0);
    expect(counts[2]! / counts[0]!).toBeGreaterThan(2.7);
    expect(counts[2]! / counts[0]!).toBeLessThan(3.3);
    expect(rng.weightedIndex([0, 0])).toBe(-1);
    expect(() => rng.weightedIndex([1, -1])).toThrow(RangeError);
  });

  it('normal() has the requested mean and standard deviation', () => {
    const rng = rngFor('normal');
    const n = 50_000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const x = rng.normal(10, 2);
      s += x;
      s2 += x * x;
    }
    const mean = s / n;
    const sd = Math.sqrt(s2 / n - mean * mean);
    expect(mean).toBeCloseTo(10, 1);
    expect(sd).toBeCloseTo(2, 1);
  });

  it('chance() handles the edges exactly', () => {
    const rng = rngFor('chance');
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(-1)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });
});
