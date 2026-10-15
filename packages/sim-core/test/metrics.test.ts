import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  gini,
  mean,
  median,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
} from '../src/index.js';
import { cloneState, newSimulation } from './helpers.js';

describe('statistics', () => {
  it('median handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('mean of empty input is 0', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it('gini matches known values', () => {
    expect(gini([5, 5, 5, 5])).toBe(0);
    // One person holds everything: (n − 1) / n.
    expect(gini([0, 0, 0, 10])).toBeCloseTo(0.75, 12);
    // Hand-computed: x = [1,2,3,4], Σ(2i−n−1)x = (−3)(1)+(−1)(2)+(1)(3)+(3)(4) = 10, n·Σx = 40.
    expect(gini([4, 1, 3, 2])).toBeCloseTo(0.25, 12);
    expect(gini([0, 0])).toBe(0);
    expect(gini([7])).toBe(0);
    expect(() => gini([1, -1])).toThrow(RangeError);
  });
});

describe('metric registry', () => {
  it('every metric has a unique key and a definition', () => {
    expect(new Set(METRIC_KEYS).size).toBe(METRIC_DEFINITIONS.length);
    for (const d of METRIC_DEFINITIONS) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.formula.length).toBeGreaterThan(3);
    }
  });

  it('computeMetrics returns exactly the registered keys with finite values', () => {
    const { simulation } = newSimulation('metrics');
    const values = computeMetrics(cloneState(simulation));
    expect(Object.keys(values).sort()).toEqual([...METRIC_KEYS].sort());
    for (const v of Object.values(values)) expect(Number.isFinite(v)).toBe(true);
  });

  it('activity counts and life-stage counts each sum to the population', () => {
    const { simulation } = newSimulation('sums');
    for (const r of simulation.run(48)) {
      const v = r.metrics!.values;
      expect(
        v['activity.sleeping'] +
          v['activity.atHome'] +
          v['activity.leisure'] +
          v['activity.traveling'],
      ).toBe(v['population.total']);
      expect(v['population.children'] + v['population.adults'] + v['population.elders']).toBe(
        v['population.total'],
      );
    }
  });

  it('money supply is conserved and equals cumulative issuance (no flows exist in Phase 1)', () => {
    const { simulation, genesis } = newSimulation('conservation');
    const initial = genesis.metrics!.values['money.supply'];
    expect(initial).toBe(genesis.metrics!.values['money.issuedCumulative']);
    for (const r of simulation.run(24 * 7)) {
      expect(r.metrics!.values['money.supply']).toBe(initial);
    }
  });

  it('samples only every metricsInterval ticks', () => {
    const { simulation } = newSimulation('interval', { metricsInterval: 6 });
    const sampled = simulation
      .run(24)
      .filter((r) => r.metrics !== null)
      .map((r) => r.tick);
    expect(sampled).toEqual([6, 12, 18, 24]);
  });
});
