import { SPEED_PRESETS, type CivilizationStatus } from '@civ/shared';
import { TICKS_PER_DAY } from '@civ/sim-core';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useControl, useSetSpeed } from '../../api/queries';
import { useToast } from '../../components/Toasts';
import { shortcutFor } from '../../lib/keyboard';

/*
 * Run controls: play/pause, single step, step one day, speed presets. Space and "."
 * are global shortcuts (ignored while typing). The server is authoritative: the
 * displayed status comes from the stream, not from the button that was pressed.
 */

export function speedLabel(ticksPerSecond: number): string {
  return ticksPerSecond === 0 ? 'max' : `${ticksPerSecond} t/s`;
}

export function PlaybackControls({
  civilizationId,
  status,
  speed,
}: {
  civilizationId: string;
  status: CivilizationStatus | null;
  speed: number | null;
}) {
  const control = useControl(civilizationId);
  const setSpeed = useSetSpeed(civilizationId);
  const toast = useToast();
  const speedId = useId();
  const running = status === 'running';
  const halted = status === 'halted';
  const busy = control.isPending;
  const disabled = status === null || halted || busy;

  const togglePlay = useCallback(() => {
    if (status === null || status === 'halted' || control.isPending) return;
    control.mutate(
      { action: status === 'running' ? 'pause' : 'start' },
      { onError: (e) => toast.error(status === 'running' ? 'Pause failed' : 'Start failed', e) },
    );
  }, [control, status, toast]);

  const step = useCallback(
    (steps: number) => {
      if (status !== 'paused' || control.isPending) return;
      control.mutate({ action: 'step', steps }, { onError: (e) => toast.error('Step failed', e) });
    },
    [control, status, toast],
  );

  // Keep the latest handlers for the window listener without re-subscribing.
  const handlers = useRef({ togglePlay, step });
  useEffect(() => {
    handlers.current = { togglePlay, step };
  }, [togglePlay, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'togglePlay') handlers.current.togglePlay();
      else handlers.current.step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const presets: number[] = [...SPEED_PRESETS];
  if (speed !== null && !presets.includes(speed)) presets.unshift(speed);

  return (
    <div className="playback" role="group" aria-label="Simulation controls">
      <button
        type="button"
        className={`btn ${running ? '' : 'btn-primary'} playback-main`}
        disabled={disabled}
        aria-keyshortcuts="Space"
        data-testid="play-pause"
        onClick={togglePlay}
      >
        {running ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled || running}
        aria-keyshortcuts="."
        data-testid="step-1"
        title={running ? 'Pause to step' : 'Advance one tick (one hour)'}
        onClick={() => step(1)}
      >
        Step 1 tick
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled || running}
        data-testid="step-24"
        title={running ? 'Pause to step' : 'Advance one day (24 ticks)'}
        onClick={() => step(TICKS_PER_DAY)}
      >
        Step 1 day
      </button>
      <div className="field field-inline">
        <label htmlFor={speedId} className="field-label">
          Speed
        </label>
        <select
          id={speedId}
          value={speed ?? ''}
          disabled={speed === null || setSpeed.isPending}
          data-testid="speed-select"
          onChange={(e) =>
            setSpeed.mutate(Number(e.target.value), {
              onError: (err) => toast.error('Speed change failed', err),
            })
          }
        >
          {speed === null && <option value="">—</option>}
          {presets.map((p) => (
            <option key={p} value={p}>
              {speedLabel(p)}
            </option>
          ))}
        </select>
      </div>
      <span className="muted small shortcut-hint">
        <kbd>Space</kbd> play/pause · <kbd>.</kbd> step
      </span>
    </div>
  );
}
