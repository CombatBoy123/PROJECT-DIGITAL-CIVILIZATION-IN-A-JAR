import { z } from 'zod';
import { SeedSchema, SimulationConfigSchema } from '../config.js';
import { SEASONS } from '../time/clock.js';

/*
 * The complete, serialisable world state. Everything the engine needs to continue a
 * run is in here; nothing else (no generator state, no caches). Entity arrays are
 * kept sorted by ascending id. Money is always integer cents.
 *
 * These Zod schemas are the single source of truth for the state types and are used
 * to validate any state loaded from storage or imported from a file.
 */

const id = z.number().int().positive();
const tick = z.number().int();
const cents = z.number().int().safe();
const unit = z.number().min(0).max(1);
const level = z.number().min(0).max(100);

export const LIFE_STAGES = ['child', 'adult', 'elder'] as const;
export const EDUCATION_LEVELS = ['none', 'primary', 'secondary', 'tertiary'] as const;
export const ACTIVITIES = ['sleeping', 'at_home', 'leisure', 'traveling'] as const;
export const BUILDING_KINDS = ['house', 'plaza', 'park'] as const;
export const ZONES = ['residential', 'commercial', 'farmland', 'civic'] as const;
export const WEATHER = ['clear', 'cloudy', 'rain', 'storm'] as const;
export const SKILLS = ['farming', 'baking', 'crafting', 'commerce', 'management'] as const;
export const PERSONALITY_TRAITS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
] as const;

export const LifeStageSchema = z.enum(LIFE_STAGES);
export const EducationSchema = z.enum(EDUCATION_LEVELS);
export const ActivitySchema = z.enum(ACTIVITIES);
export const BuildingKindSchema = z.enum(BUILDING_KINDS);
export const ZoneSchema = z.enum(ZONES);
export const WeatherSchema = z.enum(WEATHER);
export const SeasonSchema = z.enum(SEASONS);
export const SkillSchema = z.enum(SKILLS);

export const PointSchema = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export const BlockSchema = z.strictObject({
  id,
  col: z.number().int().min(0),
  row: z.number().int().min(0),
  /** Top-left interior tile. */
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  zone: ZoneSchema,
});

export const WorldMapSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** Interior size of a (square) block in tiles. */
  blockSize: z.number().int().positive(),
  /** Distance between parallel roads: blockSize + 1. Roads run along x % pitch = 0 and y % pitch = 0. */
  roadPitch: z.number().int().positive(),
  blocks: z.array(BlockSchema),
});

export const BuildingSchema = z.strictObject({
  id,
  kind: BuildingKindSchema,
  name: z.string().min(1).max(80),
  blockId: id,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Residents for houses, simultaneous visitors for public venues. */
  capacity: z.number().int().positive(),
  /** Road tile in front of the entrance; trips start and end here. */
  door: PointSchema,
});

export const HouseholdSchema = z.strictObject({
  id,
  homeId: id,
  surname: z.string().min(1).max(40),
});

export const PersonalitySchema = z.strictObject({
  openness: unit,
  conscientiousness: unit,
  extraversion: unit,
  agreeableness: unit,
  neuroticism: unit,
});

export const SkillsSchema = z.strictObject({
  farming: level,
  baking: level,
  crafting: level,
  commerce: level,
  management: level,
});

export const TravelSchema = z.strictObject({
  fromId: id,
  toId: id,
  departTick: tick,
  arriveTick: tick,
  purpose: z.enum(['leisure', 'home']),
});

export const NeedsSchema = z.strictObject({
  /** 0 = exhausted, 100 = fully rested. */
  energy: level,
});

export const CitizenSchema = z.strictObject({
  id,
  firstName: z.string().min(1).max(40),
  lastName: z.string().min(1).max(40),
  householdId: id,
  homeId: id,
  /** Tick of birth; negative for citizens born before genesis. */
  birthTick: tick,
  lifeStage: LifeStageSchema,
  education: EducationSchema,
  personality: PersonalitySchema,
  skills: SkillsSchema,
  balanceCents: cents,
  needs: NeedsSchema,
  activity: ActivitySchema,
  /** Tick at which the current activity started. */
  activitySince: tick,
  /** Building the citizen is in; null while travelling. */
  locationId: id.nullable(),
  travel: TravelSchema.nullable(),
});

export const EnvironmentSchema = z.strictObject({
  weather: WeatherSchema,
  /** Mean temperature of the current day (°C). */
  dailyMeanTempC: z.number(),
  /** Temperature at the current hour (°C). */
  temperatureC: z.number(),
});

export const LedgerSchema = z.strictObject({
  /** Total money ever created by explicit issuance events. */
  issuedCents: cents.min(0),
  /** Total money ever removed by explicit destruction events. */
  destroyedCents: cents.min(0),
});

export const WorldStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Same contract as at creation, so a restored state can always be re-created from its seed. */
  seed: SeedSchema,
  config: SimulationConfigSchema,
  /** Current simulation time; genesis is tick 0. */
  tick: tick.min(0),
  /** Sequence number for the next emitted event (events start at 1). */
  nextEventSeq: z.number().int().positive(),
  nextIds: z.strictObject({ citizen: id, building: id, household: id, block: id }),
  map: WorldMapSchema,
  buildings: z.array(BuildingSchema),
  households: z.array(HouseholdSchema),
  citizens: z.array(CitizenSchema),
  environment: EnvironmentSchema,
  ledger: LedgerSchema,
});

export type LifeStage = z.infer<typeof LifeStageSchema>;
export type Education = z.infer<typeof EducationSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type BuildingKind = z.infer<typeof BuildingKindSchema>;
export type Zone = z.infer<typeof ZoneSchema>;
export type Weather = z.infer<typeof WeatherSchema>;
export type SkillId = z.infer<typeof SkillSchema>;
export type PersonalityTrait = (typeof PERSONALITY_TRAITS)[number];
export type Point = z.infer<typeof PointSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type WorldMap = z.infer<typeof WorldMapSchema>;
export type Building = z.infer<typeof BuildingSchema>;
export type Household = z.infer<typeof HouseholdSchema>;
export type Personality = z.infer<typeof PersonalitySchema>;
export type Skills = z.infer<typeof SkillsSchema>;
export type Travel = z.infer<typeof TravelSchema>;
export type Citizen = z.infer<typeof CitizenSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Ledger = z.infer<typeof LedgerSchema>;
export type WorldState = z.infer<typeof WorldStateSchema>;
