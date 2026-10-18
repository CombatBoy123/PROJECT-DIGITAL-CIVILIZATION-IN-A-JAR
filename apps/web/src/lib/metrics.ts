import { METRIC_DEFINITIONS, type MetricDefinition } from '@civ/sim-core';
import type { MetricSeriesResponse } from '@civ/shared';

/*
 * Pure helpers for the dashboard: metric grouping, time-range resolution and turning
 * the API's row-oriented series into per-metric points.
 */

export type MetricCategory = MetricDefinition['category'];

export const CATEGORY_LABELS: Record<MetricCategory, string> = {
  population: 'Population',
  activity: 'Activity',
  needs: 'Needs',
  money: 'Money',
  wealth: 'Wealth distribution',
  environment: 'Environment',
};

/** Definitions grouped by category, in registry order. */
export function groupDefinitions(
  defs: readonly MetricDefinition[] = METRIC_DEFINITIONS,
): { category: MetricCategory; definitions: MetricDefinition[] }[] {
  const groups = new Map<MetricCategory, MetricDefinition[]>();
  for (const d of defs) {
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }
  return [...groups].map(([category, definitions]) => ({ category, definitions }));
}

export interface SeriesPoint {
  tick: number;
  value: number;
}

/** Extract one metric's points from a series response; missing or non-finite values are skipped. */
export function seriesFor(response: MetricSeriesResponse | undefined, key: string): SeriesPoint[] {
  if (!response) return [];
  const column = response.keys.indexOf(key as MetricSeriesResponse['keys'][number]);
  if (column < 0) return [];
  const points: SeriesPoint[] = [];
  for (const row of response.rows) {
    const tick = row[0];
    const value = row[column + 1];
    if (typeof tick === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      points.push({ tick, value });
    }
  }
  return points;
}

export type RangePreset = 'day' | 'week' | 'all' | 'custom';

export const RANGE_PRESETS: { id: RangePreset; label: string; ticks?: number }[] = [
  { id: 'day', label: 'Last day', ticks: 24 },
  { id: 'week', label: 'Last week', ticks: 24 * 7 },
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
];

export interface TickRange {
  fromTick?: number;
  toTick?: number;
}

/**
 * Resolve a range selection against an anchor tick (the latest durable tick, so the
 * window moves once per checkpoint rather than on every frame). Returns null for an
 * invalid custom range.
 */
export function resolveRange(
  preset: RangePreset,
  anchorTick: number,
  custom: { from: string; to: string },
): TickRange | null {
  if (preset === 'all') return {};
  if (preset === 'custom') {
    const from = custom.from.trim() === '' ? undefined : Number(custom.from);
    const to = custom.to.trim() === '' ? undefined : Number(custom.to);
    const valid = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0);
    if (!valid(from) || !valid(to)) return null;
    if (from !== undefined && to !== undefined && from > to) return null;
    return { fromTick: from, toTick: to };
  }
  const span = RANGE_PRESETS.find((p) => p.id === preset)?.ticks ?? 0;
  return { fromTick: Math.max(0, anchorTick - span), toTick: anchorTick };
}

/** Points to request for a chart of the given pixel width (API bounds: 10–5000). */
export function maxPointsFor(widthPx: number | null): number {
  if (widthPx === null || !Number.isFinite(widthPx)) return 600;
  return Math.min(5000, Math.max(10, Math.round(widthPx)));
}
