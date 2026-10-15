import { describe, expect, it } from 'vitest';
import {
  checkEventSequence,
  checkInvariants,
  InvariantViolationError,
  Simulation,
  type InvariantCode,
  type WorldState,
} from '../src/index.js';
import { cloneState, newSimulation } from './helpers.js';

function codesAfter(mutate: (s: WorldState) => void): InvariantCode[] {
  const { simulation } = newSimulation('invariants');
  simulation.run(30);
  const state = cloneState(simulation);
  mutate(state);
  return checkInvariants(state).map((v) => v.code);
}

describe('invariants', () => {
  it('a valid run has no violations at any tick', () => {
    const { simulation } = newSimulation('valid-run');
    for (let i = 0; i < 24 * 7; i++) {
      simulation.step();
      expect(checkInvariants(cloneState(simulation))).toEqual([]);
    }
  });

  it('detects negative balances', () => {
    expect(
      codesAfter((s) => {
        const child = s.citizens.find((c) => c.balanceCents === 0)!;
        const adult = s.citizens.find((c) => c.balanceCents > 0)!;
        // Move money so the total is conserved but one balance is negative.
        child.balanceCents -= 100;
        adult.balanceCents += 100;
      }),
    ).toContain('NEGATIVE_BALANCE');
  });

  it('detects money created without an issuance record', () => {
    expect(codesAfter((s) => void (s.citizens[0]!.balanceCents += 500))).toContain(
      'MONEY_CONSERVATION',
    );
  });

  it('detects money destroyed without a record', () => {
    expect(
      codesAfter((s) => {
        const adult = s.citizens.find((c) => c.balanceCents > 0)!;
        adult.balanceCents -= 1;
      }),
    ).toContain('MONEY_CONSERVATION');
  });

  it('detects fractional cents', () => {
    expect(
      codesAfter((s) => void (s.citizens.find((c) => c.balanceCents > 0)!.balanceCents += 0.5)),
    ).toContain('NEGATIVE_BALANCE');
  });

  it('detects homes that are not houses and overcrowded houses', () => {
    expect(
      codesAfter((s) => {
        const venue = s.buildings.find((b) => b.kind === 'plaza')!;
        s.citizens[0]!.homeId = venue.id;
      }),
    ).toContain('HOUSING');
    expect(
      codesAfter((s) => {
        const house = s.buildings.find((b) => b.id === s.citizens[0]!.homeId)!;
        house.capacity = 0 + 1;
        const household = s.households.find((h) => h.homeId === house.id)!;
        // Add an extra member to the household so occupancy exceeds capacity 1.
        const other = s.citizens.find((c) => c.homeId !== house.id)!;
        other.homeId = house.id;
        other.householdId = household.id;
        other.locationId = other.travel ? null : house.id;
        if (!other.travel) other.activity = 'at_home';
      }),
    ).toContain('HOUSING');
  });

  it('detects citizens that are nowhere or in two places', () => {
    expect(codesAfter((s) => void (s.citizens[0]!.locationId = 99_999))).toContain('LOCATION');
    expect(
      codesAfter((s) => {
        const c = s.citizens[0]!;
        c.travel = {
          fromId: c.homeId,
          toId: c.homeId,
          departTick: s.tick,
          arriveTick: s.tick + 1,
          purpose: 'home',
        };
      }),
    ).toContain('LOCATION');
  });

  it('detects trips whose window does not contain the current tick', () => {
    expect(
      codesAfter((s) => {
        const c = s.citizens[0]!;
        c.travel = {
          fromId: c.homeId,
          toId: c.homeId,
          departTick: s.tick - 5,
          arriveTick: s.tick,
          purpose: 'home',
        };
        c.locationId = null;
        c.activity = 'traveling';
      }),
    ).toContain('LOCATION');
  });

  it('detects needs out of bounds', () => {
    expect(codesAfter((s) => void (s.citizens[0]!.needs.energy = 101))).toContain('NEEDS_BOUNDS');
    expect(codesAfter((s) => void (s.citizens[0]!.needs.energy = -0.1))).toContain('NEEDS_BOUNDS');
  });

  it('detects life stages inconsistent with age', () => {
    expect(
      codesAfter((s) => {
        const child = s.citizens.find((c) => c.lifeStage === 'child')!;
        child.lifeStage = 'elder';
      }),
    ).toContain('LIFE_STAGE');
  });

  it('detects duplicate or unordered ids', () => {
    expect(codesAfter((s) => void (s.citizens[1]!.id = s.citizens[0]!.id))).toContain('IDENTITY');
  });

  it('detects venue overcrowding', () => {
    expect(
      codesAfter((s) => {
        const venue = s.buildings.find((b) => b.kind === 'park')!;
        venue.capacity = 1;
        for (const c of s.citizens.slice(0, 2)) {
          c.travel = null;
          c.locationId = venue.id;
          c.activity = 'leisure';
        }
      }),
    ).toContain('VENUE_CAPACITY');
  });

  it('checks event sequences', () => {
    const { genesis } = newSimulation('events');
    expect(checkEventSequence(genesis.events, 1, 0)).toEqual([]);
    expect(checkEventSequence(genesis.events, 2, 0).map((v) => v.code)).toEqual(['EVENT_SEQUENCE']);
    expect(checkEventSequence(genesis.events, 1, 5).map((v) => v.code)).toEqual(['EVENT_SEQUENCE']);
  });

  it('the engine refuses to restore an impossible state and halts on violation', () => {
    const { simulation } = newSimulation('halt');
    const state = cloneState(simulation);
    state.citizens[0]!.balanceCents += 1;
    expect(() => Simulation.fromState(state)).toThrow(InvariantViolationError);
  });
});
