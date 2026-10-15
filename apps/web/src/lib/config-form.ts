import { CreateCivilizationRequestSchema, type CreateCivilizationRequest } from '@civ/shared';
import { SimulationConfigSchema, type SimulationConfig } from '@civ/sim-core';
import type { z } from 'zod';

/*
 * Form model for creating a civilization. Defaults and bounds are read from the
 * engine's SimulationConfigSchema, so the form can never drift from what the server
 * validates. Values are kept as strings while editing and converted on submit.
 */

type NumberSchema = z.ZodDefault<z.ZodNumber>;

export interface NumberBounds {
  min: number | undefined;
  max: number | undefined;
  integer: boolean;
}

function boundsOf(schema: NumberSchema): NumberBounds {
  const inner = schema.unwrap();
  return {
    min: inner.minValue ?? undefined,
    max: inner.maxValue ?? undefined,
    integer: inner.isInt,
  };
}

const shape = SimulationConfigSchema.shape;

/** Numeric config fields, addressed by their dotted path inside `config`. */
export const NUMERIC_FIELDS = [
  {
    path: 'population',
    label: 'Population',
    hint: 'Citizens created at genesis.',
    schema: shape.population,
  },
  {
    path: 'daysPerSeason',
    label: 'Days per season',
    hint: 'Calendar length; a year has four seasons. One tick is one hour.',
    schema: shape.daysPerSeason,
  },
  {
    path: 'initialWealth.meanCents',
    label: 'Initial wealth mean (cents)',
    hint: 'Expected (mean) adult endowment in integer cents; elders receive 1.3×. The median is lower, about 85 % of the mean at spread 0.5.',
    schema: shape.initialWealth.unwrap().shape.meanCents,
  },
  {
    path: 'initialWealth.spread',
    label: 'Initial wealth spread',
    hint: 'Dispersion: each endowment is the mean × four uniform factors in [1 − spread, 1 + spread].',
    schema: shape.initialWealth.unwrap().shape.spread,
    step: 0.05,
  },
  {
    path: 'lifeStages.adultAge',
    label: 'Adult age (years)',
    hint: 'Age at which a child becomes an adult.',
    schema: shape.lifeStages.unwrap().shape.adultAge,
  },
  {
    path: 'lifeStages.elderAge',
    label: 'Elder age (years)',
    hint: 'Age at which an adult becomes an elder.',
    schema: shape.lifeStages.unwrap().shape.elderAge,
  },
  {
    path: 'movement.walkTilesPerTick',
    label: 'Walk speed (road tiles per tick)',
    hint: 'How far a citizen walks in one simulated hour.',
    schema: shape.movement.unwrap().shape.walkTilesPerTick,
  },
  {
    path: 'metricsInterval',
    label: 'Metrics interval (ticks)',
    hint: 'A metric sample is recorded every N ticks.',
    schema: shape.metricsInterval,
  },
] as const satisfies readonly {
  path: string;
  label: string;
  hint: string;
  schema: NumberSchema;
  step?: number;
}[];

export type NumericFieldPath = (typeof NUMERIC_FIELDS)[number]['path'];

export const FIELD_BOUNDS: Record<NumericFieldPath, NumberBounds> = Object.fromEntries(
  NUMERIC_FIELDS.map((f) => [f.path, boundsOf(f.schema)]),
) as Record<NumericFieldPath, NumberBounds>;

/** Engine defaults (the same values the server would apply). */
export const CONFIG_DEFAULTS: SimulationConfig = SimulationConfigSchema.parse({});

export interface CreateFormValues {
  name: string;
  seed: string;
  numbers: Record<NumericFieldPath, string>;
  stochasticWeather: boolean;
}

function readPath(config: SimulationConfig, path: string): number {
  let value: unknown = config;
  for (const part of path.split('.')) value = (value as Record<string, unknown>)[part];
  return value as number;
}

export function initialFormValues(): CreateFormValues {
  return {
    name: '',
    seed: '',
    numbers: Object.fromEntries(
      NUMERIC_FIELDS.map((f) => [f.path, String(readPath(CONFIG_DEFAULTS, f.path))]),
    ) as Record<NumericFieldPath, string>,
    stochasticWeather: CONFIG_DEFAULTS.stochastic.weather,
  };
}

/** Empty or non-numeric text becomes NaN so the schema reports it as invalid. */
function toNumber(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

/** Build the request body from form values (unvalidated). */
export function toRequest(values: CreateFormValues): CreateCivilizationRequest {
  const n = (path: NumericFieldPath) => toNumber(values.numbers[path]);
  const seed = values.seed.trim();
  return {
    name: values.name.trim(),
    ...(seed ? { seed } : {}),
    config: {
      population: n('population'),
      daysPerSeason: n('daysPerSeason'),
      initialWealth: {
        meanCents: n('initialWealth.meanCents'),
        spread: n('initialWealth.spread'),
      },
      lifeStages: { adultAge: n('lifeStages.adultAge'), elderAge: n('lifeStages.elderAge') },
      movement: { walkTilesPerTick: n('movement.walkTilesPerTick') },
      stochastic: { weather: values.stochasticWeather },
      metricsInterval: n('metricsInterval'),
    },
  };
}

/** Field errors keyed by request path ("name", "seed", "config.population", …). */
export type FieldErrors = Record<string, string>;

/** Validate with the shared request schema (the same one the server enforces). */
export function validateRequest(request: CreateCivilizationRequest): FieldErrors {
  const errors: FieldErrors = {};
  const result = CreateCivilizationRequestSchema.safeParse(request);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.map(String).join('.') || 'form';
      errors[key] ??= issue.code === 'invalid_type' ? 'Enter a number.' : issue.message;
    }
  }
  return errors;
}

/** Map server-side validation paths to form keys (server may omit or add a prefix). */
export function normalizeIssuePath(path: string): string {
  return path.replace(/^body\./, '');
}
