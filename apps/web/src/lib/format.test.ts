import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCents,
  formatCentsCompact,
  formatInteger,
  formatMetricValue,
  formatPercent,
  formatTickCalendar,
  humanize,
  shortHash,
} from './format';

describe('formatCents', () => {
  it('formats integer cents as currency with two decimals', () => {
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
  });

  it('handles negative and non-finite values', () => {
    expect(formatCents(-250)).toBe('-$2.50');
    expect(formatCents(Number.NaN)).toBe('—');
    expect(formatCents(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('compacts large amounts for axes', () => {
    expect(formatCentsCompact(12_345_600)).toBe('$123.5K');
  });
});

describe('number formatting', () => {
  it('formats integers, percentages and bytes', () => {
    expect(formatInteger(1234567)).toBe('1,234,567');
    expect(formatPercent(0.1234)).toBe('12.3%');
    expect(formatPercent(1, 0)).toBe('100%');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });

  it('humanizes identifiers', () => {
    expect(humanize('at_home')).toBe('At home');
    expect(humanize('CitizenCreated')).toBe('Citizen created');
  });

  it('shortens hashes', () => {
    expect(shortHash('abcdef0123456789', 6)).toBe('abcdef…');
    expect(shortHash('abc', 6)).toBe('abc');
  });

  it('combines tick and calendar', () => {
    const calendar = {
      tick: 30,
      day: 2,
      hour: 6,
      dayOfSeason: 1,
      dayOfYear: 1,
      season: 'spring',
      year: 1,
    } as const;
    expect(formatTickCalendar(30, calendar)).toBe('Tick 30 · Y1 spring D2 06:00');
    expect(formatTickCalendar(1200, null)).toBe('Tick 1,200');
  });
});

describe('formatMetricValue', () => {
  it('formats by unit', () => {
    expect(formatMetricValue('cents', 5_000_000)).toBe('$50,000.00');
    expect(formatMetricValue('ratio', 0.25)).toBe('25.0%');
    expect(formatMetricValue('persons', 120)).toBe('120');
    expect(formatMetricValue('persons', 120.5)).toBe('120.5');
    expect(formatMetricValue('points', 63.27)).toBe('63.3');
    expect(formatMetricValue('celsius', 12.34)).toBe('12.3 °C');
    expect(formatMetricValue('code', 2)).toBe('2 (rain)');
    expect(formatMetricValue('code', 1.5)).toBe('1.50');
  });

  it('uses compact axis labels', () => {
    expect(formatMetricValue('cents', 5_000_000, 'axis')).toBe('$50K');
    expect(formatMetricValue('ratio', 0.25, 'axis')).toBe('25%');
    expect(formatMetricValue('persons', 1500, 'axis')).toBe('1.5K');
  });
});
