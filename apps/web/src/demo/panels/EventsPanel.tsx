import { useState } from 'react';
import { formatInteger } from '../../lib/format';
import { useDemo } from '../context';
import { EVENT_RING_SIZE } from '../engine';
import { EventList } from './EventList';

/*
 * The newest events of the run (the page keeps the last EVENT_RING_SIZE in memory).
 */

const PAGE = 60;

export function EventsPanel() {
  const { engine } = useDemo();
  const [limit, setLimit] = useState(PAGE);
  const all = engine.events;
  const newestFirst = all.slice(Math.max(0, all.length - limit)).reverse();
  return (
    <div className="events" data-testid="events">
      <p className="muted small">
        Newest first. The page keeps the last {formatInteger(EVENT_RING_SIZE)} events in memory.
        Weather changes, new seasons and life-stage changes appear as the world runs.
      </p>
      <EventList events={newestFirst} testId="event-list" />
      {all.length > newestFirst.length && (
        <button type="button" className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE)}>
          Show older ({formatInteger(all.length - newestFirst.length)} more)
        </button>
      )}
    </div>
  );
}
