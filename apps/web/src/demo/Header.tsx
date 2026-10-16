import { formatCalendar } from '@civ/sim-core';
import { formatInteger, formatTemperature, humanize } from '../lib/format';
import { useFrameVersion } from '../world/use-frame-version';
import type { DemoEngine } from './engine';

/*
 * Compact header: name, live calendar, weather and temperature, tick and run status.
 * Reads the FrameStore (updated every tick, coalesced to one render per frame).
 */

export type RunStatus = 'running' | 'paused' | 'halted';

const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  halted: 'Halted',
};

export function Header({ engine, status }: { engine: DemoEngine; status: RunStatus }) {
  useFrameVersion(engine.frames);
  const frame = engine.frames.state;
  return (
    <header className="demo-header">
      <div className="demo-title-row">
        <h1 className="demo-title">
          <svg viewBox="0 0 32 32" aria-hidden="true" className="demo-logo">
            <rect x="7" y="4" width="18" height="24" rx="5" />
            <circle cx="16" cy="19" r="4" />
          </svg>
          <span className="demo-title-text">Digital Civilization in a Jar</span>
        </h1>
        <span className={`pill pill-${status}`} data-testid="run-status">
          <span className="pill-dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
      </div>
      {frame && (
        <p className="demo-clock" aria-label="Simulation time and weather">
          <span className="demo-clock-main" data-testid="calendar">
            {formatCalendar(frame.calendar)}
          </span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span>
            {humanize(frame.weather)}, {formatTemperature(frame.temperatureC)}
          </span>
          <span className="sep" aria-hidden="true">
            ·
          </span>
          <span className="num" data-testid="tick">
            tick {formatInteger(frame.tick)}
          </span>
        </p>
      )}
    </header>
  );
}
