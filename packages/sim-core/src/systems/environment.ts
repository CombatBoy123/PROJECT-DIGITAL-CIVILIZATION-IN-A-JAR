import type { SimSystem, TickContext } from '../engine/context.js';
import type { Rng } from '../rng/rng.js';
import type { Environment, Weather } from '../state/schema.js';
import { WEATHER } from '../state/schema.js';
import type { Season } from '../time/clock.js';

/*
 * Stage 1 — environment.
 *
 * Deterministic part: the seasonal temperature baseline and the hour-of-day
 * temperature profile. Stochastic part (optional, `config.stochastic.weather`):
 * a daily weather draw from a season-specific Markov chain and a daily
 * temperature deviation. With the stochastic part disabled the weather is always
 * "clear" and the temperature is exactly the baseline.
 */

/** Seasonal daily-mean temperature baseline (°C). */
export const SEASON_BASE_TEMP_C: Record<Season, number> = {
  spring: 12,
  summer: 22,
  autumn: 11,
  winter: 1,
};

/** Hour-of-day offset from the daily mean (°C): coolest before dawn, warmest mid-afternoon. */
export const HOURLY_TEMP_OFFSET_C: readonly number[] = [
  -3, -3.5, -4, -4, -4.5, -4.5, -3.5, -2.5, -1, 0.5, 1.5, 2.5, 3.5, 4, 4.5, 4.5, 4, 3, 2, 1, 0, -1,
  -1.5, -2.5,
];

/** Standard deviation of the daily temperature deviation (°C), when stochastic weather is on. */
export const DAILY_TEMP_SD_C = 2.5;

/**
 * Daily weather transition weights per season: row = yesterday's weather, columns =
 * today's weather in the order of WEATHER (clear, cloudy, rain, storm). Integers,
 * each row sums to 100.
 */
export const WEATHER_TRANSITIONS: Record<Season, Record<Weather, readonly number[]>> = {
  spring: {
    clear: [55, 30, 13, 2],
    cloudy: [30, 40, 25, 5],
    rain: [20, 35, 38, 7],
    storm: [20, 40, 30, 10],
  },
  summer: {
    clear: [70, 20, 7, 3],
    cloudy: [45, 35, 14, 6],
    rain: [40, 30, 22, 8],
    storm: [45, 30, 15, 10],
  },
  autumn: {
    clear: [45, 35, 17, 3],
    cloudy: [25, 40, 28, 7],
    rain: [15, 35, 40, 10],
    storm: [15, 35, 35, 15],
  },
  winter: {
    clear: [45, 40, 10, 5],
    cloudy: [25, 50, 15, 10],
    rain: [20, 45, 25, 10],
    storm: [20, 40, 20, 20],
  },
};

function roundTenth(x: number): number {
  return Math.round(x * 10) / 10;
}

function drawDailyMean(season: Season, rng: Rng | null): number {
  const base = SEASON_BASE_TEMP_C[season];
  return rng ? roundTenth(rng.normal(base, DAILY_TEMP_SD_C)) : base;
}

function hourlyTemperature(dailyMean: number, hour: number): number {
  return roundTenth(dailyMean + (HOURLY_TEMP_OFFSET_C[hour] ?? 0));
}

/** Environment at genesis (tick 0 = first day of spring, midnight). */
export function initialEnvironment(stochastic: boolean, rng: Rng): Environment {
  const dailyMeanTempC = drawDailyMean('spring', stochastic ? rng : null);
  return { weather: 'clear', dailyMeanTempC, temperatureC: hourlyTemperature(dailyMeanTempC, 0) };
}

export const environmentSystem: SimSystem = {
  name: 'environment',
  stage: 1,
  run(ctx: TickContext): void {
    const { state, calendar, events } = ctx;
    const env = state.environment;
    const stochastic = state.config.stochastic.weather;

    if (calendar.hour === 0) {
      if (calendar.dayOfSeason === 0) {
        events.emit('SeasonStarted', { season: calendar.season, year: calendar.year });
      }
      const rng = stochastic ? ctx.rng('weather') : null;
      const previous = env.weather;
      let next: Weather = 'clear';
      if (rng) {
        const row = WEATHER_TRANSITIONS[calendar.season][previous];
        next = WEATHER[rng.weightedIndex(row)] ?? previous;
      }
      env.dailyMeanTempC = drawDailyMean(calendar.season, rng);
      env.weather = next;
      if (next !== previous) {
        events.emit('WeatherChanged', {
          from: previous,
          to: next,
          dailyMeanTempC: env.dailyMeanTempC,
        });
      }
    }
    env.temperatureC = hourlyTemperature(env.dailyMeanTempC, calendar.hour);
  },
};
