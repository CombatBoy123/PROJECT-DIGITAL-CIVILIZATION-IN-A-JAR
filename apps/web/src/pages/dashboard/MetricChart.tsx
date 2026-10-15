import { calendarAt, formatCalendar, type MetricDefinition } from '@civ/sim-core';
import { useId, useMemo, useState } from 'react';
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
import { labelMarkers, valueAxis } from '../../lib/chart-axis';
import { UNIT_LABELS, formatInteger, formatMetricValue } from '../../lib/format';
import { useElementWidth } from '../../lib/hooks';
import type { SeriesPoint } from '../../lib/metrics';
import { CHART } from './chart-theme';

/*
 * One metric as a single-series area chart (2px line, faint wash), with its written
 * definition and a data-table twin so no value is reachable only by hovering.
 * Season starts are drawn as reference lines on the shared time axis; only lines
 * with room for their label are labelled (above the plot, never over the data), and
 * the tooltip names the season of any hovered tick.
 */

export interface SeasonMarker {
  tick: number;
  label: string;
}

const CHART_HEIGHT = 170;
const Y_AXIS_WIDTH = 64;
const MARGIN = { top: 18, right: 12, bottom: 0, left: 0 };
/** Season label font size (px) and the matching per-character width estimate. */
const MARKER_FONT_PX = 10;
const MARKER_CHAR_PX = 6;
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
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useElementWidth(bodyEl, 10);

  const axis = useMemo(
    () =>
      valueAxis(
        unit,
        points.map((p) => p.value),
      ),
    [unit, points],
  );
  const markers = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    const span: [number, number] | null =
      domain ?? (first && last ? [first.tick, last.tick] : null);
    const plotWidth =
      bodyWidth === null ? 0 : bodyWidth - Y_AXIS_WIDTH - MARGIN.left - MARGIN.right;
    return span
      ? labelMarkers(seasons, span, plotWidth, { charPx: MARKER_CHAR_PX })
      : seasons.map((marker) => ({ marker, labelled: false }));
  }, [seasons, domain, points, bodyWidth]);

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
      <div
        ref={setBodyEl}
        className={`chart-body ${stale ? 'is-stale' : ''}`}
        style={{ height: CHART_HEIGHT }}
      >
        {points.length === 0 ? (
          <EmptyState title="No samples in this range" />
        ) : (
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <AreaChart data={points} margin={MARGIN}>
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
                width={Y_AXIS_WIDTH}
                tickFormatter={axis?.format ?? ((v: number) => formatMetricValue(unit, v, 'axis'))}
                tick={{ fill: CHART.tickText, fontSize: 11 }}
                stroke={CHART.axis}
                tickLine={false}
                axisLine={false}
                domain={axis?.domain ?? ['auto', 'auto']}
                ticks={axis?.ticks}
                interval={0}
              />
              {markers.map(({ marker, labelled }) => (
                <ReferenceLine
                  key={marker.tick}
                  x={marker.tick}
                  stroke={CHART.reference}
                  strokeWidth={1}
                  label={
                    labelled
                      ? {
                          value: marker.label,
                          position: 'top',
                          className: 'chart-season-label',
                          fill: CHART.referenceText,
                          fontSize: MARKER_FONT_PX,
                        }
                      : undefined
                  }
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
