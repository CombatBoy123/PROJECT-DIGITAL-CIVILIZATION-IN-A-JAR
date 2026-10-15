import { formatCalendar, metricDefinition, WEATHER, type MetricUnit } from '@civ/sim-core';
import type { Calendar } from '@civ/sim-core';

/*
 * Pure display formatting. Money is always integer cents in the simulation; it is
 * only converted to major units here, for display. A fixed locale keeps output
 * stable across browsers and in tests.
 */

const LOCALE = 'en-US';

const currency = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const currencyCompact = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

/** 123456 → "$1,234.56". Non-finite input renders as an em dash. */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return '—';
  return currency.format(cents / 100);
}

/** 12_345_600 → "$123.5K" (axis ticks and tight spaces). */
export function formatCentsCompact(cents: number): string {
  if (!Number.isFinite(cents)) return '—';
  return currencyCompact.format(cents / 100);
}

/** Thousands-separated integer. */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return integer.format(value);
}

/** Fixed number of decimals with thousands separators. */
export function formatDecimal(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 1 → "100%", 0.1234 → "12.3%". */
export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${formatDecimal(ratio * 100, digits)}%`;
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return compact.format(value);
}

/** Byte counts: 512 → "512 B", 2048 → "2.0 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** ISO timestamp → local date and time ("Oct 15, 2026, 14:03"). */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatTemperature(celsius: number): string {
  if (!Number.isFinite(celsius)) return '—';
  return `${formatDecimal(celsius, 1)} °C`;
}

/** "Tick 1,234 · Y1 spring D3 07:00". */
export function formatTickCalendar(tick: number, calendar: Calendar | null): string {
  const t = `Tick ${formatInteger(tick)}`;
  return calendar ? `${t} · ${formatCalendar(calendar)}` : t;
}

/** Shorten a hash for tables; the full value goes in a title attribute. */
export function shortHash(hash: string, length = 12): string {
  return hash.length > length ? `${hash.slice(0, length)}…` : hash;
}

/** "at_home" → "At home". */
export function humanize(identifier: string): string {
  const spaced = identifier.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Format a metric value according to its unit. Downsampled series may contain
 * bucket means, so integer units fall back to one decimal when not whole.
 */
export function formatMetricValue(unit: MetricUnit, value: number, mode: 'full' | 'axis' = 'full') {
  if (!Number.isFinite(value)) return '—';
  switch (unit) {
    case 'cents':
      return mode === 'axis' ? formatCentsCompact(value) : formatCents(value);
    case 'ratio':
      return formatPercent(value, mode === 'axis' ? 0 : 1);
    case 'persons':
      if (mode === 'axis') return formatCompact(value);
      return Number.isInteger(value) ? formatInteger(value) : formatDecimal(value, 1);
    case 'points':
      return formatDecimal(value, mode === 'axis' ? 0 : 1);
    case 'celsius':
      return mode === 'axis' ? `${formatDecimal(value, 0)}°` : formatTemperature(value);
    case 'code': {
      if (mode === 'axis') return formatDecimal(value, 0);
      const name = Number.isInteger(value) ? WEATHER[value] : undefined;
      return name ? `${value} (${name})` : formatDecimal(value, 2);
    }
  }
}

/** Human unit name shown next to chart titles. */
export const UNIT_LABELS: Record<MetricUnit, string> = {
  persons: 'persons',
  cents: 'currency',
  ratio: 'percent',
  points: 'points (0–100)',
  celsius: '°C',
  code: 'ordinal code',
};

/** Format a value of a metric identified by key (unknown keys render the raw number). */
export function formatMetricByKey(key: string, value: number): string {
  const def = metricDefinition(key);
  return def ? formatMetricValue(def.unit, value) : String(value);
}
