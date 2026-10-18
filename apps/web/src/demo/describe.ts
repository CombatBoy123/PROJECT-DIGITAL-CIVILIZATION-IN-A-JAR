import {
  ageInYears,
  SeedSchema,
  SimulationConfigSchema,
  type Building,
  type Citizen,
  type DeepReadonly,
  type SimEvent,
  type SimulationConfigInput,
  type WorldState,
} from '@civ/sim-core';

/*
 * Pure read helpers for the demo panels: where a citizen is, who lives or stands
 * where, name search, per-entity event filtering and the new-world form validation.
 */

export type ReadonlyCitizen = DeepReadonly<Citizen>;
export type ReadonlyBuilding = DeepReadonly<Building>;
type State = DeepReadonly<WorldState>;

/** Browser demo cap on the population (the engine itself allows up to 5,000). */
export const DEMO_MAX_POPULATION = 1000;

export function fullName(c: Pick<Citizen, 'firstName' | 'lastName'>): string {
  return `${c.firstName} ${c.lastName}`;
}

export function citizenAge(c: Pick<Citizen, 'birthTick'>, state: State): number {
  return ageInYears(c, state.tick, state.config);
}

export type Whereabouts =
  | { kind: 'in'; buildingId: number }
  | { kind: 'travelling'; fromId: number; toId: number; arriveTick: number }
  | { kind: 'unknown' };

export function whereabouts(c: ReadonlyCitizen): Whereabouts {
  if (c.locationId !== null) return { kind: 'in', buildingId: c.locationId };
  if (c.travel)
    return {
      kind: 'travelling',
      fromId: c.travel.fromId,
      toId: c.travel.toId,
      arriveTick: c.travel.arriveTick,
    };
  return { kind: 'unknown' };
}

/** Other members of the citizen's household, by id. */
export function householdMembers(c: ReadonlyCitizen, state: State): ReadonlyCitizen[] {
  return state.citizens.filter((o) => o.householdId === c.householdId && o.id !== c.id);
}

export function residentsOf(buildingId: number, state: State): ReadonlyCitizen[] {
  return state.citizens.filter((c) => c.homeId === buildingId);
}

export function presentAt(buildingId: number, state: State): ReadonlyCitizen[] {
  return state.citizens.filter((c) => c.locationId === buildingId);
}

/** Citizens whose full name contains every word of the query (case-insensitive). */
export function searchCitizens(citizens: readonly ReadonlyCitizen[], query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...citizens];
  return citizens.filter((c) => {
    const name = fullName(c).toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/** Events that reference an entity, newest first. */
export function eventsAbout(
  events: readonly SimEvent[],
  kind: 'citizen' | 'building',
  id: number,
  limit = 20,
): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (e && e.refs.some((r) => r.kind === kind && r.id === id)) out.push(e);
  }
  return out;
}

export interface WorldFormValues {
  seed: string;
  population: string;
  daysPerSeason: string;
  stochasticWeather: boolean;
}

export type WorldFormField = 'seed' | 'population' | 'daysPerSeason';
export type WorldFormErrors = Partial<Record<WorldFormField, string>>;

const shape = SimulationConfigSchema.shape;

/** Accepted ranges, read from the engine schema (population capped for the browser). */
export const FORM_BOUNDS = {
  population: {
    min: shape.population.unwrap().minValue ?? 10,
    max: Math.min(DEMO_MAX_POPULATION, shape.population.unwrap().maxValue ?? DEMO_MAX_POPULATION),
  },
  daysPerSeason: {
    min: shape.daysPerSeason.unwrap().minValue ?? 1,
    max: shape.daysPerSeason.unwrap().maxValue ?? 60,
  },
} as const;

function toNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

function rangeMessage(key: keyof typeof FORM_BOUNDS): string {
  const { min, max } = FORM_BOUNDS[key];
  return `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`;
}

/**
 * Validate the new-world form with the engine's own schemas (SeedSchema,
 * SimulationConfigSchema) plus the demo's population cap. Returns either the
 * settings or one message per invalid field.
 */
export function validateWorldForm(
  values: WorldFormValues,
):
  | { ok: true; seed: string; config: SimulationConfigInput }
  | { ok: false; errors: WorldFormErrors } {
  const errors: WorldFormErrors = {};
  const seed = values.seed.trim();
  const seedResult = SeedSchema.safeParse(seed);
  if (!seedResult.success) {
    errors.seed =
      seed === ''
        ? 'Enter a seed.'
        : seed.length > 64
          ? 'Use at most 64 characters.'
          : (seedResult.error.issues[0]?.message ?? 'Invalid seed.');
  }
  const config = {
    population: toNumber(values.population),
    daysPerSeason: toNumber(values.daysPerSeason),
    stochastic: { weather: values.stochasticWeather },
  };
  const configResult = SimulationConfigSchema.safeParse(config);
  if (!configResult.success) {
    for (const issue of configResult.error.issues) {
      const key = issue.path[0];
      if (key === 'population' || key === 'daysPerSeason') errors[key] ??= rangeMessage(key);
    }
  }
  if (config.population > FORM_BOUNDS.population.max)
    errors.population = rangeMessage('population');
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, seed, config };
}
