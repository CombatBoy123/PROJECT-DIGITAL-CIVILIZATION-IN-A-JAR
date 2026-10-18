import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tabPanelProps, Tabs, type TabDef } from '../components/Tabs';
import { sameSelection, type Selection } from '../world/types';
import { WorldView } from '../world/WorldView';
import { DemoContext, type DemoContextValue } from './context';
import { searchCitizens } from './describe';
import { DemoEngine } from './engine';
import { Header, type RunStatus } from './Header';
import { EventsPanel } from './panels/EventsPanel';
import { InspectPanel } from './panels/InspectPanel';
import { PeoplePanel } from './panels/PeoplePanel';
import { SocietyPanel } from './panels/SocietyPanel';
import { WorldPanel } from './panels/WorldPanel';
import { PlaybackBar } from './PlaybackBar';
import { DEFAULT_SPEED, RunLoop, type Speed } from './run-loop';
import { useEngineVersion } from './use-engine';

/*
 * The browser demo: the real engine (DemoEngine) driven by a requestAnimationFrame
 * loop, the real PixiJS map, and tabbed panels. Phones get a stacked layout (map on
 * top, panels below); wider screens put the panels beside the map.
 */

type TabId = 'inspect' | 'people' | 'society' | 'events' | 'world';

const TABS: readonly TabDef<TabId>[] = [
  { id: 'inspect', label: 'Inspect' },
  { id: 'people', label: 'People' },
  { id: 'society', label: 'Society' },
  { id: 'events', label: 'Events' },
  { id: 'world', label: 'World' },
];

const TAB_PREFIX = 'demo';

export function DemoApp() {
  const [engine] = useState(() => new DemoEngine());
  const [loop] = useState(() => new RunLoop(engine));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(DEFAULT_SPEED);
  const [tab, setTab] = useState<TabId>('inspect');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<{ target: Selection | null; nonce: number }>({
    target: null,
    nonce: 0,
  });
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  useEngineVersion(engine);

  const halted = engine.halted;

  // Drive the loop from React state; stop it on unmount.
  useEffect(() => {
    loop.setPlaying(playing);
  }, [loop, playing]);
  useEffect(() => {
    loop.setSpeed(speed);
  }, [loop, speed]);
  useEffect(() => () => loop.destroy(), [loop]);
  useEffect(() => {
    if (halted) setPlaying(false);
  }, [halted]);

  // Pause stepping while the page is hidden (another tab, phone locked).
  useEffect(() => {
    const onVisibility = () => loop.setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [loop]);

  const select = useCallback((next: Selection | null, options?: { focus?: boolean }) => {
    setSelection((prev) => (sameSelection(prev, next) ? prev : next));
    if (next) {
      setTab('inspect');
      if (options?.focus) setFocus((f) => ({ target: next, nonce: f.nonce + 1 }));
    }
  }, []);

  // All tabs share one scrolling panel: open each tab (and each newly inspected
  // citizen or building) at the top, before paint, instead of at the previous
  // tab's scroll offset, so Events starts at the newest event and World at its top.
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [tab, selection]);

  const context = useMemo<DemoContextValue>(() => ({ engine, select }), [engine, select]);

  /** After a new world, restore or reset: stop, and drop a selection that may not exist. */
  const onWorldReplaced = useCallback(() => {
    setPlaying(false);
    setSelection((s) => {
      if (!s) return s;
      const exists =
        s.kind === 'citizen' ? engine.index.citizens.has(s.id) : engine.index.buildings.has(s.id);
      return exists ? s : null;
    });
  }, [engine]);

  const citizenLabel = useCallback(
    (id: number) => {
      const c = engine.index.citizens.get(id);
      return c ? `${c.firstName} ${c.lastName}` : undefined;
    },
    [engine],
  );

  const layout = engine.layout;
  const highlightKey = tab === 'people' ? query.trim().toLowerCase() : '';
  const highlight = useMemo(() => {
    if (highlightKey === '') return null;
    return new Set(searchCitizens(engine.state.citizens, highlightKey).map((c) => c.id));
    // The citizen set only changes with the layout (a new world, restore or reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, highlightKey, layout]);

  const status: RunStatus = halted ? 'halted' : playing ? 'running' : 'paused';

  return (
    <DemoContext.Provider value={context}>
      <div className="demo">
        <Header engine={engine} status={status} />
        {halted && (
          <div className="alert alert-error demo-halt" role="alert" data-testid="halt">
            <strong>The simulation stopped.</strong>
            <span>{halted}</span>
            <span>Reset to genesis or restore a save point in the World tab.</span>
          </div>
        )}
        <main className="demo-main">
          <div className="demo-map">
            <WorldView
              layout={layout}
              frames={engine.frames}
              selection={selection}
              onSelect={select}
              highlight={highlight}
              citizenLabel={citizenLabel}
              focus={focus.target}
              focusNonce={focus.nonce}
            />
          </div>
          <PlaybackBar
            playing={playing}
            halted={halted !== null}
            speed={speed}
            onTogglePlay={() => setPlaying((p) => !p)}
            onStep={(n) => engine.step(n)}
            onSpeed={setSpeed}
          />
          <section className="demo-side" aria-label="Details">
            <Tabs tabs={TABS} active={tab} onChange={setTab} prefix={TAB_PREFIX} label="Panels" />
            <div className="demo-panel" ref={panelRef} {...tabPanelProps(TAB_PREFIX, tab)}>
              {tab === 'inspect' && <InspectPanel selection={selection} />}
              {tab === 'people' && (
                <PeoplePanel query={query} onQuery={setQuery} selection={selection} />
              )}
              {tab === 'society' && <SocietyPanel />}
              {tab === 'events' && <EventsPanel />}
              {tab === 'world' && <WorldPanel onWorldReplaced={onWorldReplaced} />}
            </div>
          </section>
        </main>
      </div>
    </DemoContext.Provider>
  );
}
