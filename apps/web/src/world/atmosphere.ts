import type { Weather } from '@civ/sim-core';

/*
 * Ambient presentation derived from the frame header (pure; no PixiJS): a night tint
 * that follows the calendar hour and a light rain/storm overlay that follows the
 * weather. Both are deliberately subtle and purely cosmetic — the map must stay
 * readable at midnight in a storm.
 */

/** Maximum opacity of the night tint (reached between dusk end and dawn start). */
export const NIGHT_MAX_ALPHA = 0.38;
const DAWN_START = 5;
const DAWN_END = 7.5;
const DUSK_START = 18;
const DUSK_END = 21.5;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Opacity of the night tint for an hour of day in [0, 24) (fractional hours give
 * a smooth dusk and dawn while the simulation runs).
 */
export function nightAlpha(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= DAWN_END && h <= DUSK_START) return 0;
  if (h > DUSK_START && h < DUSK_END) return NIGHT_MAX_ALPHA * smoothstep(DUSK_START, DUSK_END, h);
  if (h > DAWN_START && h < DAWN_END)
    return NIGHT_MAX_ALPHA * (1 - smoothstep(DAWN_START, DAWN_END, h));
  return NIGHT_MAX_ALPHA;
}

/** Fractional hour of day at a fractional render tick (one tick = one hour). */
export function hourAt(calendarHour: number, frameTick: number, renderTick: number): number {
  return (calendarHour + Math.max(0, renderTick - frameTick)) % 24;
}

export interface WeatherOverlay {
  /** Opacity of the rain streak layer (0 = no rain). */
  rainAlpha: number;
  /** Streak fall speed in screen pixels per second. */
  rainSpeed: number;
  /** Horizontal drift (wind) in screen pixels per second. */
  rainDrift: number;
  /** Extra darkening of the scene. */
  darken: number;
}

const WEATHER_OVERLAYS: Readonly<Record<Weather, WeatherOverlay>> = {
  clear: { rainAlpha: 0, rainSpeed: 0, rainDrift: 0, darken: 0 },
  cloudy: { rainAlpha: 0, rainSpeed: 0, rainDrift: 0, darken: 0.06 },
  rain: { rainAlpha: 0.22, rainSpeed: 420, rainDrift: 40, darken: 0.08 },
  storm: { rainAlpha: 0.34, rainSpeed: 720, rainDrift: 160, darken: 0.16 },
};

export function weatherOverlay(weather: Weather): WeatherOverlay {
  return WEATHER_OVERLAYS[weather];
}
