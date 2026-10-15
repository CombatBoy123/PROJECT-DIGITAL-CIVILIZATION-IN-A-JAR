import { describe, expect, it } from 'vitest';
import {
  calendarAt,
  checkEventSequence,
  checkInvariants,
  hourlyTemperature,
  InvariantViolationError,
  Simulation,
  travelTicks,
  type Building,
  type Citizen,
  type InvariantCode,
  type Travel,
  type WorldState,
} from '../src/index.js';
import { cloneState, newSimulation } from './helpers.js';

function codesAfter(
  mutate: (s: WorldState) => void,
  config: Record<string, unknown> = {},
): InvariantCode[] {
  const { simulation } = newSimulation('invariants', config);
  simulation.run(30);
  const state = cloneState(simulation);
  mutate(state);
  return checkInvariants(state).map((v) => v.code);
}

/** Put the first citizen on a trip (by default a correctly timed one to the first venue). */
function sendOnTrip(
  s: WorldState,
  pick: (home: Building, venue: Building, other: Building) => [Building, Building],
  adjust: (trip: Travel) => void = () => undefined,
): void {
  const c = s.citizens[0] as Citizen;
  const home = s.buildings.find((b) => b.id === c.homeId)!;
  const venue = s.buildings.find((b) => b.kind === 'plaza')!;
  const other = s.buildings.find((b) => b.kind === 'house' && b.id !== c.homeId)!;
  const [from, to] = pick(home, venue, other);
  c.travel = {
    fromId: from.id,
    toId: to.id,
    departTick: s.tick,
    arriveTick: s.tick + travelTicks(s, from, to),
    purpose: to.id === c.homeId ? 'home' : 'leisure',
  };
  adjust(c.travel);
  c.locationId = null;
  c.activity = 'traveling';
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

  it('accepts correctly timed trips between home and a venue', () => {
    expect(codesAfter((s) => sendOnTrip(s, (home, venue) => [home, venue]))).toEqual([]);
    expect(codesAfter((s) => sendOnTrip(s, (home, venue) => [venue, home]))).toEqual([]);
  });

  it('detects trips to the wrong place, with the wrong purpose or of the wrong length', () => {
    // To another family's house.
    expect(codesAfter((s) => sendOnTrip(s, (home, _venue, other) => [home, other]))).toContain(
      'LOCATION',
    );
    // To a venue, but labelled as going home.
    expect(
      codesAfter((s) =>
        sendOnTrip(
          s,
          (home, venue) => [home, venue],
          (t) => void (t.purpose = 'home'),
        ),
      ),
    ).toContain('LOCATION');
    // A 1000-hour walk, and (at a slow walking speed, so the route takes several hours)
    // a trip that arrives faster than the route allows.
    expect(
      codesAfter((s) =>
        sendOnTrip(
          s,
          (home, venue) => [home, venue],
          (t) => void (t.arriveTick = t.departTick + 1000),
        ),
      ),
    ).toContain('LOCATION');
    const slow = { movement: { walkTilesPerTick: 4 } };
    expect(
      codesAfter((s) => {
        sendOnTrip(s, (home, venue) => [home, venue]);
        const trip = s.citizens[0]!.travel!;
        expect(trip.arriveTick - trip.departTick).toBeGreaterThan(1);
        trip.arriveTick = trip.departTick + 1;
      }, slow),
    ).toContain('LOCATION');
  });

  it('detects overlapping buildings and buildings outside the map', () => {
    expect(
      codesAfter((s) => {
        const plaza = s.buildings.find((b) => b.kind === 'plaza')!;
        const house = s.buildings.find((b) => b.kind === 'house')!;
        Object.assign(house, { blockId: plaza.blockId, x: plaza.x, y: plaza.y, door: plaza.door });
      }),
    ).toContain('MAP');
    expect(
      codesAfter((s) => {
        // Shift a block (and everything on it) beyond the map edge.
        const block = s.map.blocks[0]!;
        block.x += s.map.width;
        for (const b of s.buildings.filter((b) => b.blockId === block.id)) b.x += s.map.width;
      }),
    ).toContain('MAP');
    expect(codesAfter((s) => void (s.map.width += 1))).toContain('MAP');
  });

  it('detects an environment that contradicts the weather settings', () => {
    const off = { stochastic: { weather: false } };
    expect(codesAfter(() => undefined, off)).toEqual([]);
    expect(codesAfter((s) => void (s.environment.weather = 'storm'), off)).toContain('ENVIRONMENT');
    expect(codesAfter((s) => void (s.environment.dailyMeanTempC += 3), off)).toContain(
      'ENVIRONMENT',
    );
    expect(codesAfter((s) => void (s.environment.temperatureC = 9999))).toContain('ENVIRONMENT');
    // A 60 °C day in spring, with an hourly temperature consistent with it.
    const heatwave = codesAfter((s) => {
      s.environment.dailyMeanTempC = 60;
      s.environment.temperatureC = hourlyTemperature(60, calendarAt(s.tick, s.config).hour);
    });
    expect(heatwave).toEqual(['ENVIRONMENT']);
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
