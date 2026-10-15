import type { BuildingDetail, CitizenDetail } from '@civ/shared';
import { PERSONALITY_TRAITS, SKILLS } from '@civ/sim-core';
import type { ReactNode } from 'react';
import { useBuilding, useCitizen } from '../../api/queries';
import { EmptyState, ErrorMessage, LoadingRegion, Meter } from '../../components/Feedback';
import { formatCents, formatDecimal, formatInteger, humanize } from '../../lib/format';
import type { Selection } from '../../world/types';
import { useObservatory } from './context';
import { EntityLink } from './EntityLink';
import { EntityTimeline } from './EntityTimeline';

/*
 * Right-hand inspector for the selected entity. Data comes from the projection tables
 * (labelled with the tick they represent) and refreshes on checkpoints.
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AsOf({ tick }: { tick: number }) {
  return (
    <span className="as-of" data-testid="inspector-as-of">
      as of tick {formatInteger(tick)}
    </span>
  );
}

function CitizenView({ citizen }: { citizen: CitizenDetail }) {
  const travelling = citizen.locationBuildingId === null;
  return (
    <>
      <header className="inspector-header">
        <span className="inspector-kind">Citizen #{citizen.id}</span>
        <h2 className="inspector-title" data-testid="inspector-title">
          {citizen.firstName} {citizen.lastName}
        </h2>
        <AsOf tick={citizen.asOfTick} />
      </header>
      <section className="inspector-section" aria-label="Identity">
        <dl className="kv-grid">
          <Field label="Age">{citizen.ageYears} years</Field>
          <Field label="Life stage">{humanize(citizen.lifeStage)}</Field>
          <Field label="Education">{humanize(citizen.education)}</Field>
          <Field label="Born at tick">{formatInteger(citizen.birthTick)}</Field>
          <Field label="Balance">
            <span className="num" data-testid="citizen-balance">
              {formatCents(citizen.balanceCents)}
            </span>
          </Field>
          <Field label="Activity">
            <span data-testid="citizen-activity">{humanize(citizen.activity)}</span>
          </Field>
          <Field label={travelling ? 'Heading to' : 'Location'}>
            {citizen.location ? (
              <EntityLink selection={{ kind: 'building', id: citizen.location.id }}>
                {citizen.location.name}
              </EntityLink>
            ) : citizen.destinationBuildingId !== null ? (
              <EntityLink selection={{ kind: 'building', id: citizen.destinationBuildingId }}>
                building #{citizen.destinationBuildingId}
              </EntityLink>
            ) : (
              <span className="muted">on the road</span>
            )}
          </Field>
          <Field label="Home">
            <EntityLink selection={{ kind: 'building', id: citizen.home.id }} testId="home-link">
              {citizen.home.name}
            </EntityLink>
          </Field>
        </dl>
      </section>
      <section className="inspector-section" aria-labelledby="needs-title">
        <h3 id="needs-title" className="section-title">
          Needs
        </h3>
        <Meter
          label="Energy"
          value={citizen.energy}
          display={formatDecimal(citizen.energy, 1)}
          tone={citizen.energy < 20 ? 'warn' : 'data'}
        />
      </section>
      <section className="inspector-section" aria-labelledby="traits-title">
        <h3 id="traits-title" className="section-title">
          Personality <span className="muted small">0–1</span>
        </h3>
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
      </section>
      <section className="inspector-section" aria-labelledby="skills-title">
        <h3 id="skills-title" className="section-title">
          Skills <span className="muted small">0–100</span>
        </h3>
        {SKILLS.map((s) => (
          <Meter
            key={s}
            label={humanize(s)}
            value={citizen.skills[s]}
            display={formatDecimal(citizen.skills[s], 0)}
          />
        ))}
      </section>
      <section className="inspector-section" aria-labelledby="household-title">
        <h3 id="household-title" className="section-title">
          Household #{citizen.householdId}
        </h3>
        {citizen.householdMembers.length === 0 ? (
          <p className="muted small">Lives alone.</p>
        ) : (
          <ul className="link-list" data-testid="household-members">
            {citizen.householdMembers.map((m) => (
              <li key={m.id}>
                <EntityLink selection={{ kind: 'citizen', id: m.id }}>
                  {m.firstName} {m.lastName}
                </EntityLink>
                <span className="muted small">{m.ageYears} y</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <EntityTimeline entity={{ kind: 'citizen', id: citizen.id }} />
    </>
  );
}

function PeopleList({
  title,
  people,
  empty,
  testId,
}: {
  title: string;
  people: BuildingDetail['residents'];
  empty: string;
  testId: string;
}) {
  return (
    <section className="inspector-section" aria-label={title}>
      <h3 className="section-title">
        {title} <span className="muted small">{formatInteger(people.length)}</span>
      </h3>
      {people.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="link-list" data-testid={testId}>
          {people.map((p) => (
            <li key={p.id}>
              <EntityLink selection={{ kind: 'citizen', id: p.id }}>
                {p.firstName} {p.lastName}
              </EntityLink>
              <span className="muted small">{humanize(p.activity)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BuildingView({ building }: { building: BuildingDetail }) {
  return (
    <>
      <header className="inspector-header">
        <span className="inspector-kind">
          {humanize(building.kind)} #{building.id}
        </span>
        <h2 className="inspector-title" data-testid="inspector-title">
          {building.name}
        </h2>
        <AsOf tick={building.asOfTick} />
      </header>
      <section className="inspector-section" aria-label="Building facts">
        <dl className="kv-grid">
          <Field label="Kind">
            <span data-testid="building-kind">{humanize(building.kind)}</span>
          </Field>
          <Field label="Capacity">
            {formatInteger(building.capacity)}{' '}
            {building.kind === 'house' ? 'residents' : 'visitors'}
          </Field>
          <Field label="Position">
            <span className="num">
              ({building.x}, {building.y})
            </span>
          </Field>
          <Field label="Footprint">
            <span className="num">
              {building.width} × {building.height} tiles
            </span>
          </Field>
        </dl>
      </section>
      {building.kind === 'house' && (
        <PeopleList
          title="Residents"
          people={building.residents}
          empty="Nobody lives here."
          testId="building-residents"
        />
      )}
      <PeopleList
        title="Present now"
        people={building.occupants}
        empty="Nobody is here right now."
        testId="building-occupants"
      />
      <EntityTimeline entity={{ kind: 'building', id: building.id }} />
    </>
  );
}

function CitizenInspector({ id }: { id: number }) {
  const { civilizationId } = useObservatory();
  const q = useCitizen(civilizationId, id);
  if (q.isPending) return <LoadingRegion label="Loading citizen" lines={8} />;
  if (q.isError) return <ErrorMessage error={q.error} title={`Citizen #${id}`} />;
  return <CitizenView citizen={q.data} />;
}

function BuildingInspector({ id }: { id: number }) {
  const { civilizationId } = useObservatory();
  const q = useBuilding(civilizationId, id);
  if (q.isPending) return <LoadingRegion label="Loading building" lines={6} />;
  if (q.isError) return <ErrorMessage error={q.error} title={`Building #${id}`} />;
  return <BuildingView building={q.data} />;
}

export function Inspector({ selection }: { selection: Selection | null }) {
  const { select } = useObservatory();
  return (
    <div
      className="inspector"
      data-testid="inspector"
      data-selection={selection ? `${selection.kind}:${selection.id}` : ''}
    >
      {selection === null ? (
        <EmptyState title="Nothing selected">
          Click a citizen or building on the map, or pick one from the list, to inspect it.
        </EmptyState>
      ) : (
        <>
          <div className="inspector-toolbar">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => select(null)}>
              Clear selection
            </button>
          </div>
          {selection.kind === 'citizen' ? (
            <CitizenInspector key={`c${selection.id}`} id={selection.id} />
          ) : (
            <BuildingInspector key={`b${selection.id}`} id={selection.id} />
          )}
        </>
      )}
    </div>
  );
}
