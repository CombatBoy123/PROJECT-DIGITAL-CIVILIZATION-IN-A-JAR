import type { EventDto } from '@civ/shared';
import { calendarAt, formatCalendar, type EntityRef } from '@civ/sim-core';
import type { ReactNode } from 'react';
import { eventInfo, isSelectableRef, refLabel, summarizeEvent } from '../lib/events';
import { formatInteger } from '../lib/format';
import type { Selection } from '../world/types';

/*
 * One event of the log: time (tick + calendar), catalogue label, payload summary and
 * the entities it involves. Entity references are rendered by the caller (a button
 * that selects the entity in the observatory, or a link from the dashboard).
 */

export function calendarLabel(tick: number, daysPerSeason: number | null): string | null {
  if (daysPerSeason === null || !Number.isInteger(tick) || tick < 0) return null;
  return formatCalendar(calendarAt(tick, { daysPerSeason }));
}

export function EventRow({
  event,
  daysPerSeason,
  renderRef,
  hideRef,
}: {
  event: EventDto;
  daysPerSeason: number | null;
  renderRef: (selection: Selection, ref: EntityRef) => ReactNode;
  /** Omit a reference (e.g. the entity whose timeline this is). */
  hideRef?: Selection | null;
}) {
  const info = eventInfo(event.type);
  const when = calendarLabel(event.tick, daysPerSeason);
  const refs = event.refs.filter(
    (r) => !(hideRef && r.kind === hideRef.kind && r.id === hideRef.id),
  );
  return (
    <li className="event-item" data-testid="event-item" data-type={event.type} data-seq={event.seq}>
      <div className="event-meta">
        <span className={`event-cat cat-${info.category}`}>{info.category}</span>
        <span className="num" title={`Event #${event.seq}`}>
          t{formatInteger(event.tick)}
        </span>
        {when && <span className="muted">{when}</span>}
      </div>
      <div className="event-main">
        <strong className="event-label" title={info.description}>
          {info.label}
        </strong>
        <span className="event-summary">{summarizeEvent(event)}</span>
      </div>
      {refs.length > 0 && (
        <ul className="event-refs" aria-label="Involved entities">
          {refs.map((r) => (
            <li key={`${r.kind}-${r.id}-${r.role}`}>
              {isSelectableRef(r) ? (
                renderRef({ kind: r.kind, id: r.id }, r)
              ) : (
                <span className="ref-static">{refLabel(r)}</span>
              )}
              <span className="ref-role">{r.role}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
