import { useMemo } from 'react';
import { useEventHistory } from '../../api/queries';
import { EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { EventRow } from '../../components/EventRow';
import { refLabel } from '../../lib/events';
import type { Selection } from '../../world/types';
import { useObservatory } from './context';
import { EntityLink } from './EntityLink';

/*
 * Event history of one citizen or building (events API filtered by entity), newest
 * first, with keyset "load older" pagination.
 */

const PAGE_SIZE = 25;

export function EntityTimeline({ entity }: { entity: Selection }) {
  const { civilizationId, config } = useObservatory();
  const filter = entity.kind === 'citizen' ? { citizenId: entity.id } : { buildingId: entity.id };
  const history = useEventHistory(civilizationId, { ...filter, limit: PAGE_SIZE });
  const events = useMemo(() => history.data?.pages.flatMap((p) => p.items) ?? [], [history.data]);

  return (
    <section className="inspector-section" aria-labelledby="timeline-title">
      <h3 id="timeline-title" className="section-title">
        Timeline <span className="muted small">newest first</span>
      </h3>
      {history.isPending && <LoadingRegion label="Loading timeline" lines={3} />}
      {history.isError && <ErrorMessage error={history.error} />}
      {history.isSuccess && events.length === 0 && (
        <EmptyState title="No recorded events">Nothing has happened to this entity yet.</EmptyState>
      )}
      {events.length > 0 && (
        <ol className="event-list compact" data-testid="entity-timeline">
          {events.map((e) => (
            <EventRow
              key={e.seq}
              event={e}
              daysPerSeason={config?.daysPerSeason ?? null}
              hideRef={entity}
              renderRef={(sel) => <EntityLink selection={sel}>{refLabel(sel)}</EntityLink>}
            />
          ))}
        </ol>
      )}
      {history.hasNextPage && (
        <button
          type="button"
          className="btn btn-sm btn-ghost full-width"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load older events'}
        </button>
      )}
    </section>
  );
}
