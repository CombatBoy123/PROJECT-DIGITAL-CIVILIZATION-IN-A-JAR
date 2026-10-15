import type { SimSystem, TickContext } from '../engine/context.js';
import type { Rng } from '../rng/rng.js';
import type { Building, Citizen, Weather, WorldState } from '../state/schema.js';
import { isNight } from '../time/clock.js';
import { roadRoute, routeLength } from '../world/roads.js';

/*
 * Stage 7 — daily routine and movement (Phase 1).
 *
 * A transparent rule-based routine, evaluated for every citizen in ascending id
 * order. It is intentionally simple and will be replaced by the utility-based
 * decision system in Phase 3 (which will also record decisions):
 *
 *  - travelling citizens arrive when the arrival tick is reached;
 *  - at home: sleep at night or when tired; wake in daytime once rested (sooner
 *    for conscientious citizens); otherwise
 *    possibly go out to a public venue (probability depends on hour of day,
 *    extraversion, weather and energy);
 *  - at a venue: go home at night, when tired, in a storm, or with a leave
 *    probability that is higher for introverts and after long stays.
 *
 * Random draws use the stream hash(seed, "routine", tick, citizenId), so one
 * citizen's choices never shift another citizen's random numbers.
 */

export const ROUTINE_RULES = {
  /** Wake up (in daytime) once energy reaches this level... */
  wakeEnergy: 85,
  /** ...with hourly probability wakeBase + wakeConscientiousness × conscientiousness. */
  wakeBase: 0.35,
  wakeConscientiousness: 0.6,
  /** Go to sleep when energy falls below this level. */
  sleepEnergy: 20,
  /** Minimum energy to consider an outing. */
  outingMinEnergy: 40,
  /** Leave a venue when energy falls below this level. */
  leaveVenueEnergy: 30,
  /** Base hourly probability of going out, by hour of day (before personality and weather). */
  outingBaseByHour: [
    0, 0, 0, 0, 0, 0, 0, 0, 0.04, 0.06, 0.08, 0.08, 0.07, 0.07, 0.08, 0.09, 0.1, 0.1, 0.08, 0.05,
    0.02, 0, 0, 0,
  ] as readonly number[],
  /** Multiplier on the outing probability by weather. */
  weatherOutingFactor: { clear: 1, cloudy: 0.8, rain: 0.35, storm: 0 } satisfies Record<
    Weather,
    number
  >,
  /** Hourly probability of leaving a venue: base + introvert bonus × (1 − extraversion) + long-stay bonus. */
  leaveBase: 0.15,
  leaveIntrovertBonus: 0.2,
  longStayHours: 4,
  longStayBonus: 0.2,
  /** Venue attractiveness falls off as 1 / (1 + routeLength / distanceScale). */
  distanceScale: 20,
} as const;

export function outingProbability(citizen: Citizen, hour: number, weather: Weather): number {
  if (citizen.needs.energy < ROUTINE_RULES.outingMinEnergy) return 0;
  const base = ROUTINE_RULES.outingBaseByHour[hour] ?? 0;
  return (
    base * (0.5 + citizen.personality.extraversion) * ROUTINE_RULES.weatherOutingFactor[weather]
  );
}

export function wakeProbability(citizen: Citizen): number {
  return (
    ROUTINE_RULES.wakeBase +
    ROUTINE_RULES.wakeConscientiousness * citizen.personality.conscientiousness
  );
}

export function leaveProbability(citizen: Citizen, tick: number): number {
  const hoursThere = tick - citizen.activitySince;
  return (
    ROUTINE_RULES.leaveBase +
    ROUTINE_RULES.leaveIntrovertBonus * (1 - citizen.personality.extraversion) +
    (hoursThere >= ROUTINE_RULES.longStayHours ? ROUTINE_RULES.longStayBonus : 0)
  );
}

/** Travel time in ticks between two buildings along the road network (at least 1). */
export function travelTicks(state: WorldState, from: Building, to: Building): number {
  const length = routeLength(roadRoute(state.map, from.door, to.door));
  return Math.max(1, Math.ceil(length / state.config.movement.walkTilesPerTick));
}

function startTrip(
  ctx: TickContext,
  citizen: Citizen,
  from: Building,
  to: Building,
  purpose: 'leisure' | 'home',
): void {
  citizen.travel = {
    fromId: from.id,
    toId: to.id,
    departTick: ctx.tick,
    arriveTick: ctx.tick + travelTicks(ctx.state, from, to),
    purpose,
  };
  citizen.locationId = null;
  citizen.activity = 'traveling';
  citizen.activitySince = ctx.tick;
}

function chooseVenue(
  ctx: TickContext,
  citizen: Citizen,
  from: Building,
  load: Map<number, number>,
  rng: Rng,
): Building | null {
  const venues = ctx.index.venues;
  const weights = venues.map((venue) => {
    if ((load.get(venue.id) ?? 0) >= venue.capacity) return 0;
    const distance = routeLength(roadRoute(ctx.state.map, from.door, venue.door));
    const preference =
      venue.kind === 'park'
        ? 0.5 + citizen.personality.openness
        : 1.5 - citizen.personality.openness;
    return preference / (1 + distance / ROUTINE_RULES.distanceScale);
  });
  const index = rng.weightedIndex(weights);
  return index < 0 ? null : (venues[index] ?? null);
}

export const routineSystem: SimSystem = {
  name: 'routine',
  stage: 7,
  run(ctx: TickContext): void {
    const { state, index, tick, calendar } = ctx;
    const night = isNight(calendar.hour);
    const weather = state.environment.weather;

    // Current and incoming visitors per venue (capacity is reserved when a trip starts).
    const load = new Map<number, number>();
    for (const c of state.citizens) {
      const target = c.travel ? c.travel.toId : c.locationId;
      if (target !== null && target !== c.homeId) load.set(target, (load.get(target) ?? 0) + 1);
    }

    for (const citizen of state.citizens) {
      if (citizen.travel) {
        if (tick < citizen.travel.arriveTick) continue;
        const destination = citizen.travel.toId;
        citizen.travel = null;
        citizen.locationId = destination;
        citizen.activitySince = tick;
        if (destination === citizen.homeId) {
          citizen.activity =
            night || citizen.needs.energy < ROUTINE_RULES.sleepEnergy ? 'sleeping' : 'at_home';
        } else {
          citizen.activity = 'leisure';
        }
        continue;
      }

      const here = index.building(citizen.locationId as number);
      if (citizen.locationId === citizen.homeId) {
        if (citizen.activity === 'sleeping') {
          if (
            !night &&
            citizen.needs.energy >= ROUTINE_RULES.wakeEnergy &&
            ctx.rng('routine', citizen.id).chance(wakeProbability(citizen))
          ) {
            citizen.activity = 'at_home';
            citizen.activitySince = tick;
          }
          continue;
        }
        if (night || citizen.needs.energy < ROUTINE_RULES.sleepEnergy) {
          citizen.activity = 'sleeping';
          citizen.activitySince = tick;
          continue;
        }
        const p = outingProbability(citizen, calendar.hour, weather);
        if (p <= 0) continue;
        const rng = ctx.rng('routine', citizen.id);
        if (!rng.chance(p)) continue;
        const venue = chooseVenue(ctx, citizen, here, load, rng);
        if (!venue) continue;
        load.set(venue.id, (load.get(venue.id) ?? 0) + 1);
        startTrip(ctx, citizen, here, venue, 'leisure');
        continue;
      }

      // At a public venue.
      const mustLeave =
        night || citizen.needs.energy < ROUTINE_RULES.leaveVenueEnergy || weather === 'storm';
      const leaves =
        mustLeave || ctx.rng('routine', citizen.id).chance(leaveProbability(citizen, tick));
      if (leaves) {
        load.set(here.id, (load.get(here.id) ?? 1) - 1);
        startTrip(ctx, citizen, here, index.building(citizen.homeId), 'home');
      }
    }
  },
};
