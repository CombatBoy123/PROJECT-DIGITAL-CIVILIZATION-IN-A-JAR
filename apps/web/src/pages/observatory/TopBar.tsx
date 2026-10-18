import type { StreamStatus } from '@civ/shared';
import { formatCalendar, type Calendar, type Weather } from '@civ/sim-core';
import { Link } from 'react-router-dom';
import type { ConnectionState } from '../../api/stream';
import { StatusPill } from '../../components/Feedback';
import { formatInteger, formatTemperature, humanize } from '../../lib/format';

/*
 * Observatory header: identity, run status (including HALTED with its reason), the
 * simulated calendar and weather, the live tick versus the last durable checkpoint,
 * persistence errors and stream connectivity.
 */

const CONNECTION_LABEL: Record<ConnectionState, string | null> = {
  open: null,
  connecting: 'Connecting to live stream…',
  reconnecting: 'Live stream lost — reconnecting…',
  closed: 'Live stream closed',
};

export function TopBar({
  civilizationId,
  name,
  seed,
  status,
  tick,
  calendar,
  weather,
  temperatureC,
  connection,
}: {
  civilizationId: string;
  name: string;
  seed: string | null;
  status: StreamStatus | null;
  tick: number | null;
  calendar: Calendar | null;
  weather: Weather | null;
  temperatureC: number | null;
  connection: ConnectionState;
}) {
  const connectionNote = CONNECTION_LABEL[connection];
  return (
    <header className="obs-topbar">
      <div className="obs-identity">
        <Link to="/" className="btn btn-sm btn-ghost" aria-label="Back to all civilizations">
          ‹ Civilizations
        </Link>
        <h1 className="obs-title" data-testid="civ-name">
          {name}
        </h1>
        {seed && (
          <span className="muted small mono" title="World seed" data-testid="civ-seed">
            seed {seed}
          </span>
        )}
        {status && <StatusPill status={status.status} haltReason={status.haltReason} />}
      </div>
      <dl className="obs-clock">
        <div>
          <dt>Calendar</dt>
          <dd data-testid="calendar">{calendar ? formatCalendar(calendar) : '—'}</dd>
        </div>
        <div>
          <dt>Weather</dt>
          <dd data-testid="weather">
            {weather ? humanize(weather) : '—'}
            {temperatureC !== null && (
              <span className="muted"> · {formatTemperature(temperatureC)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Tick</dt>
          <dd className="num" data-testid="live-tick" data-tick={tick ?? ''}>
            {tick === null ? '—' : formatInteger(tick)}
          </dd>
        </div>
        <div>
          <dt>Durable</dt>
          <dd
            className="num"
            data-testid="durable-tick"
            title="Tick of the latest checkpoint committed to the database"
          >
            {status ? `at tick ${formatInteger(status.durableTick)}` : '—'}
          </dd>
        </div>
      </dl>
      <nav className="obs-nav" aria-label="Civilization views">
        <Link
          to={`/civ/${civilizationId}/dashboard`}
          className="btn btn-sm"
          data-testid="nav-dashboard"
        >
          Dashboard
        </Link>
      </nav>
      {(status?.status === 'halted' || status?.lastError || connectionNote) && (
        <div className="obs-notices">
          {status?.status === 'halted' && (
            <div className="alert alert-error" role="alert" data-testid="halt-reason">
              <strong>Halted.</strong> {status.haltReason ?? 'An invariant was violated.'} Restore a
              snapshot or reset the world to continue.
            </div>
          )}
          {status?.lastError && (
            <div className="alert alert-warn" role="status" data-testid="persistence-error">
              <strong>Last checkpoint failed:</strong> {status.lastError}
            </div>
          )}
          {connectionNote && (
            <div className="alert alert-info" role="status" data-testid="connection-state">
              {connectionNote}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
