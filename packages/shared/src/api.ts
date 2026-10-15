import {
  ACTIVITIES,
  BUILDING_KINDS,
  EDUCATION_LEVELS,
  LIFE_STAGES,
  SeedSchema,
  SimulationConfigSchema,
  type Calendar,
  type CitizenFrameTuple,
  type EntityRef,
  type EventType,
  type MetricKey,
  type SimulationConfig,
  type Skills,
  type Weather,
  type WorldLayout,
} from '@civ/sim-core';
import { z } from 'zod';

/*
 * HTTP contract between the server and clients. Request schemas are enforced on the
 * server; response types describe what clients receive. See docs/API.md.
 */

// ---------------------------------------------------------------------------
// Errors

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'CONFIRMATION_REQUIRED',
  'HALTED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Shared pieces

export const CivilizationIdSchema = z.uuid();
export const CivilizationParamsSchema = z.strictObject({ id: CivilizationIdSchema });

export const CivilizationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u, "Use letters, digits, spaces and . _ ' -");

/** Speeds offered by the UI; the API accepts any integer in [0, 1000]. 0 = as fast as possible. */
export const SPEED_PRESETS = [1, 2, 5, 10, 25, 50, 100, 0] as const;
export const SpeedSchema = z.number().int().min(0).max(1000);

export const MAX_STEPS_PER_REQUEST = 1000;

export const CIVILIZATION_STATUSES = ['paused', 'running', 'halted'] as const;
export type CivilizationStatus = (typeof CIVILIZATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Requests

export const CreateCivilizationRequestSchema = z.strictObject({
  name: CivilizationNameSchema,
  /** Omit to let the server generate a random seed (which is then recorded). */
  seed: SeedSchema.optional(),
  config: SimulationConfigSchema.optional(),
});
export type CreateCivilizationRequest = z.input<typeof CreateCivilizationRequestSchema>;

export const ControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('pause') }),
  z.strictObject({
    action: z.literal('step'),
    steps: z.number().int().min(1).max(MAX_STEPS_PER_REQUEST).default(1),
  }),
]);
export type ControlRequest = z.input<typeof ControlRequestSchema>;

export const SpeedRequestSchema = z.strictObject({ ticksPerSecond: SpeedSchema });

/** Destructive actions must repeat the civilization's exact name. */
export const ConfirmRequestSchema = z.strictObject({ confirm: z.string().max(80) });

export const CreateSnapshotRequestSchema = z.strictObject({
  name: CivilizationNameSchema,
  note: z.string().trim().max(500).optional(),
});

const optionalInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional();

export const CitizenListQuerySchema = z.strictObject({
  search: z.string().trim().max(80).optional(),
  lifeStage: z.enum(LIFE_STAGES).optional(),
  activity: z.enum(ACTIVITIES).optional(),
  education: z.enum(EDUCATION_LEVELS).optional(),
  householdId: optionalInt(1, 10_000_000),
  sort: z.enum(['id', 'name', 'balance', 'energy', 'age']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type CitizenListQuery = z.input<typeof CitizenListQuerySchema>;

export const BuildingListQuerySchema = z.strictObject({
  kind: z.enum(BUILDING_KINDS).optional(),
  search: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const csv = z
  .string()
  .max(2000)
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0),
  );

export const EventQuerySchema = z.strictObject({
  /** Keyset cursor: return events with seq < before (newest first). */
  before: optionalInt(1, Number.MAX_SAFE_INTEGER),
  /** Keyset cursor: return events with seq > after (oldest first). */
  after: optionalInt(0, Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  types: csv.optional(),
  citizenId: optionalInt(1, 10_000_000),
  buildingId: optionalInt(1, 10_000_000),
  householdId: optionalInt(1, 10_000_000),
  fromTick: optionalInt(0, 2_000_000_000),
  toTick: optionalInt(0, 2_000_000_000),
});
export type EventQuery = z.input<typeof EventQuerySchema>;

export const MetricsQuerySchema = z.strictObject({
  keys: csv.optional(),
  fromTick: optionalInt(0, 2_000_000_000),
  toTick: optionalInt(0, 2_000_000_000),
  maxPoints: z.coerce.number().int().min(10).max(5000).default(600),
});
export type MetricsQuery = z.input<typeof MetricsQuerySchema>;

// ---------------------------------------------------------------------------
// Responses

export interface CivilizationSummary {
  id: string;
  name: string;
  seed: string;
  status: CivilizationStatus;
  /** Target ticks per second (0 = as fast as possible). */
  speed: number;
  /** Tick of the latest durable checkpoint. */
  durableTick: number;
  /** Current in-memory tick when the civilization is loaded, else the durable tick. */
  tick: number;
  calendar: Calendar;
  population: number;
  engineVersion: string;
  haltReason: string | null;
  /** Last persistence error, if the most recent checkpoint attempt failed. */
  lastError: string | null;
  loaded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CivilizationDetail extends CivilizationSummary {
  config: SimulationConfig;
  configSchemaVersion: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  /** Tick the projection represents. */
  asOfTick: number;
}

export interface CitizenListItem {
  id: number;
  firstName: string;
  lastName: string;
  ageYears: number;
  lifeStage: (typeof LIFE_STAGES)[number];
  education: (typeof EDUCATION_LEVELS)[number];
  activity: (typeof ACTIVITIES)[number];
  energy: number;
  balanceCents: number;
  householdId: number;
  homeBuildingId: number;
  locationBuildingId: number | null;
}

export interface CitizenDetail extends CitizenListItem {
  birthTick: number;
  personality: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  skills: Skills;
  destinationBuildingId: number | null;
  home: { id: number; name: string };
  location: { id: number; name: string; kind: (typeof BUILDING_KINDS)[number] } | null;
  householdMembers: { id: number; firstName: string; lastName: string; ageYears: number }[];
  asOfTick: number;
}

export interface BuildingListItem {
  id: number;
  kind: (typeof BUILDING_KINDS)[number];
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  capacity: number;
}

export interface BuildingDetail extends BuildingListItem {
  residents: {
    id: number;
    firstName: string;
    lastName: string;
    activity: (typeof ACTIVITIES)[number];
  }[];
  occupants: {
    id: number;
    firstName: string;
    lastName: string;
    activity: (typeof ACTIVITIES)[number];
  }[];
  asOfTick: number;
}

export interface EventDto {
  seq: number;
  tick: number;
  type: EventType;
  payload: Record<string, unknown>;
  refs: EntityRef[];
  causeSeq: number | null;
}

export interface EventPage {
  items: EventDto[];
  /** Cursor for the next page in the same direction, or null when exhausted. */
  nextCursor: number | null;
}

export interface MetricSeriesResponse {
  keys: MetricKey[];
  /** One row per (possibly aggregated) sample: [tick, ...values in `keys` order]. */
  rows: number[][];
  /** Ticks per bucket when downsampled (1 = raw samples). */
  bucketTicks: number;
  fromTick: number;
  toTick: number;
}

export interface SnapshotDto {
  id: string;
  name: string;
  note: string | null;
  tick: number;
  stateHash: string;
  sizeBytes: number;
  createdAt: string;
  detachedAt: string | null;
}

export interface AuditEntryDto {
  id: number;
  action: string;
  actor: string;
  tick: number | null;
  details: unknown;
  createdAt: string;
}

export type LayoutResponse = WorldLayout & { asOfTick: number };

export interface MetaResponse {
  engineVersion: string;
  authMode: 'disabled' | 'token';
  readRequiresToken: boolean;
  frameRate: number;
  maxStepsPerRequest: number;
}

export interface HealthResponse {
  ok: boolean;
  database: 'up' | 'down';
}

/** Generic list wrapper for small, unpaginated collections (civilizations, snapshots). */
export interface ListResponse<T> {
  items: T[];
}

export const AuditQuerySchema = z.strictObject({
  /** Keyset cursor: return entries with id < before (newest first). */
  before: optionalInt(1, Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.input<typeof AuditQuerySchema>;

export interface AuditPage {
  items: AuditEntryDto[];
  nextCursor: number | null;
}

/** Current positions of every citizen (same shape as the stream's keyframe). */
export interface FrameResponse {
  tick: number;
  calendar: Calendar;
  weather: Weather;
  temperatureC: number;
  citizens: CitizenFrameTuple[];
}

/** Raw (not downsampled) metric samples as CSV. */
export const MetricsExportQuerySchema = z.strictObject({
  keys: csv.optional(),
  fromTick: optionalInt(0, 2_000_000_000),
  toTick: optionalInt(0, 2_000_000_000),
});

/** Events as NDJSON (one EventDto per line, ascending seq), streamed in pages by the server. */
export const EventsExportQuerySchema = z.strictObject({
  types: csv.optional(),
  fromTick: optionalInt(0, 2_000_000_000),
  toTick: optionalInt(0, 2_000_000_000),
});

/** Experiment configuration export: everything needed to recreate the run's genesis. */
export interface ConfigExport {
  format: 'civ-config';
  formatVersion: 1;
  name: string;
  seed: string;
  engineVersion: string;
  configSchemaVersion: number;
  config: SimulationConfig;
  exportedAtTick: number;
  stateHashAtExport: string;
}
