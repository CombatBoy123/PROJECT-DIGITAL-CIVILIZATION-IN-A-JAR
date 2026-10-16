import { formatCalendar, type SimEvent } from '@civ/sim-core';
import type { EventDto } from '@civ/shared';
import { eventInfo, isSelectableRef, refLabel, summarizeEvent } from '../../lib/events';
import { formatInteger, humanize } from '../../lib/format';
import type { Selection } from '../../world/types';
import { useDemo } from '../context';
import type { DemoEngine } from '../engine';
import { EntityLink } from '../ui';

/*
 * A list of simulation events: catalogue label, readable payload summary, calendar
 * time and the entities involved (citizens and buildings are tappable).
 */

/**
 * Category badges as the demo shows them. The catalogue files the genesis endowments
 * under "economy"; Phase 1 has no economy, so the demo calls that badge "money".
 */
const CATEGORY_BADGE: Record<string, { label: string; className: string }> = {
  economy: { label: 'money', className: 'cat-money' },
};

/** Role of an entity in an event, as a row caption ("Person: Maya Banerjee"). */
const ROLE_LABEL: Record<string, string> = {
  subject: 'Person',
  recipient: 'Recipient',
  household: 'Household',
  home: 'Home',
};

function refName(engine: DemoEngine, selection: Selection, fallback: string): string {
  if (selection.kind === 'citizen') {
    const c = engine.index.citizens.get(selection.id);
    return c ? `${c.firstName} ${c.lastName}` : fallback;
  }
  return engine.index.buildings.get(selection.id)?.name ?? fallback;
}

export function EventList({
  events,
  hide,
  testId,
}: {
  events: readonly SimEvent[];
  /** Omit references to this entity (the one being inspected). */
  hide?: Selection;
  testId?: string;
}) {
  const { engine } = useDemo();
  return (
    <ol className="event-list" data-testid={testId}>
      {events.map((event) => {
        const info = eventInfo(event.type);
        const refs = event.refs.filter((r) => !(hide && r.kind === hide.kind && r.id === hide.id));
        const badge = CATEGORY_BADGE[info.category] ?? {
          label: info.category,
          className: `cat-${info.category}`,
        };
        return (
          <li key={event.seq} className="event-item" data-type={event.type}>
            <div className="event-meta">
              <span className={`event-cat ${badge.className}`}>{badge.label}</span>
              <span>{formatCalendar(engine.calendarAt(event.tick))}</span>
              <span className="num muted">t{formatInteger(event.tick)}</span>
            </div>
            <div className="event-main">
              <strong className="event-label">{info.label}</strong>
              <span className="event-summary">
                {summarizeEvent(event as unknown as Pick<EventDto, 'type' | 'payload'>)}
              </span>
            </div>
            {refs.length > 0 && (
              <ul className="event-refs" aria-label="Involved">
                {refs.map((r) => (
                  <li key={`${r.kind}-${r.id}-${r.role}`}>
                    <span className="event-ref-role">{ROLE_LABEL[r.role] ?? humanize(r.role)}</span>
                    {isSelectableRef(r) ? (
                      <EntityLink selection={{ kind: r.kind, id: r.id }}>
                        {refName(engine, { kind: r.kind, id: r.id }, refLabel(r))}
                      </EntityLink>
                    ) : (
                      <span>{r.kind === 'household' ? `#${r.id}` : refLabel(r)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
