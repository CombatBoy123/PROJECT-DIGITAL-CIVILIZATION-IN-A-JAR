import { formatCalendar, PERSONALITY_TRAITS, SKILLS } from '@civ/sim-core';
import { formatCents, formatDecimal, formatInteger, humanize } from '../../lib/format';
import {
  ACTIVITY_COLORS,
  ACTIVITY_LABELS,
  BUILDING_KIND_LABELS,
  cssColor,
} from '../../world/palette';
import type { Selection } from '../../world/types';
import { useDemo } from '../context';
import {
  citizenAge,
  eventsAbout,
  fullName,
  householdMembers,
  presentAt,
  residentsOf,
  whereabouts,
  type ReadonlyBuilding,
  type ReadonlyCitizen,
} from '../describe';
import { EmptyState, EntityLink, Field, Meter, Section } from '../ui';
import { EventList } from './EventList';

/*
 * Inspector of the selected citizen or building, read live from the engine state.
 */

function PeopleLinks({ people, empty }: { people: readonly ReadonlyCitizen[]; empty: string }) {
  const { engine } = useDemo();
  if (people.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="link-list">
      {people.map((p) => (
        <li key={p.id}>
          <EntityLink selection={{ kind: 'citizen', id: p.id }}>{fullName(p)}</EntityLink>
          <span className="muted small">
            {citizenAge(p, engine.state)} y · {ACTIVITY_LABELS[p.activity].toLowerCase()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BuildingLink({ id }: { id: number }) {
  const { engine } = useDemo();
  const b = engine.index.buildings.get(id);
  return (
    <EntityLink selection={{ kind: 'building', id }}>{b ? b.name : `Building #${id}`}</EntityLink>
  );
}

function Whereabouts({ citizen }: { citizen: ReadonlyCitizen }) {
  const { engine } = useDemo();
  const w = whereabouts(citizen);
  if (w.kind === 'in') {
    return (
      <>
        at <BuildingLink id={w.buildingId} />
      </>
    );
  }
  if (w.kind === 'travelling') {
    return (
      <>
        from <BuildingLink id={w.fromId} /> to <BuildingLink id={w.toId} />, arriving{' '}
        <span className="nowrap">{formatCalendar(engine.calendarAt(w.arriveTick))}</span>
      </>
    );
  }
  return <span className="muted">unknown</span>;
}

function CitizenView({ citizen }: { citizen: ReadonlyCitizen }) {
  const { engine } = useDemo();
  const state = engine.state;
  const members = householdMembers(citizen, state);
  const events = eventsAbout(engine.events, 'citizen', citizen.id);
  const energy = citizen.needs.energy;
  return (
    <>
      <header className="inspector-header">
        <span className="inspector-kind">Citizen #{citizen.id}</span>
        <h2 className="inspector-title" data-testid="inspector-title">
          {fullName(citizen)}
        </h2>
      </header>
      <dl className="kv-grid">
        <Field label="Age">{citizenAge(citizen, state)} years</Field>
        <Field label="Life stage">{humanize(citizen.lifeStage)}</Field>
        <Field label="Education">{humanize(citizen.education)}</Field>
        <Field label="Money">
          <span className="num" data-testid="citizen-money">
            {formatCents(citizen.balanceCents)}
          </span>
        </Field>
        <Field label="Doing">
          <span className="activity-tag">
            <span
              className="swatch"
              aria-hidden="true"
              style={{ background: cssColor(ACTIVITY_COLORS[citizen.activity]) }}
            />
            {ACTIVITY_LABELS[citizen.activity]}
          </span>
        </Field>
        <Field label="Home">
          <BuildingLink id={citizen.homeId} />
        </Field>
        <div className="kv kv-wide">
          <dt>Where</dt>
          <dd>
            <Whereabouts citizen={citizen} />
          </dd>
        </div>
      </dl>
      <Section title="Energy" aside="0–100">
        <Meter
          label="Energy"
          value={energy}
          display={formatDecimal(energy, 0)}
          tone={energy < 20 ? 'warn' : 'data'}
        />
        {energy < 20 && <p className="muted small">Below 20: ready to sleep.</p>}
      </Section>
      <Section title="Personality" aside="0–1">
        {PERSONALITY_TRAITS.map((t) => (
          <Meter
            key={t}
            label={humanize(t)}
            value={citizen.personality[t]}
            min={0}
            max={1}
            display={formatDecimal(citizen.personality[t], 2)}
          />
        ))}
      </Section>
      <Section title="Skills" aside="0–100 · not used until jobs arrive">
        {SKILLS.map((s) => (
          <Meter
            key={s}
            label={humanize(s)}
            value={citizen.skills[s]}
            display={formatDecimal(citizen.skills[s], 0)}
          />
        ))}
      </Section>
      <Section title={`Household #${citizen.householdId}`}>
        <PeopleLinks people={members} empty="Lives alone." />
      </Section>
      <Section
        title="Recent events"
        aside={events.length > 0 ? formatInteger(events.length) : undefined}
      >
        {events.length === 0 ? (
          <p className="muted small">
            No recent events about this person. Life-stage changes and genesis records appear here.
          </p>
        ) : (
          <EventList events={events} hide={{ kind: 'citizen', id: citizen.id }} />
        )}
      </Section>
    </>
  );
}

function BuildingView({ building }: { building: ReadonlyBuilding }) {
  const { engine } = useDemo();
  const state = engine.state;
  const residents = building.kind === 'house' ? residentsOf(building.id, state) : [];
  const present = presentAt(building.id, state);
  const household = state.households.find((h) => h.homeId === building.id);
  return (
    <>
      <header className="inspector-header">
        <span className="inspector-kind">
          {BUILDING_KIND_LABELS[building.kind]} #{building.id}
        </span>
        <h2 className="inspector-title" data-testid="inspector-title">
          {building.name}
        </h2>
      </header>
      <dl className="kv-grid">
        <Field label="Kind">{BUILDING_KIND_LABELS[building.kind]}</Field>
        <Field label="Capacity">
          {formatInteger(building.capacity)} {building.kind === 'house' ? 'residents' : 'visitors'}
        </Field>
        {household && <Field label="Household">{household.surname}</Field>}
      </dl>
      {building.kind === 'house' && (
        <Section title="Residents" aside={formatInteger(residents.length)}>
          <PeopleLinks people={residents} empty="Nobody lives here." />
        </Section>
      )}
      <Section title="People here now" aside={formatInteger(present.length)}>
        <PeopleLinks people={present} empty="Nobody is here right now." />
      </Section>
    </>
  );
}

export function InspectPanel({ selection }: { selection: Selection | null }) {
  const { engine, select } = useDemo();
  const citizen =
    selection?.kind === 'citizen' ? engine.index.citizens.get(selection.id) : undefined;
  const building =
    selection?.kind === 'building' ? engine.index.buildings.get(selection.id) : undefined;
  if (!citizen && !building) {
    return (
      <EmptyState title="Tap a person or a building on the map">
        Their details appear here: who they are, what they are doing and where. You can also pick
        someone from the People tab.
      </EmptyState>
    );
  }
  return (
    <div className="inspector" data-testid="inspector">
      <div className="inspector-toolbar">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => select(null)}>
          Clear selection
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => selection && select(selection, { focus: true })}
        >
          Show on map
        </button>
      </div>
      {citizen ? (
        <CitizenView citizen={citizen} />
      ) : (
        building && <BuildingView building={building} />
      )}
    </div>
  );
}
