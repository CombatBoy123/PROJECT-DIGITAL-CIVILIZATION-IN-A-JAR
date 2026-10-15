import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  checkInvariants,
  generateWorld,
  hashState,
  isRoad,
  lifeStageForAge,
  parseConfig,
} from '../src/index.js';

describe('world generation', () => {
  const config = parseConfig({ population: 120 });
  const { state, events } = generateWorld('genesis-seed', config);

  it('creates exactly the configured population at tick 0', () => {
    expect(state.tick).toBe(0);
    expect(state.citizens).toHaveLength(120);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    expect(hashState(generateWorld('genesis-seed', config).state)).toBe(hashState(state));
    expect(hashState(generateWorld('other-seed', config).state)).not.toBe(hashState(state));
  });

  it('produces a state that satisfies every invariant', () => {
    expect(checkInvariants(state)).toEqual([]);
  });

  it('houses every household in its own house within capacity, with some vacancies', () => {
    const houses = state.buildings.filter((b) => b.kind === 'house');
    const homes = new Set(state.households.map((h) => h.homeId));
    expect(homes.size).toBe(state.households.length);
    expect(houses.length).toBeGreaterThan(state.households.length);
    for (const h of state.households) {
      const members = state.citizens.filter((c) => c.householdId === h.id);
      expect(members.length).toBeGreaterThan(0);
      const home = state.buildings.find((b) => b.id === h.homeId)!;
      expect(members.length).toBeLessThanOrEqual(home.capacity);
      for (const m of members) expect(m.homeId).toBe(h.homeId);
    }
  });

  it('gives every household at least one adult and keeps children younger than their parents', () => {
    for (const h of state.households) {
      const members = state.citizens.filter((c) => c.householdId === h.id);
      expect(members.some((m) => m.lifeStage !== 'child')).toBe(true);
      const oldest = Math.min(...members.map((m) => m.birthTick));
      for (const child of members.filter((m) => m.lifeStage === 'child')) {
        expect(child.birthTick).toBeGreaterThan(oldest);
      }
    }
  });

  it('assigns life stages consistent with ages', () => {
    for (const c of state.citizens) {
      expect(c.lifeStage).toBe(lifeStageForAge(ageInYears(c, 0, config), config));
    }
  });

  it('gives children no money and adults a positive endowment', () => {
    for (const c of state.citizens) {
      if (c.lifeStage === 'child') expect(c.balanceCents).toBe(0);
      else expect(c.balanceCents).toBeGreaterThan(0);
    }
  });

  it('places public venues and puts every door on a road', () => {
    expect(state.buildings.filter((b) => b.kind === 'plaza').length).toBeGreaterThanOrEqual(1);
    expect(state.buildings.filter((b) => b.kind === 'park').length).toBeGreaterThanOrEqual(1);
    for (const b of state.buildings) expect(isRoad(state.map, b.door.x, b.door.y)).toBe(true);
  });

  it('zones blocks for all land uses', () => {
    const zones = new Set(state.map.blocks.map((b) => b.zone));
    expect(zones).toEqual(new Set(['civic', 'commercial', 'residential', 'farmland']));
  });

  it('records money creation explicitly: issued total equals the sum of MoneyIssued events', () => {
    const issued = events
      .filter((e) => e.type === 'MoneyIssued')
      .reduce((sum, e) => sum + (e.type === 'MoneyIssued' ? e.payload.amountCents : 0), 0);
    expect(issued).toBe(state.ledger.issuedCents);
    expect(state.citizens.reduce((s, c) => s + c.balanceCents, 0)).toBe(issued);
  });

  it('emits one founding event, one CitizenCreated per citizen, with contiguous sequence numbers', () => {
    expect(events[0]?.type).toBe('CivilizationFounded');
    expect(events.filter((e) => e.type === 'CitizenCreated')).toHaveLength(120);
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
      expect(e.tick).toBe(0);
    });
    expect(state.nextEventSeq).toBe(events.length + 1);
  });

  it('links each MoneyIssued event to the CitizenCreated event that caused it', () => {
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    for (const e of events.filter((x) => x.type === 'MoneyIssued')) {
      const cause = bySeq.get(e.causeSeq!);
      expect(cause?.type).toBe('CitizenCreated');
      expect(cause?.refs[0]?.id).toBe(e.refs[0]?.id);
    }
  });

  it('scales to 1,000 citizens with a valid world', () => {
    const big = generateWorld('big', parseConfig({ population: 1000 }));
    expect(big.state.citizens).toHaveLength(1000);
    expect(checkInvariants(big.state)).toEqual([]);
  });
});
