import { Simulation } from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import {
  eventsAbout,
  householdMembers,
  presentAt,
  residentsOf,
  searchCitizens,
  validateWorldForm,
  whereabouts,
} from './describe';

const { simulation, genesis } = Simulation.create('demo-1', { population: 100 });
simulation.run(12);
const state = simulation.state;

describe('demo read helpers', () => {
  it('searches names by every word, case-insensitively', () => {
    const c = state.citizens[0];
    if (!c) throw new Error('no citizens');
    const hits = searchCitizens(state.citizens, `${c.lastName.toUpperCase()} ${c.firstName}`);
    expect(hits.map((h) => h.id)).toContain(c.id);
    expect(searchCitizens(state.citizens, '  ')).toHaveLength(state.citizens.length);
    expect(searchCitizens(state.citizens, 'zzzz-nobody')).toHaveLength(0);
  });

  it('describes where a citizen is', () => {
    for (const c of state.citizens) {
      const w = whereabouts(c);
      if (c.locationId !== null) expect(w).toEqual({ kind: 'in', buildingId: c.locationId });
      else expect(w.kind).toBe('travelling');
    }
  });

  it('relates households, residents and people present', () => {
    const c = state.citizens[0];
    if (!c) throw new Error('no citizens');
    const members = householdMembers(c, state);
    expect(members.every((m) => m.householdId === c.householdId && m.id !== c.id)).toBe(true);
    expect(residentsOf(c.homeId, state).map((r) => r.id)).toContain(c.id);
    const total = state.buildings.reduce((n, b) => n + presentAt(b.id, state).length, 0);
    expect(total).toBe(state.citizens.filter((x) => x.locationId !== null).length);
  });

  it('filters events by entity, newest first', () => {
    const c = state.citizens[3];
    if (!c) throw new Error('no citizens');
    const mine = eventsAbout(genesis.events, 'citizen', c.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.refs.some((r) => r.kind === 'citizen' && r.id === c.id))).toBe(true);
    const seqs = mine.map((e) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
  });

  it('validates the new-world form with the engine schemas and the demo cap', () => {
    const base = { seed: 'demo-1', population: '100', daysPerSeason: '7', stochasticWeather: true };
    expect(validateWorldForm(base)).toEqual({
      ok: true,
      seed: 'demo-1',
      config: { population: 100, daysPerSeason: 7, stochastic: { weather: true } },
    });
    const bad = validateWorldForm({
      ...base,
      seed: 'no spaces',
      population: '1001',
      daysPerSeason: '',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.seed).toMatch(/letters, digits/);
    expect(validateWorldForm({ ...base, seed: 'x'.repeat(65) }).ok).toBe(false);
    const long = validateWorldForm({ ...base, seed: 'x'.repeat(65) });
    expect(!long.ok && long.errors.seed).toBe('Use at most 64 characters.');
    expect(bad.errors.population).toBe('Enter a whole number from 10 to 1,000.');
    expect(bad.errors.daysPerSeason).toBe('Enter a whole number from 1 to 60.');
    const small = validateWorldForm({ ...base, seed: '', population: '9.5' });
    expect(small.ok ? null : small.errors).toEqual({
      seed: 'Enter a seed.',
      population: 'Enter a whole number from 10 to 1,000.',
    });
  });
});
