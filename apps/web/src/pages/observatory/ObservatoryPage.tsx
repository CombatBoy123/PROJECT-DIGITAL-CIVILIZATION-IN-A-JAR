import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useCivilization, useLayout } from '../../api/queries';
import { useCivilizationStream } from '../../api/useCivilizationStream';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { useToast } from '../../components/Toasts';
import { parseSelection, withSelection } from '../../lib/selection';
import type { Selection } from '../../world/types';
import { WorldView } from '../../world/WorldView';
import { BottomPanel } from './BottomPanel';
import { ObservatoryContext, type ObservatoryContextValue } from './context';
import { EntityBrowser } from './EntityBrowser';
import { Inspector } from './Inspector';
import { TopBar } from './TopBar';

/*
 * The observatory: live map in the centre, entity lists on the left, the inspector on
 * the right and controls/history at the bottom. Selection is kept in the URL.
 */

export function ObservatoryPage({ civilizationId }: { civilizationId: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const detail = useCivilization(civilizationId);
  const layout = useLayout(civilizationId);
  const [searchParams, setSearchParams] = useSearchParams();
  const selection = useMemo(() => parseSelection(searchParams), [searchParams]);
  const [focus, setFocus] = useState<{ target: Selection | null; nonce: number }>({
    target: null,
    nonce: 0,
  });
  const [highlight, setHighlight] = useState<ReadonlySet<number> | null>(null);
  const names = useRef(new Map<number, string>());

  const onDeleted = useCallback(() => {
    toast.push({ kind: 'info', title: 'Civilization deleted', message: 'It no longer exists.' });
    void navigate('/');
  }, [navigate, toast]);
  const stream = useCivilizationStream(civilizationId, { onDeleted });

  const select = useCallback(
    (next: Selection | null, options: { focus?: boolean } = {}) => {
      setSearchParams((prev) => withSelection(prev, next));
      if (options.focus && next) setFocus((f) => ({ target: next, nonce: f.nonce + 1 }));
    },
    [setSearchParams],
  );

  const onMapSelect = useCallback((next: Selection | null) => select(next), [select]);
  const onNames = useCallback((entries: [number, string][]) => {
    for (const [id, name] of entries) names.current.set(id, name);
  }, []);
  const citizenLabel = useCallback((id: number) => names.current.get(id), []);

  const civ = detail.data;
  const context = useMemo<ObservatoryContextValue>(
    () => ({
      civilizationId,
      civilizationName: civ?.name ?? '',
      config: civ?.config ?? null,
      selection,
      select,
    }),
    [civilizationId, civ?.name, civ?.config, selection, select],
  );

  if (detail.isError) {
    const missing = detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND';
    return (
      <div className="page">
        {missing ? (
          <EmptyState title="Civilization not found">
            It may have been deleted. <Link to="/">Back to civilizations</Link>
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

  // Before the stream says otherwise, fall back to the REST summary.
  const status = stream.status ?? {
    status: civ.status,
    speed: civ.speed,
    tick: civ.tick,
    durableTick: civ.durableTick,
    haltReason: civ.haltReason,
    lastError: civ.lastError,
  };
  const header = stream.header;

  return (
    <ObservatoryContext.Provider value={context}>
      <div className="obs" data-testid="observatory">
        <TopBar
          civilizationId={civilizationId}
          name={civ.name}
          seed={civ.seed}
          status={status}
          tick={header?.tick ?? status.tick}
          calendar={header?.calendar ?? civ.calendar}
          weather={header?.weather ?? null}
          temperatureC={header?.temperatureC ?? null}
          connection={stream.connection}
        />
        <aside className="obs-left panel" aria-label="Citizens and buildings">
          <ErrorBoundary area="Entity lists">
            <EntityBrowser onHighlight={setHighlight} onNames={onNames} />
          </ErrorBoundary>
        </aside>
        <section className="obs-map" aria-label="World map">
          <ErrorBoundary area="World map">
            {layout.data ? (
              <WorldView
                layout={layout.data}
                frames={stream.frames}
                selection={selection}
                onSelect={onMapSelect}
                highlight={highlight}
                citizenLabel={citizenLabel}
                focus={focus.target}
                focusNonce={focus.nonce}
              />
            ) : layout.isError ? (
              <ErrorMessage error={layout.error} title="Could not load the map" />
            ) : (
              <LoadingRegion label="Loading map" lines={1} />
            )}
          </ErrorBoundary>
        </section>
        <aside className="obs-right panel" aria-label="Inspector">
          <ErrorBoundary area="Inspector">
            <Inspector selection={selection} />
          </ErrorBoundary>
        </aside>
        <BottomPanel
          civilizationId={civilizationId}
          status={status.status}
          speed={status.speed}
          subscribeLive={stream.subscribeLive}
        />
      </div>
    </ObservatoryContext.Provider>
  );
}
