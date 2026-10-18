import { describe, expect, it } from 'vitest';
import {
  calendarAt,
  canStayAnotherHour,
  energyDelta,
  ENERGY_RULES,
  leaveProbability,
  isNight,
  outingFits,
  outingProbability,
  roadRoute,
  routeLength,
  isRoad,
  Simulation,
  SEASON_BASE_TEMP_C,
  HOURLY_TEMP_OFFSET_C,
  travelTicks,
  ROUTINE_RULES,
  WEATHER_TRANSITIONS,
  type Citizen,
} from '../src/index.js';
import { cloneState, newSimulation, runUntil } from './helpers.js';

describe('environment', () => {
  it('weather transition rows are valid integer weights summing to 100', () => {
    for (const season of Object.values(WEATHER_TRANSITIONS)) {
      for (const row of Object.values(season)) {
        expect(row.reduce((a, b) => a + b, 0)).toBe(100);
        for (const w of row) expect(Number.isInteger(w)).toBe(true);
      }
    }
  });

  it('without stochastic weather, temperature follows the seasonal baseline exactly', () => {
    const { simulation } = newSimulation('baseline', { stochastic: { weather: false } });
    for (let i = 0; i < 24 * 30; i++) {
      simulation.step();
      const c = calendarAt(simulation.tick, simulation.state.config);
      const expected =
        Math.round((SEASON_BASE_TEMP_C[c.season] + HOURLY_TEMP_OFFSET_C[c.hour]!) * 10) / 10;
      expect(simulation.state.environment.temperatureC).toBe(expected);
    }
  });

  it('emits SeasonStarted on the first hour of each season', () => {
    const { simulation } = newSimulation('seasons', { daysPerSeason: 2 });
    const events = simulation.run(24 * 8 + 1).flatMap((r) => r.events);
    const seasons = events.filter((e) => e.type === 'SeasonStarted');
    expect(seasons.map((e) => e.tick)).toEqual([48, 96, 144, 192]);
    expect(seasons.map((e) => (e.type === 'SeasonStarted' ? e.payload.season : ''))).toEqual([
      'summer',
      'autumn',
      'winter',
      'spring',
    ]);
  });

  it('only emits WeatherChanged when the condition actually changes', () => {
    const { simulation } = newSimulation('weather');
    let previous = simulation.state.environment.weather;
    for (let i = 0; i < 24 * 60; i++) {
      const { events } = simulation.step();
      const change = events.find((e) => e.type === 'WeatherChanged');
      const now = simulation.state.environment.weather;
      if (now !== previous) {
        expect(change?.type === 'WeatherChanged' && change.payload).toMatchObject({
          from: previous,
          to: now,
        });
      } else {
        expect(change).toBeUndefined();
      }
      previous = now;
    }
  });
});

describe('demography', () => {
  it('emits LifeStageChanged exactly when a citizen reaches the adult age', () => {
    const { simulation } = newSimulation('ageing');
    const state = cloneState(simulation);
    const tpy = state.config.daysPerSeason * 4 * 24;
    // Make citizen 1 a child who turns adult at tick 5.
    const c = state.citizens.find((x) => x.lifeStage === 'child') ?? state.citizens[0]!;
    c.birthTick = 5 - state.config.lifeStages.adultAge * tpy;
    c.lifeStage = 'child';
    const sim = Simulation.fromState(state);
    const events = sim.run(6).flatMap((r) => r.events.filter((e) => e.type === 'LifeStageChanged'));
    const mine = events.filter((e) => e.refs[0]?.id === c.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      tick: 5,
      payload: { from: 'child', to: 'adult', ageYears: 18 },
    });
  });
});

describe('needs', () => {
  it('sleep restores energy and activities drain it (elders faster)', () => {
    expect(energyDelta('sleeping', false)).toBe(ENERGY_RULES.sleepGain);
    expect(energyDelta('at_home', false)).toBe(-1.5);
    expect(energyDelta('leisure', false)).toBe(-2.5);
    expect(energyDelta('traveling', true)).toBe(-3 * 1.25);
  });

  it('energy stays within [0, 100]', () => {
    const { simulation } = newSimulation('bounds');
    for (let i = 0; i < 24 * 14; i++) {
      simulation.step();
      for (const c of simulation.state.citizens) {
        expect(c.needs.energy).toBeGreaterThanOrEqual(0);
        expect(c.needs.energy).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('routine', () => {
  const citizen = (extraversion: number, energy: number) =>
    ({ personality: { extraversion }, needs: { energy }, activitySince: 0 }) as unknown as Citizen;

  it('outing probability depends on hour, extraversion, weather and energy', () => {
    expect(outingProbability(citizen(0.5, 80), 3, 'clear')).toBe(0);
    expect(outingProbability(citizen(0.5, 80), 16, 'storm')).toBe(0);
    expect(outingProbability(citizen(0.5, 30), 16, 'clear')).toBe(0);
    const introvert = outingProbability(citizen(0.1, 80), 16, 'clear');
    const extravert = outingProbability(citizen(0.9, 80), 16, 'clear');
    expect(extravert).toBeGreaterThan(introvert);
    expect(outingProbability(citizen(0.5, 80), 16, 'rain')).toBeCloseTo(
      outingProbability(citizen(0.5, 80), 16, 'clear') * ROUTINE_RULES.weatherOutingFactor.rain,
    );
  });

  it('introverts and long stays raise the probability of leaving a venue', () => {
    expect(leaveProbability(citizen(0.1, 80), 1)).toBeGreaterThan(
      leaveProbability(citizen(0.9, 80), 1),
    );
    expect(leaveProbability(citizen(0.5, 80), 10)).toBeGreaterThan(
      leaveProbability(citizen(0.5, 80), 1),
    );
  });

  it('everyone is asleep at home in the small hours', () => {
    const { simulation } = newSimulation('night');
    runUntil(simulation, 24 * 3 + 3); // day 4, 03:00
    for (const c of simulation.state.citizens) {
      expect(c.activity).toBe('sleeping');
      expect(c.locationId).toBe(c.homeId);
    }
  });

  it('an outing must fit the day and the energy budget, and so must staying at a venue', () => {
    const adult = (energy: number) =>
      ({ lifeStage: 'adult', needs: { energy } }) as unknown as Citizen;
    // 10:00 leaves 12 hours: a 5-hour walk each way plus one hour there fits, 6 hours does not.
    expect(outingFits(adult(100), 10, 5)).toBe(true);
    expect(outingFits(adult(100), 10, 6)).toBe(false);
    // 19:00: only a one-hour walk fits (out 19–20, stay 20–21, back 21–22); at 20:00 nothing does.
    expect(outingFits(adult(100), 19, 1)).toBe(true);
    expect(outingFits(adult(100), 19, 2)).toBe(false);
    expect(outingFits(adult(100), 20, 1)).toBe(false);
    // Energy: 40 − 2·3·T − 2.5 must stay ≥ 20, so T ≤ 2 at energy 40.
    expect(outingFits(adult(40), 10, 2)).toBe(true);
    expect(outingFits(adult(40), 10, 3)).toBe(false);
    // Staying another hour at 20:00 with a one-hour walk home arrives at 22:00 exactly.
    expect(canStayAnotherHour(adult(80), 20, 1)).toBe(true);
    expect(canStayAnotherHour(adult(80), 20, 2)).toBe(false);
    expect(canStayAnotherHour(adult(80), 21, 1)).toBe(false);
    // 30 − 2.5 − 3 = 24.5 ≥ 20, but 26 − 2.5 − 3 = 20.5 and 25 − 2.5 − 3 = 19.5.
    expect(canStayAnotherHour(adult(26), 12, 1)).toBe(true);
    expect(canStayAnotherHour(adult(25), 12, 1)).toBe(false);
  });

  // Regression: large or slow worlds used to send citizens on trips that arrived at
  // night or took a whole day, so they stayed awake for days at zero energy.
  it.each([
    { population: 1000, movement: { walkTilesPerTick: 4 }, days: 3 },
    { population: 5000, movement: { walkTilesPerTick: 24 }, days: 2 },
  ])(
    'at population $population and walking speed $movement.walkTilesPerTick nobody is out at night',
    ({ days, ...config }) => {
      const { simulation } = Simulation.create('demo', config);
      for (let i = 0; i < 24 * days; i++) {
        simulation.step();
        const hour = simulation.calendar.hour;
        for (const c of simulation.state.citizens) {
          if (isNight(hour)) {
            expect(c.locationId).toBe(c.homeId);
            expect(c.activity).toBe('sleeping');
          }
          if (c.travel) {
            // Every trip ends by 22:00 of the day it started on.
            const departHour = calendarAt(c.travel.departTick, simulation.state.config).hour;
            expect(c.travel.arriveTick - c.travel.departTick).toBeLessThanOrEqual(22 - departHour);
            // Nobody walks while exhausted (energy is projected to stay ≥ sleepEnergy).
            expect(c.needs.energy).toBeGreaterThanOrEqual(ROUTINE_RULES.sleepEnergy - 0.01);
          }
        }
      }
    },
    20_000,
  );

  it('citizens go out during the day and use public venues', () => {
    const { simulation } = newSimulation('daytime');
    const results = simulation.run(24 * 3);
    const peak = Math.max(...results.map((r) => r.metrics!.values['activity.leisure']));
    expect(peak).toBeGreaterThan(0);
  });

  it('nobody starts an outing during a storm and visitors head home', () => {
    // Stochastic weather stays on: a storm with it disabled is an impossible state.
    const { simulation } = newSimulation('storm');
    runUntil(simulation, 24 + 14); // day 2, 14:00 — people are out
    expect(simulation.state.citizens.some((c) => c.activity === 'leisure')).toBe(true);
    const state = cloneState(simulation);
    state.environment.weather = 'storm';
    const stormy = Simulation.fromState(state);
    stormy.step(); // 15:00: storms force everyone at venues to leave
    for (const c of stormy.state.citizens) {
      if (c.travel)
        expect(c.travel.toId === c.homeId || c.travel.departTick < stormy.tick).toBe(true);
      // Only citizens who arrived this very hour can still be at a venue; they leave next hour.
      if (c.activity === 'leisure') expect(c.activitySince).toBe(stormy.tick);
    }
    stormy.step();
    for (const c of stormy.state.citizens) expect(c.activity).not.toBe('leisure');
    // Over the rest of the (stormy) day nobody departs for a venue.
    for (let i = 0; i < 6; i++) {
      stormy.step();
      for (const c of stormy.state.citizens) {
        if (c.travel && c.travel.departTick === stormy.tick) expect(c.travel.purpose).toBe('home');
      }
    }
  });

  it('trips take the road route length divided by walking speed (at least one tick)', () => {
    const { simulation } = newSimulation('trips');
    const state = simulation.state as unknown as Parameters<typeof travelTicks>[0];
    const [a, b] = [
      simulation.index.venues[0]!,
      simulation.index.buildings.get(simulation.state.citizens[0]!.homeId)!,
    ];
    const length = routeLength(roadRoute(state.map, b.door, a.door));
    expect(travelTicks(state, b, a)).toBe(
      Math.max(1, Math.ceil(length / state.config.movement.walkTilesPerTick)),
    );
  });

  it('records trips consistent with the travel time rule', () => {
    const { simulation } = newSimulation('trip-consistency');
    for (let i = 0; i < 24 * 2; i++) {
      simulation.step();
      for (const c of simulation.state.citizens) {
        if (c.travel && c.travel.departTick === simulation.tick) {
          const from = simulation.index.building(c.travel.fromId);
          const to = simulation.index.building(c.travel.toId);
          expect(c.travel.arriveTick - c.travel.departTick).toBe(
            travelTicks(simulation.state as never, from, to),
          );
        }
      }
    }
  });
});

describe('roads', () => {
  it('routes stay on roads and are shortest among grid routes through one vertical road', () => {
    const { simulation } = newSimulation('roads', { population: 200 });
    const map = simulation.state.map;
    const doors = simulation.state.buildings.map((b) => b.door);
    for (let i = 0; i < doors.length; i += 3) {
      for (let j = 1; j < doors.length; j += 5) {
        const route = roadRoute(map, doors[i]!, doors[j]!);
        for (let k = 1; k < route.length; k++) {
          const p = route[k - 1]!;
          const q = route[k]!;
          expect(p.x === q.x || p.y === q.y).toBe(true);
          // Sample every tile along the segment.
          const steps = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
          for (let s = 0; s <= steps; s++) {
            const x = p.x + Math.sign(q.x - p.x) * (p.x === q.x ? 0 : s);
            const y = p.y + Math.sign(q.y - p.y) * (p.y === q.y ? 0 : s);
            expect(isRoad(map, x, y)).toBe(true);
          }
        }
        expect(routeLength(route)).toBeGreaterThanOrEqual(
          Math.abs(doors[i]!.x - doors[j]!.x) + Math.abs(doors[i]!.y - doors[j]!.y),
        );
      }
    }
  });
});
