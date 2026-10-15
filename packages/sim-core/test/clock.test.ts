import { describe, expect, it } from 'vitest';
import {
  calendarAt,
  formatCalendar,
  isNight,
  parseConfig,
  ticksPerYear,
  wholeYearsBetween,
} from '../src/index.js';

const config = parseConfig({ daysPerSeason: 7 });

describe('clock', () => {
  it('starts on day 1, 00:00, spring, year 1', () => {
    expect(calendarAt(0, config)).toEqual({
      tick: 0,
      day: 1,
      hour: 0,
      dayOfSeason: 0,
      dayOfYear: 0,
      season: 'spring',
      year: 1,
    });
  });

  it('rolls hours, days, seasons and years', () => {
    expect(calendarAt(23, config).hour).toBe(23);
    expect(calendarAt(24, config)).toMatchObject({ day: 2, hour: 0, dayOfSeason: 1 });
    expect(calendarAt(7 * 24, config)).toMatchObject({ season: 'summer', dayOfSeason: 0 });
    expect(calendarAt(21 * 24 + 5, config)).toMatchObject({ season: 'winter', hour: 5 });
    expect(calendarAt(ticksPerYear(config), config)).toMatchObject({
      year: 2,
      season: 'spring',
      dayOfYear: 0,
    });
  });

  it('computes year length from the configuration', () => {
    expect(ticksPerYear(config)).toBe(7 * 4 * 24);
    expect(ticksPerYear(parseConfig({ daysPerSeason: 10 }))).toBe(960);
  });

  it('computes whole years between ticks', () => {
    const tpy = ticksPerYear(config);
    expect(wholeYearsBetween(-tpy * 30, 0, config)).toBe(30);
    expect(wholeYearsBetween(-tpy * 30 + 1, 0, config)).toBe(29);
  });

  it('defines night as 22:00–05:59', () => {
    expect([21, 22, 23, 0, 5, 6].map(isNight)).toEqual([false, true, true, true, true, false]);
  });

  it('rejects negative or fractional ticks', () => {
    expect(() => calendarAt(-1, config)).toThrow(RangeError);
    expect(() => calendarAt(1.5, config)).toThrow(RangeError);
  });

  it('formats a readable timestamp', () => {
    expect(formatCalendar(calendarAt(24 + 7, config))).toBe('Y1 spring D2 07:00');
  });
});
