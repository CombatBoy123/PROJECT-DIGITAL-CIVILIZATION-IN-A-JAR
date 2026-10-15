import { METRIC_KEYS, type EntityRef } from '@civ/sim-core';
import { useCallback, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useCivilization, useEventHistory, useEventsPage, useMetrics } from '../../api/queries';
import { useCivilizationStream } from '../../api/useCivilizationStream';
import { EmptyState, ErrorMessage, LoadingRegion, StatusPill } from '../../components/Feedback';
import { EventRow } from '../../components/EventRow';
import { useToast } from '../../components/Toasts';
import { refLabel } from '../../lib/events';
import { formatInteger, humanize } from '../../lib/format';
import { useElementWidth } from '../../lib/hooks';
import {
  CATEGORY_LABELS,
  RANGE_PRESETS,
  groupDefinitions,
  maxPointsFor,
  resolveRange,
  seriesFor,
  type RangePreset,
} from '../../lib/metrics';
import { observatoryHref } from '../../lib/selection';
import type { Selection } from '../../world/types';
import { MetricChart, type SeasonMarker } from './MetricChart';

/*
 * Scientific dashboard: every registered metric charted over a selectable tick range,
 * grouped by category, each with its written definition. Series are downsampled by
 * the server to roughly one point per pixel of chart width. The view refreshes when
 * the stream reports a new durable checkpoint.
 */

const GROUPS = groupDefinitions();

function RangeFilter({
  preset,
  onPreset,
  custom,
  onCustom,
  invalid,
}: {
  preset: RangePreset;
  onPreset: (p: RangePreset) => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
  invalid: boolean;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <div className="dash-filters" role="group" aria-label="Time range">
      <div className="segmented" role="radiogroup" aria-label="Range preset">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={preset === p.id}
            className="segment"
            data-testid={`range-${p.id}`}
            onClick={() => onPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="row gap-s wrap">
          <div className="field field-inline">
            <label htmlFor={fromId} className="field-label">
              From tick
            </label>
            <input
              id={fromId}
              type="number"
              min={0}
              step={1}
              value={custom.from}
              className="input-narrow"
              aria-invalid={invalid ? true : undefined}
              onChange={(e) => onCustom({ ...custom, from: e.target.value })}
            />
          </div>
          <div className="field field-inline">
            <label htmlFor={toId} className="field-label">
              To tick
            </label>
            <input
              id={toId}
              type="number"
              min={0}
              step={1}
              value={custom.to}
              className="input-narrow"
              aria-invalid={invalid ? true : undefined}
              onChange={(e) => onCustom({ ...custom, to: e.target.value })}
            />
          </div>
          {invalid && (
            <span className="field-error" role="alert">
              Enter whole ticks ≥ 0 with “from” not after “to”.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function RangeEvents({
  civilizationId,
  fromTick,
  toTick,
  daysPerSeason,
}: {
  civilizationId: string;
  fromTick: number | undefined;
  toTick: number | undefined;
  daysPerSeason: number | null;
}) {
  const history = useEventHistory(civilizationId, { fromTick, toTick, limit: 50 });
  const events = useMemo(() => history.data?.pages.flatMap((p) => p.items) ?? [], [history.data]);
  const renderRef = (sel: Selection, ref: EntityRef) => (
    <Link to={observatoryHref(civilizationId, sel)} className="ref-link">
      {refLabel(ref)}
    </Link>
  );
  return (
    <section className="panel" aria-labelledby="range-events-title">
      <div className="panel-header">
        <h2 id="range-events-title" className="panel-title">
          Events in range
        </h2>
        <span className="muted small">newest first · entity links open the observatory</span>
      </div>
      <div className="panel-body">
        {history.isPending && <LoadingRegion label="Loading events" />}
        {history.isError && <ErrorMessage error={history.error} />}
        {history.isSuccess && events.length === 0 && <EmptyState title="No events in this range" />}
        {events.length > 0 && (
          <ol className="event-list" data-testid="range-events">
            {events.map((e) => (
              <EventRow key={e.seq} event={e} daysPerSeason={daysPerSeason} renderRef={renderRef} />
            ))}
          </ol>
        )}
        {history.hasNextPage && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Load older events'}
          </button>
        )}
      </div>
    </section>
  );
}

export function DashboardPage({ civilizationId }: { civilizationId: string }) {
  const detail = useCivilization(civilizationId);
  const navigate = useNavigate();
  const toast = useToast();
  const onDeleted = useCallback(() => {
    toast.push({ kind: 'info', title: 'Civilization deleted', message: 'It no longer exists.' });
    void navigate('/');
  }, [navigate, toast]);
  const stream = useCivilizationStream(civilizationId, { onDeleted });
  const [preset, setPreset] = useState<RangePreset>('all');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  const gridWidth = useElementWidth(gridEl);

  const civ = detail.data;
  const durableTick = stream.status?.durableTick ?? civ?.durableTick ?? 0;
  const range = resolveRange(preset, durableTick, custom);
  // Charts sit in a grid of roughly 360px-wide columns; request ~1 point per pixel.
  const columns = gridWidth ? Math.max(1, Math.floor(gridWidth / 360)) : 1;
  const chartWidth = gridWidth ? gridWidth / columns - 80 : null;
  const maxPoints = maxPointsFor(chartWidth);

  const metrics = useMetrics(
    civilizationId,
    { keys: METRIC_KEYS, fromTick: range?.fromTick, toTick: range?.toTick, maxPoints },
    range !== null && civ !== undefined,
  );
  const seasonsQuery = useEventsPage(
    civilizationId,
    { types: ['SeasonStarted'], fromTick: range?.fromTick, toTick: range?.toTick, limit: 500 },
    range !== null && civ !== undefined,
  );

  const seasons = useMemo<SeasonMarker[]>(
    () =>
      (seasonsQuery.data?.items ?? []).map((e) => ({
        tick: e.tick,
        label: `${humanize(String(e.payload.season ?? ''))} Y${String(e.payload.year ?? '')}`,
      })),
    [seasonsQuery.data],
  );

  if (detail.isError) {
    const missing = detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND';
    return (
      <div className="page">
        {missing ? (
          <EmptyState title="Civilization not found">
            <Link to="/">Back to civilizations</Link>
          </EmptyState>
        ) : (
          <ErrorMessage error={detail.error} title="Could not load the civilization" />
        )}
      </div>
    );
  }
  if (!civ) {
    return (
      <div className="page">
        <LoadingRegion label="Loading civilization" lines={6} />
      </div>
    );
  }

  const status = stream.status?.status ?? civ.status;
  // With an invalid custom range the query is disabled but keepPreviousData would still
  // hand back the last range's series; never present those as the answer to this input.
  const data = range !== null ? metrics.data : undefined;
  const domain: [number, number] | undefined =
    range && range.fromTick !== undefined && range.toTick !== undefined
      ? [range.fromTick, range.toTick]
      : undefined;
  const hasSamples = (data?.rows.length ?? 0) > 0;

  return (
    <div className="page dashboard" data-testid="dashboard">
      <header className="dash-header">
        <div className="row gap-s wrap">
          <Link
            to={`/civ/${civilizationId}`}
            className="btn btn-sm btn-ghost"
            data-testid="nav-observatory"
          >
            ‹ Observatory
          </Link>
          <h1 className="obs-title">{civ.name}</h1>
          <StatusPill status={status} haltReason={stream.status?.haltReason ?? civ.haltReason} />
          <span className="muted small num">data durable to tick {formatInteger(durableTick)}</span>
        </div>
        <RangeFilter
          preset={preset}
          onPreset={setPreset}
          custom={custom}
          onCustom={setCustom}
          invalid={preset === 'custom' && range === null}
        />
        {data && (
          <p className="muted small" aria-live="polite">
            {hasSamples
              ? `Ticks ${formatInteger(data.fromTick)}–${formatInteger(data.toTick)} · ${
                  data.bucketTicks > 1
                    ? `downsampled to one point per ${formatInteger(data.bucketTicks)} ticks`
                    : 'raw samples'
                } · ${formatInteger(seasons.length)} season starts marked`
              : 'No metric samples in this range.'}
          </p>
        )}
      </header>
      {range !== null && metrics.isError && (
        <ErrorMessage error={metrics.error} title="Could not load metrics" />
      )}
      {range !== null && seasonsQuery.isError && (
        <ErrorMessage error={seasonsQuery.error} title="Could not load season markers" />
      )}
      <div ref={setGridEl} className="dash-groups">
        {range === null && (
          <EmptyState title="No range selected">
            Charts and events appear once the custom range is valid.
          </EmptyState>
        )}
        {metrics.isPending && range !== null && <LoadingRegion label="Loading metrics" lines={6} />}
        {data &&
          GROUPS.map((g) => (
            <section key={g.category} className="dash-group" aria-labelledby={`cat-${g.category}`}>
              <h2 id={`cat-${g.category}`} className="dash-group-title">
                {CATEGORY_LABELS[g.category]}
              </h2>
              <div className="chart-grid">
                {g.definitions.map((d) => (
                  <MetricChart
                    key={d.key}
                    definition={d}
                    points={seriesFor(data, d.key)}
                    seasons={seasons}
                    domain={domain}
                    daysPerSeason={civ.config.daysPerSeason}
                    bucketTicks={data.bucketTicks}
                    stale={metrics.isFetching && metrics.isPlaceholderData}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>
      {range !== null && (
        <RangeEvents
          civilizationId={civilizationId}
          fromTick={range.fromTick}
          toTick={range.toTick}
          daysPerSeason={civ.config.daysPerSeason}
        />
      )}
    </div>
  );
}
