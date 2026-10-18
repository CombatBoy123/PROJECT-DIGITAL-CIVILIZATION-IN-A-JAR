import { Simulation, type WorldState } from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import { ProjectionTracker, type ProjectionDelta } from '../src/persistence/projections.js';

/** Projection tables as a database would hold them after applying deltas. */
class Tables {
  readonly buildings = new Map<number, unknown[]>();
  readonly households = new Map<number, unknown[]>();
  readonly citizens = new Map<number, unknown[]>();
  readonly skills = new Map<string, unknown[]>();

  apply(delta: ProjectionDelta): void {
    if (delta.full) {
      this.buildings.clear();
      this.households.clear();
      this.citizens.clear();
      this.skills.clear();
    }
    for (const row of delta.buildings) this.buildings.set(row[0] as number, row);
    for (const row of delta.households) this.households.set(row[0] as number, row);
    for (const row of delta.citizens) this.citizens.set(row[0] as number, row);
    for (const row of delta.skills) this.skills.set(`${String(row[0])}:${String(row[1])}`, row);
    for (const id of delta.removed.buildings) this.buildings.delete(id);
    for (const id of delta.removed.households) this.households.delete(id);
    for (const id of delta.removed.citizens) {
      this.citizens.delete(id);
      // ON DELETE CASCADE
      for (const key of [...this.skills.keys()]) {
        if (key.startsWith(`${id}:`)) this.skills.delete(key);
      }
    }
  }

  snapshot() {
    const sorted = (m: Map<number | string, unknown[]>) =>
      [...m.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
    return {
      buildings: sorted(this.buildings),
      households: sorted(this.households),
      citizens: sorted(this.citizens),
      skills: sorted(this.skills),
    };
  }
}

/** What a full rebuild of `state` writes. */
function rebuilt(state: WorldState) {
  const tables = new Tables();
  tables.apply(new ProjectionTracker().delta(state, true));
  return tables.snapshot();
}

describe('ProjectionTracker', () => {
  it('incremental deltas keep the tables equal to a full rebuild', () => {
    const { simulation } = Simulation.create('projection-seed', { population: 60 });
    const tracker = new ProjectionTracker();
    const tables = new Tables();
    tables.apply(tracker.delta(simulation.state));
    for (let round = 0; round < 12; round++) {
      simulation.run(7);
      const delta = tracker.delta(simulation.state);
      expect(delta.full).toBe(false);
      tables.apply(delta);
      expect(tables.snapshot()).toEqual(rebuilt(simulation.state as WorldState));
    }
    // Nothing changed: nothing is rewritten.
    const idle = tracker.delta(simulation.state);
    expect([idle.buildings, idle.households, idle.citizens, idle.skills]).toEqual([[], [], [], []]);
  });

  it('reports removals even when as many entities were added in the same interval', () => {
    const { simulation } = Simulation.create('projection-seed', { population: 20 });
    const state = structuredClone(simulation.state) as WorldState;
    const tracker = new ProjectionTracker();
    const tables = new Tables();
    tables.apply(tracker.delta(state));

    // One citizen leaves and another arrives: the counts are unchanged.
    const [gone, ...rest] = state.citizens;
    const newcomer = { ...structuredClone(rest[0]!), id: 10_000, firstName: 'Newcomer' };
    newcomer.skills = { ...newcomer.skills };
    const firstSkill = Object.keys(newcomer.skills)[0] as keyof typeof newcomer.skills;
    newcomer.skills[firstSkill] += 1;
    state.citizens = [...rest, newcomer];
    // One household is replaced the same way.
    const [oldHousehold, ...households] = state.households;
    state.households = [...households, { ...oldHousehold!, id: 10_000 }];

    const delta = tracker.delta(state);
    expect(delta.removed.citizens).toEqual([gone!.id]);
    expect(delta.removed.households).toEqual([oldHousehold!.id]);
    expect(delta.citizens.map((r) => r[0])).toEqual([10_000]);
    expect(delta.households.map((r) => r[0])).toEqual([10_000]);
    tables.apply(delta);
    expect(tables.snapshot()).toEqual(rebuilt(state));

    // A skill change alone rewrites exactly that skill row.
    newcomer.skills[firstSkill] += 1;
    const skillOnly = tracker.delta(state);
    expect(skillOnly.citizens).toEqual([]);
    expect(skillOnly.skills).toHaveLength(1);
    expect(skillOnly.skills[0]![0]).toBe(10_000);
    tables.apply(skillOnly);
    expect(tables.snapshot()).toEqual(rebuilt(state));
  });

  it('rebuilds everything after invalidate()', () => {
    const { simulation } = Simulation.create('projection-seed', { population: 10 });
    const tracker = new ProjectionTracker();
    tracker.delta(simulation.state);
    tracker.invalidate();
    const delta = tracker.delta(simulation.state);
    expect(delta.full).toBe(true);
    expect(delta.citizens).toHaveLength(simulation.state.citizens.length);
  });
});
