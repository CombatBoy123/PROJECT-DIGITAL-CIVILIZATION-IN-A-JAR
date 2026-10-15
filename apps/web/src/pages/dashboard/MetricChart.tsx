import { calendarAt, formatCalendar, type MetricDefinition } from '@civ/sim-core';
import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { EmptyState } from '../../components/Feedback';
import { UNIT_LABELS, formatInteger, formatMetricValue } from '../../lib/format';
import type { SeriesPoint } from '../../lib/metrics';
import { CHART } from './chart-theme';

/*
 * One metric as a single-series area chart (2px line, faint wash), with its written
 * definition and a data-table twin so no value is reachable only by hovering.
 * Season starts are drawn as reference lines on the shared time axis.
 */

export interface SeasonMarker {
  tick: number;
  label: string;
}

const CHART_HEIGHT = 170;
/** Rows shown in the table view; the full series is in the CSV export. */
const TABLE_ROWS = 200;

function ChartTooltip({
  active,
  payload,
  label,
  unit,
  daysPerSeason,
}: {
  active: boolean;
  payload: readonly { value?: unknown }[] | undefined;
  label: string | number | undefined;
  unit: MetricDefinition['unit'];
  daysPerSeason: number | null;
}) {
  const entry = payload?.[0];
  if (!active || !entry || typeof entry.value !== 'number' || typeof label !== 'number')
    return null;
  return (
    <div className="chart-tooltip">
      <strong className="num">{formatMetricValue(unit, entry.value)}</strong>
      <span>tick {formatInteger(label)}</span>
      {daysPerSeason !== null && Number.isInteger(label) && label >= 0 && (
        <span>{formatCalendar(calendarAt(label, { daysPerSeason }))}</span>
      )}
    </div>
  );
}

export function MetricChart({
  definition,
  points,
  seasons,
  domain,
  daysPerSeason,
  bucketTicks,
  stale,
}: {
  definition: MetricDefinition;
  points: SeriesPoint[];
  seasons: SeasonMarker[];
  /** X-axis domain [from, to] in ticks, or undefined for the data extent. */
  domain: [number, number] | undefined;
  daysPerSeason: number | null;
  bucketTicks: number;
  /** True while a refetch is in flight: hold the previous render at reduced opacity. */
  stale: boolean;
}) {
  const titleId = useId();
  const latest = points[points.length - 1];
  const unit = definition.unit;
  const areaType = unit === 'code' ? 'stepAfter' : 'linear';

  return (
    <article
      className="chart-card"
      aria-labelledby={titleId}
      data-testid="metric-chart"
      data-metric={definition.key}
    >
      <header className="chart-head">
        <div>
          <h3 id={titleId} className="chart-title">
            {definition.label}
          </h3>
          <div className="chart-badges">
            <span className="badge" title="Unit">
              {UNIT_LABELS[unit]}
            </span>
            <span className="badge" title="How the metric relates to time">
              {definition.kind}
            </span>
          </div>
        </div>
        {latest && (
          <div className="chart-latest">
            <span className="muted small">latest · t{formatInteger(latest.tick)}</span>
            <strong className="num">{formatMetricValue(unit, latest.value)}</strong>
          </div>
        )}
      </header>
      <details className="disclosure disclosure-compact">
        <summary>Definition</summary>
        <p className="small">{definition.description}</p>
        <p className="small">
          <span className="muted">Formula: </span>
          <code data-testid="metric-formula">{definition.formula}</code>
        </p>
        <p className="small muted">
          Kind <strong>{definition.kind}</strong>
          {bucketTicks > 1
            ? ` · downsampled: one point per ${formatInteger(bucketTicks)} ticks, aggregated according to the kind.`
            : ' · raw samples.'}
        </p>
      </details>
      <div className={`chart-body ${stale ? 'is-stale' : ''}`} style={{ height: CHART_HEIGHT }}>
        {points.length === 0 ? (
          <EmptyState title="No samples in this range" />
        ) : (
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} strokeWidth={1} />
              <XAxis
                dataKey="tick"
                type="number"
                domain={domain ?? ['dataMin', 'dataMax']}
                allowDataOverflow
                tickFormatter={(t: number) => formatInteger(t)}
                tick={{ fill: CHART.tickText, fontSize: 11 }}
                stroke={CHART.axis}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                width={64}
                tickFormatter={(v: number) => formatMetricValue(unit, v, 'axis')}
                tick={{ fill: CHART.tickText, fontSize: 11 }}
                stroke={CHART.axis}
                tickLine={false}
                axisLine={false}
                domain={unit === 'ratio' ? [0, 'auto'] : ['auto', 'auto']}
              />
              {seasons.map((s) => (
                <ReferenceLine
                  key={s.tick}
                  x={s.tick}
                  stroke={CHART.reference}
                  strokeWidth={1}
                  label={{
                    value: s.label,
                    position: 'insideTopLeft',
                    fill: CHART.referenceText,
                    fontSize: 10,
                  }}
                />
              ))}
              <Tooltip
                cursor={{ stroke: CHART.cursor, strokeWidth: 1 }}
                isAnimationActive={false}
                content={(props: TooltipContentProps) => (
                  <ChartTooltip
                    active={props.active}
                    payload={props.payload}
                    label={props.label}
                    unit={unit}
                    daysPerSeason={daysPerSeason}
                  />
                )}
              />
              <Area
                type={areaType}
                dataKey="value"
                name={definition.label}
                stroke={CHART.series}
                strokeWidth={2}
                fill={CHART.series}
                fillOpacity={CHART.seriesFillOpacity}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, stroke: CHART.surface, strokeWidth: 2, fill: CHART.series }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {points.length > 0 && (
        <details className="disclosure disclosure-compact">
          <summary>Data table</summary>
          <div className="table-scroll chart-table">
            <table className="table table-compact">
              <caption className="visually-hidden">{definition.label} by tick</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Tick
                  </th>
                  <th scope="col" className="num">
                    {definition.label}
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.slice(-TABLE_ROWS).map((p) => (
                  <tr key={p.tick}>
                    <td className="num">{formatInteger(p.tick)}</td>
                    <td className="num">{formatMetricValue(unit, p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {points.length > TABLE_ROWS && (
              <p className="muted small">
                Showing the latest {TABLE_ROWS} of {formatInteger(points.length)} points. The full
                series is available as CSV in the observatory's Lab tab.
              </p>
            )}
          </div>
        </details>
      )}
    </article>
  );
}
