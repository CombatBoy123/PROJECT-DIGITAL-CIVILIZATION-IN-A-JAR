import { buildFrame, Simulation, type CitizenFrameTuple } from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import { FrameStore } from '../world/frame-store';
import { DEFAULT_SETTINGS, DemoEngine } from './engine';

/** State hash of seed "demo-1", 100 citizens, at tick 24 (docs/EXPERIMENTS.md). */
const DOCUMENTED_TICK_24_HASH = 'cc32f72331d7ee6df5eb05e6ca31ffb8';

function fakeClock() {
  let t = 0;
  return () => (t += 16);
}

function engine(options: { eventCapacity?: number } = {}) {
  return new DemoEngine(DEFAULT_SETTINGS, { now: fakeClock(), ...options });
}

function sortedTuples(frames: FrameStore): CitizenFrameTuple[] {
  const state = frames.state;
  if (!state) throw new Error('FrameStore has no keyframe');
  return [...state.citizens.values()].sort((a, b) => a[0] - b[0]);
}

describe('DemoEngine', () => {
  it('reaches the documented demo-1 hash at tick 24', () => {
    const e = engine();
    expect(e.step(24)).toBe(24);
    expect(e.tick).toBe(24);
    expect(e.fingerprint()).toBe(DOCUMENTED_TICK_24_HASH);
  });

  it('is deterministic: two controllers with the same seed and config agree', () => {
    const a = engine();
    const b = engine();
    a.step(30);
    for (let i = 0; i < 30; i++) b.step(1);
    expect(a.fingerprint()).toBe(b.fingerprint());
    expect(a.metrics).toEqual(b.metrics);
  });

  it('matches the plain engine after the same number of ticks', () => {
    const e = engine();
    e.step(13);
    const { simulation } = Simulation.create('demo-1', { population: 100 });
    simulation.run(13);
    expect(e.fingerprint()).toBe(simulation.hash());
  });

  it('restores the save point exactly and continues identically', () => {
    const e = engine();
    e.step(10);
    const saved = e.savePoint();
    expect(saved?.tick).toBe(10);
    e.step(30);
    const continued = e.fingerprint();
    expect(e.restore()).toBe(true);
    expect(e.tick).toBe(10);
    expect(e.fingerprint()).toBe(saved?.hash);
    e.step(30);
    expect(e.fingerprint()).toBe(continued);
  });

  it('restore without a save point does nothing', () => {
    const e = engine();
    e.step(3);
    expect(e.restore()).toBe(false);
    expect(e.tick).toBe(3);
  });

  it('resets to genesis with the same seed and keeps the save point', () => {
    const e = engine();
    const genesis = e.fingerprint();
    e.step(5);
    e.savePoint();
    e.step(5);
    e.resetToGenesis();
    expect(e.tick).toBe(0);
    expect(e.fingerprint()).toBe(genesis);
    expect(e.savePointInfo?.tick).toBe(5);
  });

  it('creating a new world validates input and leaves the old world on error', () => {
    const e = engine();
    e.step(2);
    expect(() => e.create({ seed: 'bad seed!', config: { population: 100 } })).toThrow();
    expect(() => e.create({ seed: 'ok', config: { population: 3 } })).toThrow();
    expect(e.tick).toBe(2);
    e.create({ seed: 'other', config: { population: 20, stochastic: { weather: false } } });
    expect(e.tick).toBe(0);
    expect(e.state.citizens).toHaveLength(20);
    expect(e.savePointInfo).toBeNull();
  });

  it('keeps the event ring bounded, newest last', () => {
    const e = engine({ eventCapacity: 25 });
    expect(e.events.length).toBe(25);
    e.step(24 * 8);
    expect(e.events.length).toBeLessThanOrEqual(25);
    const seqs = e.events.map((ev) => ev.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(seqs[seqs.length - 1]).toBe(e.state.nextEventSeq - 1);
  });

  it('feeds deltas that keep the FrameStore equal to buildFrame(state)', () => {
    const e = engine();
    const check = () => {
      const frame = buildFrame(e.state);
      expect(sortedTuples(e.frames)).toEqual(frame.citizens);
      expect(e.frames.state?.tick).toBe(frame.tick);
      expect(e.frames.state?.weather).toBe(frame.weather);
      expect(e.frames.state?.temperatureC).toBe(frame.temperatureC);
    };
    check();
    for (const n of [1, 1, 3, 7, 24, 2]) {
      e.step(n);
      check();
    }
    e.savePoint();
    e.step(5);
    e.restore();
    check();
  });

  it('sends only changed citizens in a delta', () => {
    const frames = new FrameStore();
    const applied: number[] = [];
    const original = frames.applyDelta.bind(frames);
    frames.applyDelta = (header, changed, now) => {
      applied.push(changed.length);
      return original(header, changed, now);
    };
    const e = new DemoEngine(DEFAULT_SETTINGS, { now: fakeClock(), frames });
    e.step(1); // 00:00 → 01:00: everyone keeps sleeping
    expect(applied).toEqual([0]);
  });

  it('halts on an invariant violation and surfaces the message', () => {
    const e = engine();
    e.setRunning(true);
    expect(e.running).toBe(true);
    // Corrupt the state: money appears from nowhere (conservation invariant).
    const citizen = e.state.citizens[0] as { balanceCents: number };
    citizen.balanceCents += 1;
    expect(e.step(5)).toBe(0);
    expect(e.halted).toMatch(/Invariant violation at tick 1/);
    expect(e.running).toBe(false);
    expect(e.step(1)).toBe(0);
    e.resetToGenesis();
    expect(e.halted).toBeNull();
    expect(e.step(1)).toBe(1);
  });

  it('notifies subscribers on change', () => {
    const e = engine();
    let calls = 0;
    const off = e.subscribe(() => calls++);
    e.step(1);
    e.setRunning(true);
    off();
    e.step(1);
    expect(calls).toBe(2);
  });
});
