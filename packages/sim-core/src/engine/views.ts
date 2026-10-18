import type { Activity, Building, Household, WorldMap, WorldState } from '../state/schema.js';
import { calendarAt, type Calendar } from '../time/clock.js';
import type { DeepReadonly } from './simulation.js';

/*
 * Read-only views of the state for transport to clients. They expose only what a
 * renderer needs, keeping the live stream small.
 */

export const ACTIVITY_CODES: Readonly<Record<Activity, number>> = {
  sleeping: 0,
  at_home: 1,
  leisure: 2,
  traveling: 3,
};

export const ACTIVITY_BY_CODE: readonly Activity[] = [
  'sleeping',
  'at_home',
  'leisure',
  'traveling',
];

/**
 * Compact per-citizen position tuple:
 * [id, activityCode, locationId (0 while travelling), fromId, toId, departTick, arriveTick]
 * The trip fields are 0 when the citizen is not travelling.
 */
export type CitizenFrameTuple = [number, number, number, number, number, number, number];

export interface WorldFrame {
  tick: number;
  calendar: Calendar;
  weather: WorldState['environment']['weather'];
  temperatureC: number;
  citizens: CitizenFrameTuple[];
}

export function citizenFrameTuple(
  c: DeepReadonly<WorldState['citizens'][number]>,
): CitizenFrameTuple {
  const t = c.travel;
  return [
    c.id,
    ACTIVITY_CODES[c.activity],
    c.locationId ?? 0,
    t ? t.fromId : 0,
    t ? t.toId : 0,
    t ? t.departTick : 0,
    t ? t.arriveTick : 0,
  ];
}

export function buildFrame(state: DeepReadonly<WorldState>): WorldFrame {
  return {
    tick: state.tick,
    calendar: calendarAt(state.tick, state.config),
    weather: state.environment.weather,
    temperatureC: state.environment.temperatureC,
    citizens: state.citizens.map(citizenFrameTuple),
  };
}

/** Static geography: changes only when buildings are constructed or demolished. */
export interface WorldLayout {
  map: WorldMap;
  buildings: Building[];
  households: Household[];
}

export function buildLayout(state: DeepReadonly<WorldState>): WorldLayout {
  // Deep copy so callers can never mutate engine state through the layout.
  return JSON.parse(
    JSON.stringify({ map: state.map, buildings: state.buildings, households: state.households }),
  ) as WorldLayout;
}
