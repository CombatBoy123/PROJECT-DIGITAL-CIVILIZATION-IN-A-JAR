import type { MetricUnit } from '@civ/sim-core';
import { formatMetricValue } from './format';

/*
 * Pure axis helpers for the metric charts.
 *
 * The value axis is computed here instead of by the chart library so that
 *   - tick labels always carry enough precision to tell neighbouring ticks apart
 *     (a constant money supply of $177,287.92 must not read "$177.3K" five times),
 *   - constant series get an explicit, symmetric range around their value, and
 *   - shares (unit `ratio`) never show a range outside [0, 100 %].
 *
 * Season markers on the time axis are thinned so their labels never overlap: every
 * marker keeps its line, but only markers with room for their text are labelled.
 */

const LOCALE = 'en-US';

export interface ValueAxis {
  domain: [number, number];
  ticks: number[];
  /** Tick label formatter with the precision the tick step needs. */
  format: (value: number) => string;
}

/**
 * Smallest "nice" step (1, 2, 2.5 or 5 × 10^k) that is at least `raw`. With
 * `integer`, only whole steps qualify (at least 1, and never 2.5).
 */
export function niceStep(raw: number, integer = false): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  if (integer && raw < 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * magnitude;
    if (integer && !Number.isInteger(step)) continue;
    if (step >= raw * (1 - 1e-9)) return step;
  }
  return 10 * magnitude;
}

/** Fraction digits (0–6) needed to write every multiple of `step` exactly. */
export function digitsForStep(step: number): number {
  for (let d = 0; d <= 6; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, scaled)) return d;
  }
  return 6;
}

/**
 * Evenly spaced ticks covering [min, max] with about `count` intervals. The first and
 * last ticks are multiples of the step at or beyond the data extent; `integer` keeps
 * the step whole.
 */
export function niceTicks(
  min: number,
  max: number,
  count = 4,
  integer = false,
): { step: number; ticks: number[] } {
  const step = niceStep((max - min) / count, integer);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step * 1e-9 && i <= 100; i++) {
    // Round away floating-point noise (0.1 + 0.2) at the step's precision.
    ticks.push(Number((lo + i * step).toFixed(digitsForStep(step) + 2)));
  }
  return { step, ticks };
}

const formatters = new Map<string, Intl.NumberFormat>();
function numberFormat(digits: number, compact: boolean, currency: boolean): Intl.NumberFormat {
  const key = `${digits}|${compact}|${currency}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, {
      ...(currency ? { style: 'currency', currency: 'USD' } : {}),
      ...(compact ? { notation: 'compact' } : {}),
      minimumFractionDigits: compact ? 0 : digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, f);
  }
  return f;
}

/** Values from this magnitude on are written compactly ("12.5K"). */
const COMPACT_FROM = 10_000;

/**
 * Formatter for numbers `step` apart, up to `maxAbs` in magnitude (display units).
 * Compact notation divides by 10^3k, so the step needs more fraction digits there.
 */
function stepFormatter(step: number, maxAbs: number, currency: boolean) {
  const compact = maxAbs >= COMPACT_FROM;
  const scale = compact ? 1000 ** Math.floor(Math.log10(maxAbs) / 3) : 1;
  const digits = digitsForStep(step / scale);
  const f = numberFormat(digits, compact, currency);
  return (value: number) => (Number.isFinite(value) ? f.format(value) : '—');
}

/** Tick formatter for a metric unit, given the tick step and largest tick (raw units). */
export function axisFormatter(
  unit: MetricUnit,
  step: number,
  maxAbs: number,
): (value: number) => string {
  switch (unit) {
    case 'cents': {
      const f = stepFormatter(step / 100, maxAbs / 100, true);
      return (v) => f(v / 100);
    }
    case 'ratio': {
      const digits = digitsForStep(step * 100);
      return (v) =>
        Number.isFinite(v)
          ? `${(v * 100).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
          : '—';
    }
    case 'celsius': {
      const f = stepFormatter(step, maxAbs, false);
      return (v) => `${f(v)}°`;
    }
    case 'code':
      return (v) => formatMetricValue('code', v, 'axis');
    case 'persons':
    case 'points':
      return stepFormatter(step, maxAbs, false);
  }
}

/**
 * Value axis for a metric series: nice ticks over the data (shares clamped to
 * [0, 1] and anchored at 0), constant series padded around their value, and labels
 * precise enough to be distinct. Returns null when there is no finite value.
 */
export function valueAxis(unit: MetricUnit, values: readonly number[]): ValueAxis | null {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return null;

  if (unit === 'ratio') {
    min = 0;
    max = Math.min(1, Math.max(max, 0));
    if (max === 0) max = 1; // all zero: show the full share range rather than inventing one
  } else if (min === max) {
    // Constant series: a range around the value (whole units at least), not crossing
    // zero for a non-negative series.
    const pad = Math.max(Math.abs(min) * 0.05, unit === 'cents' ? 100 : 1);
    min = min >= 0 && unit !== 'celsius' ? Math.max(0, min - pad) : min - pad;
    max += pad;
  }

  // Head counts and ordinal codes are whole numbers: no "19.5 persons" gridlines.
  const { step, ticks } = niceTicks(min, max, 4, unit === 'code' || unit === 'persons');
  let domain: [number, number] = [ticks[0] ?? min, ticks[ticks.length - 1] ?? max];
  let shown = ticks;
  if (unit === 'ratio') {
    shown = ticks.filter((t) => t >= 0 && t <= 1);
    domain = [0, Math.min(1, domain[1])];
  }
  const maxAbs = Math.max(...shown.map((t) => Math.abs(t)), 0);
  return { domain, ticks: shown, format: axisFormatter(unit, step, maxAbs) };
}

export interface LabelledMarker<T> {
  marker: T;
  /** Whether this marker's label fits without overlapping the previous label. */
  labelled: boolean;
}

/**
 * Decide which time-axis markers get a text label. Markers are placed at
 * (tick − from) / (to − from) × width pixels; labels are centred on their marker
 * and estimated at `charPx` per character. Scanning left to right, a label is kept
 * when it fits inside [0, width] and starts at least `gapPx` after the previous
 * kept label ends. Every marker is returned (lines are always drawn).
 */
export function labelMarkers<T extends { tick: number; label: string }>(
  markers: readonly T[],
  domain: readonly [number, number],
  widthPx: number,
  options: { charPx?: number; gapPx?: number } = {},
): LabelledMarker<T>[] {
  const charPx = options.charPx ?? 6;
  const gapPx = options.gapPx ?? 8;
  const [from, to] = domain;
  const span = to - from;
  let lastEnd = -Infinity;
  return [...markers]
    .sort((a, b) => a.tick - b.tick)
    .map((marker) => {
      if (!(widthPx > 0) || !(span > 0)) return { marker, labelled: false };
      const x = ((marker.tick - from) / span) * widthPx;
      const half = (marker.label.length * charPx) / 2;
      const start = x - half;
      const end = x + half;
      const fits = start >= 0 && end <= widthPx && start >= lastEnd + gapPx;
      if (fits) lastEnd = end;
      return { marker, labelled: fits };
    });
}
