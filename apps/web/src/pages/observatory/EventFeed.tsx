import type { EventDto } from '@civ/shared';
import type { EventCategory } from '@civ/sim-core';
import { useEffect, useId, useMemo, useState } from 'react';
import { useEventHistory } from '../../api/queries';
import type { LiveEventMessage } from '../../api/useCivilizationStream';
import { EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { EventRow } from '../../components/EventRow';
import {
  EVENT_CATEGORIES,
  capEvents,
  matchesCategory,
  mergeEvents,
  refLabel,
  typesInCategory,
} from '../../lib/events';
import { formatInteger, humanize } from '../../lib/format';
import { useObservatory } from './context';
import { EntityLink } from './EntityLink';

/*
 * Live event feed: events pushed over the stream merged with the persisted history
 * (paginated), deduplicated by seq, newest first, filterable by catalogue category.
 */

/** Live events kept in memory; older ones remain reachable through history pages. */
const MAX_LIVE = 300;
const PAGE_SIZE = 50;

export function EventFeed({
  subscribeLive,
}: {
  subscribeLive: (listener: (message: LiveEventMessage) => void) => () => void;
}) {
  const { civilizationId, config } = useObservatory();
  const [category, setCategory] = useState<EventCategory | null>(null);
  const [live, setLive] = useState<EventDto[]>([]);
  const [dropped, setDropped] = useState(0);
  const filterId = useId();

  useEffect(
    () =>
      subscribeLive((message) => {
        if (message.kind === 'reset') {
          setLive([]);
          setDropped(0);
          return;
        }
        setLive((prev) => capEvents(mergeEvents(message.events, prev), MAX_LIVE));
        if (message.dropped > 0) setDropped((d) => d + message.dropped);
      }),
    [subscribeLive],
  );

  const types = useMemo(() => (category ? typesInCategory(category) : undefined), [category]);
  const history = useEventHistory(civilizationId, { types, limit: PAGE_SIZE });

  const events = useMemo(() => {
    const pages = history.data?.pages.flatMap((p) => p.items) ?? [];
    const merged = mergeEvents(
      live.filter((e) => matchesCategory(e, category)),
      pages,
    );
    // Live events older than the oldest loaded history page would leave a gap; hide them
    // until "load older" reaches them.
    const oldestLoaded = pages.length > 0 ? pages[pages.length - 1]?.seq : undefined;
    return history.hasNextPage && oldestLoaded !== undefined
      ? merged.filter((e) => e.seq >= oldestLoaded)
      : merged;
  }, [history.data, history.hasNextPage, live, category]);

  return (
    <div className="event-feed stack gap-s">
      <div className="row gap-s wrap">
        <div className="field field-inline">
          <label htmlFor={filterId} className="field-label">
            Category
          </label>
          <select
            id={filterId}
            value={category ?? ''}
            data-testid="event-category"
            onChange={(e) => setCategory((e.target.value || null) as EventCategory | null)}
          >
            <option value="">All events</option>
            {EVENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        </div>
        <span className="muted small" aria-live="polite">
          {formatInteger(events.length)} shown
        </span>
        {dropped > 0 && (
          <span className="small text-warn">
            {formatInteger(dropped)} events were not streamed live (rate limit); they appear in the
            history after the next checkpoint.
          </span>
        )}
      </div>
      {history.isPending && <LoadingRegion label="Loading events" lines={4} />}
      {history.isError && <ErrorMessage error={history.error} title="Could not load events" />}
      {history.isSuccess && events.length === 0 && (
        <EmptyState title="No events">
          {category ? 'No events in this category yet.' : 'The event log is empty.'}
        </EmptyState>
      )}
      {events.length > 0 && (
        <ol className="event-list" data-testid="event-feed">
          {events.map((e) => (
            <EventRow
              key={e.seq}
              event={e}
              daysPerSeason={config?.daysPerSeason ?? null}
              renderRef={(sel) => <EntityLink selection={sel}>{refLabel(sel)}</EntityLink>}
            />
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
  );
}
