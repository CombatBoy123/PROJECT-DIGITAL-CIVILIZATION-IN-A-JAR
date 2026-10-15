import { describe, expect, it } from 'vitest';
import { Simulation, StateRestoreError, type WorldState } from '../src/index.js';
import { cloneState, newSimulation } from './helpers.js';

const TICKS = 24 * 10;

describe('determinism', () => {
  it('same seed and configuration ⇒ identical state hash, events and metrics', () => {
    const a = newSimulation('repeatable');
    const b = newSimulation('repeatable');
    expect(a.simulation.hash()).toBe(b.simulation.hash());
    const ra = a.simulation.run(TICKS);
    const rb = b.simulation.run(TICKS);
    expect(a.simulation.hash()).toBe(b.simulation.hash());
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });

  it('different seeds ⇒ different worlds and trajectories', () => {
    const a = newSimulation('seed-a').simulation;
    const b = newSimulation('seed-b').simulation;
    a.run(TICKS);
    b.run(TICKS);
    expect(a.hash()).not.toBe(b.hash());
  });

  it('configuration changes results (population)', () => {
    const a = newSimulation('cfg', { population: 60 }).simulation;
    const b = newSimulation('cfg', { population: 61 }).simulation;
    expect(a.hash()).not.toBe(b.hash());
  });

  it('with stochastic weather disabled, weather is always clear and the run is still repeatable', () => {
    const a = newSimulation('calm', { stochastic: { weather: false } }).simulation;
    const results = a.run(TICKS);
    expect(results.flatMap((r) => r.events).some((e) => e.type === 'WeatherChanged')).toBe(false);
    expect(a.state.environment.weather).toBe('clear');
    const b = newSimulation('calm', { stochastic: { weather: false } }).simulation;
    b.run(TICKS);
    expect(a.hash()).toBe(b.hash());
  });
});

describe('save and restore', () => {
  it('restoring a serialised state reproduces its hash exactly', () => {
    const { simulation } = newSimulation('snap');
    simulation.run(100);
    const json = simulation.serialize();
    const hash = simulation.hash();
    const restored = Simulation.deserialize(json, hash);
    expect(restored.hash()).toBe(hash);
    expect(restored.tick).toBe(100);
  });

  it('a restored snapshot continues exactly like the original run', () => {
    const original = newSimulation('continue').simulation;
    original.run(77);
    const snapshot = original.serialize();
    const snapshotHash = original.hash();
    const continued = original.run(150);

    const restored = Simulation.deserialize(snapshot, snapshotHash);
    const replayed = restored.run(150);
    expect(restored.hash()).toBe(original.hash());
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(continued));
  });

  it('rejects a state whose hash does not match', () => {
    const { simulation } = newSimulation('tamper');
    const state = cloneState(simulation);
    state.citizens[0]!.balanceCents += 1;
    expect(() => Simulation.deserialize(JSON.stringify(state), simulation.hash())).toThrow(
      StateRestoreError,
    );
  });

  it('rejects structurally invalid state', () => {
    const { simulation } = newSimulation('invalid');
    const state = cloneState(simulation) as unknown as Record<string, unknown>;
    (state.citizens as Array<Record<string, unknown>>)[0]!.needs = { energy: 'full' };
    expect(() => Simulation.deserialize(JSON.stringify(state))).toThrow(StateRestoreError);
    expect(() => Simulation.deserialize('{"schemaVersion":999}')).toThrow(/schema version/);
    expect(() => Simulation.deserialize('not json')).toThrow(StateRestoreError);
  });

  it('rejects unknown properties instead of silently dropping them', () => {
    const { simulation } = newSimulation('extra');
    const state = cloneState(simulation) as WorldState & { injected?: string };
    state.injected = 'x';
    expect(() => Simulation.deserialize(JSON.stringify(state))).toThrow(StateRestoreError);
  });

  it('rejects seeds that creation would refuse, such as the random-stream key separator', () => {
    const { simulation } = newSimulation('seed');
    for (const seed of ['seed\u001fweather', 'with space', '']) {
      const state = cloneState(simulation);
      state.seed = seed;
      expect(() => Simulation.create(seed)).toThrow();
      expect(() => Simulation.deserialize(JSON.stringify(state))).toThrow(StateRestoreError);
    }
  });

  it('fromState deep-copies so later mutation of the input has no effect', () => {
    const { simulation } = newSimulation('alias');
    const state = cloneState(simulation);
    const copy = Simulation.fromState(state);
    const before = copy.hash();
    state.citizens[0]!.firstName = 'Changed';
    expect(copy.hash()).toBe(before);
  });

  it('canonical serialisation is independent of property insertion order', () => {
    const { simulation } = newSimulation('order');
    const state = cloneState(simulation);
    const reordered = Object.fromEntries(Object.entries(state).reverse()) as WorldState;
    expect(Simulation.fromState(reordered).hash()).toBe(simulation.hash());
  });
});
