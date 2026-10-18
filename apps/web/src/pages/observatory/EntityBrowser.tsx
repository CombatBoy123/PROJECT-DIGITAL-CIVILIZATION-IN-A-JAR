import type { CitizenListQuery } from '@civ/shared';
import {
  ACTIVITIES,
  BUILDING_KINDS,
  EDUCATION_LEVELS,
  LIFE_STAGES,
  type BuildingKind,
} from '@civ/sim-core';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useBuildings, useCitizens } from '../../api/queries';
import { EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { Tabs, tabPanelProps } from '../../components/Tabs';
import { formatCents, formatInteger, humanize } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { useObservatory } from './context';

/*
 * Left sidebar: server-paginated, filterable lists of citizens and buildings. Rows
 * select the entity and focus the map. The citizens currently matched by an active
 * filter are reported upwards so the map can emphasise them.
 */

const CITIZEN_PAGE = 50;
const BUILDING_PAGE = 100;

type Sort = NonNullable<CitizenListQuery['sort']>;
const SORTS: { id: Sort; label: string }[] = [
  { id: 'id', label: 'ID' },
  { id: 'name', label: 'Name' },
  { id: 'age', label: 'Age' },
  { id: 'balance', label: 'Balance' },
  { id: 'energy', label: 'Energy' },
];

export function pageRange(offset: number, count: number, total: number): string {
  if (total === 0 || count === 0) return `0 of ${formatInteger(total)}`;
  return `${formatInteger(offset + 1)}–${formatInteger(offset + count)} of ${formatInteger(total)}`;
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  allLabel,
  testId,
}: {
  label: string;
  value: T | '';
  options: readonly T[];
  onChange: (v: T | '') => void;
  allLabel: string;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="field field-compact">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select
        id={id}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value as T | '')}
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {humanize(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Pager({
  offset,
  limit,
  count,
  total,
  asOfTick,
  busy,
  onOffset,
  noun,
}: {
  offset: number;
  limit: number;
  count: number;
  total: number;
  asOfTick: number;
  busy: boolean;
  onOffset: (offset: number) => void;
  noun: string;
}) {
  return (
    <div className="pager">
      <div className="pager-info">
        <span className="num" data-testid={`${noun}-count`} data-total={total} aria-live="polite">
          {pageRange(offset, count, total)}
        </span>
        <span className="as-of" data-testid={`${noun}-as-of`}>
          as of tick {formatInteger(asOfTick)}
        </span>
      </div>
      <div className="row gap-xs">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={offset === 0 || busy}
          aria-label={`Previous ${noun} page`}
          onClick={() => onOffset(Math.max(0, offset - limit))}
        >
          ‹ Prev
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={offset + count >= total || busy}
          aria-label={`Next ${noun} page`}
          onClick={() => onOffset(offset + limit)}
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

function SearchBox({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <input
        id={id}
        type="search"
        placeholder={label}
        maxLength={80}
        value={value}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ListShell({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul className="entity-list" aria-label={label}>
      {children}
    </ul>
  );
}

function CitizenList({
  onHighlight,
  onNames,
}: {
  onHighlight: (ids: ReadonlySet<number> | null) => void;
  onNames: (names: [number, string][]) => void;
}) {
  const { civilizationId, selection, select } = useObservatory();
  const [search, setSearch] = useState('');
  const [lifeStage, setLifeStage] = useState<(typeof LIFE_STAGES)[number] | ''>('');
  const [activity, setActivity] = useState<(typeof ACTIVITIES)[number] | ''>('');
  const [education, setEducation] = useState<(typeof EDUCATION_LEVELS)[number] | ''>('');
  const [sort, setSort] = useState<Sort>('id');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebounced(search.trim(), 250);
  const sortId = useId();
  /** Any filter change returns to the first page. */
  const resetting =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };

  const query = useMemo<CitizenListQuery>(
    () => ({
      search: debouncedSearch || undefined,
      lifeStage: lifeStage || undefined,
      activity: activity || undefined,
      education: education || undefined,
      sort,
      order,
      limit: CITIZEN_PAGE,
      offset,
    }),
    [debouncedSearch, lifeStage, activity, education, sort, order, offset],
  );
  const filtered = Boolean(query.search || query.lifeStage || query.activity || query.education);

  const list = useCitizens(civilizationId, query);
  const items = list.data?.items;

  useEffect(() => {
    if (items) onNames(items.map((c) => [c.id, `${c.firstName} ${c.lastName}`]));
  }, [items, onNames]);

  useEffect(() => {
    onHighlight(filtered && items ? new Set(items.map((c) => c.id)) : null);
  }, [filtered, items, onHighlight]);
  useEffect(() => () => onHighlight(null), [onHighlight]);

  return (
    <div className="stack gap-s">
      <SearchBox
        label="Search citizens by name"
        value={search}
        onChange={resetting(setSearch)}
        testId="citizen-search"
      />
      <div className="filter-grid">
        <SelectField
          label="Life stage"
          value={lifeStage}
          options={LIFE_STAGES}
          onChange={resetting(setLifeStage)}
          allLabel="All"
          testId="filter-life-stage"
        />
        <SelectField
          label="Activity"
          value={activity}
          options={ACTIVITIES}
          onChange={resetting(setActivity)}
          allLabel="All"
          testId="filter-activity"
        />
        <SelectField
          label="Education"
          value={education}
          options={EDUCATION_LEVELS}
          onChange={resetting(setEducation)}
          allLabel="All"
          testId="filter-education"
        />
        <div className="field field-compact">
          <label htmlFor={sortId} className="field-label">
            Sort
          </label>
          <div className="row gap-xs">
            <select
              id={sortId}
              value={sort}
              data-testid="citizen-sort"
              onChange={(e) => resetting(setSort)(e.target.value as Sort)}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label={
                order === 'asc'
                  ? 'Sorted ascending; switch to descending'
                  : 'Sorted descending; switch to ascending'
              }
              onClick={() => resetting(setOrder)(order === 'asc' ? 'desc' : 'asc')}
            >
              {order === 'asc' ? '↑' : '↓'}
            </button>
          </div>
        </div>
      </div>
      {filtered && items && items.length > 0 && (
        <p className="muted small">Matching citizens on this page are highlighted on the map.</p>
      )}
      {list.isPending && <LoadingRegion label="Loading citizens" lines={8} />}
      {list.isError && <ErrorMessage error={list.error} />}
      {list.data && (
        <>
          <Pager
            noun="citizen"
            offset={list.data.offset}
            limit={CITIZEN_PAGE}
            count={list.data.items.length}
            total={list.data.total}
            asOfTick={list.data.asOfTick}
            busy={list.isFetching}
            onOffset={setOffset}
          />
          {list.data.items.length === 0 ? (
            <EmptyState title="No citizens match" />
          ) : (
            <ListShell label="Citizens">
              {list.data.items.map((c) => {
                const selected = selection?.kind === 'citizen' && selection.id === c.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="entity-row"
                      aria-current={selected ? 'true' : undefined}
                      data-testid="citizen-row"
                      data-id={c.id}
                      onClick={() => select({ kind: 'citizen', id: c.id }, { focus: true })}
                    >
                      <span className="entity-name">
                        {c.firstName} {c.lastName}
                      </span>
                      <span className="entity-sub">
                        {c.ageYears} y · {humanize(c.activity)}
                      </span>
                      <span className="entity-value num">{formatCents(c.balanceCents)}</span>
                    </button>
                  </li>
                );
              })}
            </ListShell>
          )}
        </>
      )}
    </div>
  );
}

function BuildingList() {
  const { civilizationId, selection, select } = useObservatory();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<BuildingKind | ''>('');
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebounced(search.trim(), 250);

  const list = useBuildings(civilizationId, {
    search: debouncedSearch || undefined,
    kind: kind || undefined,
    limit: BUILDING_PAGE,
    offset,
  });

  return (
    <div className="stack gap-s">
      <SearchBox
        label="Search buildings by name"
        value={search}
        onChange={(v) => {
          setSearch(v);
          setOffset(0);
        }}
        testId="building-search"
      />
      <div className="filter-grid">
        <SelectField
          label="Kind"
          value={kind}
          options={BUILDING_KINDS}
          onChange={(v) => {
            setKind(v);
            setOffset(0);
          }}
          allLabel="All kinds"
          testId="filter-kind"
        />
      </div>
      {list.isPending && <LoadingRegion label="Loading buildings" lines={8} />}
      {list.isError && <ErrorMessage error={list.error} />}
      {list.data && (
        <>
          <Pager
            noun="building"
            offset={list.data.offset}
            limit={BUILDING_PAGE}
            count={list.data.items.length}
            total={list.data.total}
            asOfTick={list.data.asOfTick}
            busy={list.isFetching}
            onOffset={setOffset}
          />
          {list.data.items.length === 0 ? (
            <EmptyState title="No buildings match" />
          ) : (
            <ListShell label="Buildings">
              {list.data.items.map((b) => {
                const selected = selection?.kind === 'building' && selection.id === b.id;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="entity-row"
                      aria-current={selected ? 'true' : undefined}
                      data-testid="building-row"
                      data-id={b.id}
                      onClick={() => select({ kind: 'building', id: b.id }, { focus: true })}
                    >
                      <span className="entity-name">{b.name}</span>
                      <span className="entity-sub">{humanize(b.kind)}</span>
                      <span className="entity-value num">cap {formatInteger(b.capacity)}</span>
                    </button>
                  </li>
                );
              })}
            </ListShell>
          )}
        </>
      )}
    </div>
  );
}

type BrowserTab = 'citizens' | 'buildings';
const TABS = [
  { id: 'citizens', label: 'Citizens' },
  { id: 'buildings', label: 'Buildings' },
] as const;

export function EntityBrowser({
  onHighlight,
  onNames,
}: {
  onHighlight: (ids: ReadonlySet<number> | null) => void;
  onNames: (names: [number, string][]) => void;
}) {
  const [tab, setTab] = useState<BrowserTab>('citizens');
  return (
    <div className="entity-browser">
      <Tabs tabs={TABS} active={tab} onChange={setTab} prefix="browser" label="Entity lists" />
      <div {...tabPanelProps('browser', tab)} className="tab-panel">
        {tab === 'citizens' ? (
          <CitizenList onHighlight={onHighlight} onNames={onNames} />
        ) : (
          <BuildingList />
        )}
      </div>
    </div>
  );
}
