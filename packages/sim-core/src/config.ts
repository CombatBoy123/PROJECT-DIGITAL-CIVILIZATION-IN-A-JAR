import { z } from 'zod';

/** Schema version of {@link SimulationConfig}. Stored alongside persisted configs. */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Model parameters of a civilization. Everything that can change simulation results
 * lives here (together with the seed); runtime concerns such as speed or invariant
 * checking do not.
 */
export const SimulationConfigSchema = z.strictObject({
  /** Number of citizens created at genesis. */
  population: z.number().int().min(10).max(5000).default(100),
  /** Calendar: days per season (4 seasons per year). One tick is one hour. */
  daysPerSeason: z.number().int().min(1).max(60).default(7),
  initialWealth: z
    .strictObject({
      /**
       * Mean adult endowment, in cents (elders receive 1.3×). The endowment is this value
       * times a product of four independent factors with mean 1, so it is the expected
       * value; the median is lower (≈ 0.85× at spread 0.5) because the product is skewed.
       */
      meanCents: z.number().int().min(0).max(100_000_000).default(50_000),
      /**
       * Dispersion in [0, 0.9]. Each adult's endowment is meanCents multiplied by the
       * product of four uniform factors drawn from [1 − spread, 1 + spread].
       */
      spread: z.number().min(0).max(0.9).default(0.5),
    })
    .prefault({}),
  lifeStages: z
    .strictObject({
      adultAge: z.number().int().min(14).max(25).default(18),
      elderAge: z.number().int().min(50).max(90).default(65),
    })
    .prefault({}),
  movement: z
    .strictObject({
      /** Road tiles a citizen walks per tick (hour). */
      walkTilesPerTick: z.number().int().min(4).max(200).default(24),
    })
    .prefault({}),
  stochastic: z
    .strictObject({
      /** When false, weather is permanently clear and temperature follows the seasonal baseline. */
      weather: z.boolean().default(true),
    })
    .prefault({}),
  /** Record a metric sample every N ticks. */
  metricsInterval: z.number().int().min(1).max(168).default(1),
});

export type SimulationConfig = z.output<typeof SimulationConfigSchema>;
export type SimulationConfigInput = z.input<typeof SimulationConfigSchema>;

/** Parse (and default) a configuration. Throws a ZodError on invalid input. */
export function parseConfig(input: unknown = {}): SimulationConfig {
  return SimulationConfigSchema.parse(input);
}

/** Seeds are short, printable identifiers so they can be typed, shared and logged. */
export const SeedSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Seed may contain letters, digits, ".", "_" and "-" only');
