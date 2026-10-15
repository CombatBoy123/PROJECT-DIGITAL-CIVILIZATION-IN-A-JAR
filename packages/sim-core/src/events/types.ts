import type { Season } from '../time/clock.js';
import type { LifeStage, Weather } from '../state/schema.js';

/** Kinds of entity an event can reference. World-wide events (weather, seasons) have no refs. */
export const ENTITY_KINDS = ['citizen', 'building', 'household'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A reference from an event to an entity, with the role the entity played. */
export interface EntityRef {
  kind: EntityKind;
  id: number;
  role: string;
}

/**
 * Event catalogue: event type → payload. Payloads contain only JSON data (numbers,
 * strings, booleans, plain objects). They are never interpreted as code.
 */
export interface EventPayloads {
  /** The world was generated (tick 0). */
  CivilizationFounded: {
    seed: string;
    population: number;
    households: number;
    buildings: number;
    mapWidth: number;
    mapHeight: number;
  };
  /** A citizen exists from genesis. Births (later phases) will use a separate event. */
  CitizenCreated: {
    firstName: string;
    lastName: string;
    ageYears: number;
    lifeStage: LifeStage;
    householdId: number;
    homeId: number;
  };
  /** Money was created and credited to an account. The only way money enters the economy in Phase 1. */
  MoneyIssued: {
    amountCents: number;
    reason: 'initial_endowment';
  };
  /** A new season began. */
  SeasonStarted: {
    season: Season;
    year: number;
  };
  /** The daily weather draw changed the weather condition. */
  WeatherChanged: {
    from: Weather;
    to: Weather;
    dailyMeanTempC: number;
  };
  /** A citizen crossed a life-stage age threshold. */
  LifeStageChanged: {
    from: LifeStage;
    to: LifeStage;
    ageYears: number;
  };
}

export type EventType = keyof EventPayloads;

export const EVENT_TYPES = [
  'CivilizationFounded',
  'CitizenCreated',
  'MoneyIssued',
  'SeasonStarted',
  'WeatherChanged',
  'LifeStageChanged',
] as const satisfies readonly EventType[];

/** A recorded simulation event. */
export type SimEvent = {
  [K in EventType]: {
    /** Per-civilization sequence number; strictly increasing. */
    seq: number;
    /** Tick in which the event happened. */
    tick: number;
    type: K;
    payload: EventPayloads[K];
    refs: EntityRef[];
    /** Sequence number of the causing event, when the causal link is known. */
    causeSeq: number | null;
  };
}[EventType];

export type EventCategory = 'genesis' | 'environment' | 'demography' | 'economy';

export interface EventTypeInfo {
  category: EventCategory;
  label: string;
  description: string;
}

/** Human-facing descriptions used by the API and UI. */
export const EVENT_CATALOG: Record<EventType, EventTypeInfo> = {
  CivilizationFounded: {
    category: 'genesis',
    label: 'Civilization founded',
    description: 'The world, its households and citizens were generated from the seed.',
  },
  CitizenCreated: {
    category: 'genesis',
    label: 'Citizen created',
    description: 'A citizen was created at genesis with an age, household and home.',
  },
  MoneyIssued: {
    category: 'economy',
    label: 'Money issued',
    description: 'New money was created and credited to an account (initial endowment).',
  },
  SeasonStarted: {
    category: 'environment',
    label: 'Season started',
    description: 'The calendar entered a new season.',
  },
  WeatherChanged: {
    category: 'environment',
    label: 'Weather changed',
    description: 'The daily weather draw produced a different weather condition.',
  },
  LifeStageChanged: {
    category: 'demography',
    label: 'Life stage changed',
    description: 'A citizen became an adult or an elder on reaching the configured age.',
  },
};
