import { describe, expect, it } from 'vitest';
import { digitsForStep, labelMarkers, niceStep, niceTicks, valueAxis } from './chart-axis';

const labels = (unit: Parameters<typeof valueAxis>[0], values: number[]) => {
  const axis = valueAxis(unit, values);
  if (!axis) throw new Error('no axis');
  return axis.ticks.map(axis.format);
};

const distinct = (xs: string[]) => new Set(xs).size === xs.length;

describe('nice ticks', () => {
  it('rounds steps up to 1, 2, 2.5 or 5 × 10^k', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(4432)).toBe(5000);
    expect(niceStep(0)).toBe(1);
    // Whole steps only: never 0.5 or 2.5 of a person.
    expect(niceStep(0.5, true)).toBe(1);
    expect(niceStep(2.2, true)).toBe(5);
    expect(niceStep(22, true)).toBe(25);
  });

  it('counts the fraction digits a step needs', () => {
    expect(digitsForStep(5000)).toBe(0);
    expect(digitsForStep(0.25)).toBe(2);
    expect(digitsForStep(0.1 + 0.2)).toBe(1);
  });

  it('covers the data with evenly spaced ticks', () => {
    expect(niceTicks(3, 97, 4)).toEqual({ step: 25, ticks: [0, 25, 50, 75, 100] });
    expect(niceTicks(0.1, 0.3, 4).ticks).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
  });
});

describe('valueAxis', () => {
  it('gives a constant money series distinct labels around its value', () => {
    const ticks = labels('cents', [17_728_792, 17_728_792, 17_728_792]);
    expect(distinct(ticks)).toBe(true);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const axis = valueAxis('cents', [17_728_792]);
    expect(axis?.domain[0]).toBeLessThan(17_728_792);
    expect(axis?.domain[1]).toBeGreaterThan(17_728_792);
  });

  it('keeps narrow ranges distinguishable (no repeated labels)', () => {
    expect(distinct(labels('cents', [120_000, 125_000, 131_000, 140_000]))).toBe(true);
    expect(distinct(labels('persons', [2000, 2000, 2000]))).toBe(true);
    expect(distinct(labels('persons', [1150, 1180, 1200]))).toBe(true);
    expect(distinct(labels('cents', [65_090_000, 65_091_000]))).toBe(true);
  });

  it('never extends a share beyond 0–100 %, and spells out small shares', () => {
    expect(labels('ratio', [0, 0, 0])).toEqual(['0%', '25%', '50%', '75%', '100%']);
    expect(valueAxis('ratio', [0, 0])?.domain).toEqual([0, 1]);
    const small = labels('ratio', [0, 0.002, 0.0005]);
    expect(distinct(small)).toBe(true);
    expect(small[0]).toBe('0.00%');
    expect(small[small.length - 1]).toBe('0.20%');
    expect(valueAxis('ratio', [0.2, 1])?.domain).toEqual([0, 1]);
  });

  it('does not pad a non-negative constant below zero', () => {
    expect(valueAxis('persons', [0, 0])?.domain[0]).toBe(0);
  });

  it('returns null without finite values', () => {
    expect(valueAxis('persons', [])).toBeNull();
    expect(valueAxis('persons', [Number.NaN])).toBeNull();
  });

  it('uses whole steps for ordinal codes and head counts', () => {
    expect(valueAxis('code', [0, 1])?.ticks.every(Number.isInteger)).toBe(true);
    expect(valueAxis('persons', [20, 20])?.ticks).toEqual([19, 20, 21]);
    expect(valueAxis('persons', [1, 1])?.ticks).toEqual([0, 1, 2]);
    expect(valueAxis('persons', [0, 3, 10])?.ticks.every(Number.isInteger)).toBe(true);
  });
});

describe('labelMarkers', () => {
  const markers = Array.from({ length: 21 }, (_, i) => ({
    tick: i * 72,
    label: `${['Spring', 'Summer', 'Autumn', 'Winter'][i % 4]} Y${Math.floor(i / 4) + 1}`,
  }));

  it('labels only markers whose text does not overlap the previous label', () => {
    const width = 300;
    const result = labelMarkers(markers, [0, 1440], width, { charPx: 6, gapPx: 8 });
    expect(result).toHaveLength(21);
    const kept = result.filter((r) => r.labelled);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(21);
    let lastEnd = -Infinity;
    for (const { marker } of kept) {
      const x = (marker.tick / 1440) * width;
      const half = (marker.label.length * 6) / 2;
      expect(x - half).toBeGreaterThanOrEqual(lastEnd + 8);
      expect(x + half).toBeLessThanOrEqual(width);
      lastEnd = x + half;
    }
  });

  it('labels everything that fits on a wide chart and nothing without a width', () => {
    const few = markers.slice(1, 4);
    expect(labelMarkers(few, [0, 300], 2000).every((r) => r.labelled)).toBe(true);
    expect(labelMarkers(few, [0, 300], 0).some((r) => r.labelled)).toBe(false);
  });
});
