import { useEffect, useState } from 'react';
import { throttle } from '../lib/throttle';
import type { DemoEngine } from './engine';

/** Interval of panel refreshes while the simulation runs (ms). */
export const PANEL_REFRESH_MS = 200;

/**
 * Re-render when the engine changes, at most every `intervalMs` (leading and
 * trailing), so panels stay live without re-rendering on every tick. Returns the
 * engine version seen by this render.
 */
export function useEngineVersion(engine: DemoEngine, intervalMs = PANEL_REFRESH_MS): number {
  const [version, setVersion] = useState(engine.version);
  useEffect(() => {
    const update = throttle(() => setVersion(engine.version), intervalMs);
    const unsubscribe = engine.subscribe(update);
    // Catch up with changes made between render and subscription.
    setVersion(engine.version);
    return () => {
      unsubscribe();
      update.cancel();
    };
  }, [engine, intervalMs]);
  return version;
}
