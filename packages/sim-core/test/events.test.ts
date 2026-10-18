import { describe, expect, it } from 'vitest';
import { buildFrame, EVENT_CATALOG, EVENT_TYPES } from '../src/index.js';
import { newSimulation } from './helpers.js';

describe('event ordering', () => {
  it('sequence numbers are strictly increasing and contiguous across ticks, ticks non-decreasing', () => {
    const { simulation, genesis } = newSimulation('ordering');
    const all = [...genesis.events, ...simulation.run(24 * 28).flatMap((r) => r.events)];
    for (let i = 0; i < all.length; i++) {
      expect(all[i]!.seq).toBe(i + 1);
      if (i > 0) expect(all[i]!.tick).toBeGreaterThanOrEqual(all[i - 1]!.tick);
    }
    expect(simulation.state.nextEventSeq).toBe(all.length + 1);
  });

  it('events are stamped with the tick that produced them', () => {
    const { simulation } = newSimulation('stamps');
    for (const r of simulation.run(100)) for (const e of r.events) expect(e.tick).toBe(r.tick);
  });

  it('every event type has catalogue metadata', () => {
    for (const type of EVENT_TYPES) expect(EVENT_CATALOG[type].label.length).toBeGreaterThan(0);
  });

  it('event payloads are plain JSON data', () => {
    const { simulation, genesis } = newSimulation('json');
    const all = [...genesis.events, ...simulation.run(200).flatMap((r) => r.events)];
    expect(JSON.parse(JSON.stringify(all))).toEqual(all);
  });
});

describe('frames', () => {
  it('encode each citizen position compactly and consistently with state', () => {
    const { simulation } = newSimulation('frames');
    simulation.run(24 + 15);
    const frame = buildFrame(simulation.state);
    expect(frame.citizens).toHaveLength(simulation.state.citizens.length);
    for (const [id, activity, location, from, to, depart, arrive] of frame.citizens) {
      const c = simulation.index.citizens.get(id)!;
      expect(location).toBe(c.locationId ?? 0);
      if (activity === 3) {
        expect([from, to, depart, arrive]).toEqual([
          c.travel!.fromId,
          c.travel!.toId,
          c.travel!.departTick,
          c.travel!.arriveTick,
        ]);
      } else {
        expect([from, to, depart, arrive]).toEqual([0, 0, 0, 0]);
      }
    }
  });
});
