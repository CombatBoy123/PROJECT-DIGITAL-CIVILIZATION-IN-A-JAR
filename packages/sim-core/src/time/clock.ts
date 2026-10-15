import type { SimulationConfig } from '../config.js';

/** One tick is one simulated hour. */
export const TICKS_PER_DAY = 24;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export interface Calendar {
  /** Ticks elapsed since genesis (tick 0 = day 1, 00:00, first day of spring, year 1). */
  tick: number;
  /** 1-based day number since genesis. */
  day: number;
  /** Hour of day, 0–23. */
  hour: number;
  /** 0-based day within the current season. */
  dayOfSeason: number;
  /** 0-based day within the current year. */
  dayOfYear: number;
  season: Season;
  /** 1-based year number. */
  year: number;
}

export function ticksPerYear(config: Pick<SimulationConfig, 'daysPerSeason'>): number {
  return config.daysPerSeason * SEASONS.length * TICKS_PER_DAY;
}

/** Convert a tick into calendar time. Only ticks ≥ 0 are meaningful. */
export function calendarAt(
  tick: number,
  config: Pick<SimulationConfig, 'daysPerSeason'>,
): Calendar {
  if (!Number.isInteger(tick) || tick < 0) throw new RangeError(`calendarAt: invalid tick ${tick}`);
  const dayIndex = Math.floor(tick / TICKS_PER_DAY);
  const hour = tick - dayIndex * TICKS_PER_DAY;
  const daysPerYear = config.daysPerSeason * SEASONS.length;
  const yearIndex = Math.floor(dayIndex / daysPerYear);
  const dayOfYear = dayIndex - yearIndex * daysPerYear;
  const seasonIndex = Math.floor(dayOfYear / config.daysPerSeason);
  return {
    tick,
    day: dayIndex + 1,
    hour,
    dayOfSeason: dayOfYear - seasonIndex * config.daysPerSeason,
    dayOfYear,
    season: SEASONS[seasonIndex] as Season,
    year: yearIndex + 1,
  };
}

/** Whole years between two ticks (used for ages). */
export function wholeYearsBetween(
  fromTick: number,
  toTick: number,
  config: Pick<SimulationConfig, 'daysPerSeason'>,
): number {
  return Math.floor((toTick - fromTick) / ticksPerYear(config));
}

/** First hour of the night (22:00). */
export const NIGHT_START_HOUR = 22;
/** First hour after the night (06:00). */
export const NIGHT_END_HOUR = 6;

/** Night hours: 22:00–05:59. */
export function isNight(hour: number): boolean {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** Whole hours from the start of `hour` until the night begins at 22:00 (0 during the night). */
export function hoursUntilNight(hour: number): number {
  return isNight(hour) ? 0 : NIGHT_START_HOUR - hour;
}

/** Human-readable timestamp, e.g. "Y1 spring D3 07:00". */
export function formatCalendar(c: Calendar): string {
  return `Y${c.year} ${c.season} D${c.dayOfSeason + 1} ${String(c.hour).padStart(2, '0')}:00`;
}
