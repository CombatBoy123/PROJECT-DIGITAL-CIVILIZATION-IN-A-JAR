import { useId, useState } from 'react';
import { formatInteger, humanize } from '../../lib/format';
import { ACTIVITY_COLORS, ACTIVITY_LABELS, cssColor } from '../../world/palette';
import type { Selection } from '../../world/types';
import { useDemo } from '../context';
import { citizenAge, fullName, searchCitizens } from '../describe';

/*
 * Searchable list of everyone in the world. Tapping a person selects them and centres
 * the map on them; while a search is active the map dims everyone else.
 */

/** Rows rendered at once; "Show more" adds this many again. */
const PAGE = 120;

export function PeoplePanel({
  query,
  onQuery,
  selection,
}: {
  query: string;
  onQuery: (query: string) => void;
  selection: Selection | null;
}) {
  const { engine, select } = useDemo();
  const [limit, setLimit] = useState(PAGE);
  const inputId = useId();
  const state = engine.state;
  const matches = searchCitizens(state.citizens, query);
  const shown = matches.slice(0, limit);
  const searching = query.trim() !== '';

  return (
    <div className="people">
      <div className="field">
        <label htmlFor={inputId} className="field-label">
          Search by name
        </label>
        <input
          id={inputId}
          type="search"
          value={query}
          placeholder="e.g. Ada"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onQuery(e.target.value);
            setLimit(PAGE);
          }}
          data-testid="people-search"
        />
      </div>
      <p className="muted small" role="status">
        {searching
          ? `${formatInteger(matches.length)} of ${formatInteger(state.citizens.length)} match; others are dimmed on the map.`
          : `${formatInteger(state.citizens.length)} people. Tap one to inspect and find them on the map.`}
      </p>
      {matches.length > 0 && (
        <ul className="people-list" data-testid="people-list">
          {shown.map((c) => {
            const selected = selection?.kind === 'citizen' && selection.id === c.id;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="person"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => select({ kind: 'citizen', id: c.id }, { focus: true })}
                >
                  <span className="person-name">{fullName(c)}</span>
                  <span className="person-meta">
                    {citizenAge(c, state)} y · {humanize(c.lifeStage).toLowerCase()}
                  </span>
                  <span className="person-activity">
                    <span
                      className="swatch"
                      aria-hidden="true"
                      style={{ background: cssColor(ACTIVITY_COLORS[c.activity]) }}
                    />
                    {ACTIVITY_LABELS[c.activity]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > shown.length && (
        <button type="button" className="btn btn-sm" onClick={() => setLimit((n) => n + PAGE)}>
          Show more ({formatInteger(matches.length - shown.length)} left)
        </button>
      )}
    </div>
  );
}
