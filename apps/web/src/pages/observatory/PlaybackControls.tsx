import { SPEED_PRESETS, type CivilizationStatus } from '@civ/shared';
import { TICKS_PER_DAY } from '@civ/sim-core';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useControl, useSetSpeed } from '../../api/queries';
import { useAccess } from '../../api/useAccess';
import { AccessNote } from '../../components/Feedback';
import { useToast } from '../../components/Toasts';
import { shortcutFor } from '../../lib/keyboard';

/*
 * Run controls: play/pause, single step, step one day, speed presets. Space and "."
 * are global shortcuts (ignored while typing). The server is authoritative: the
 * displayed status comes from the stream, not from the button that was pressed.
 * Without operator rights (see useAccess) the controls are disabled, the shortcuts
 * do nothing and the reason is shown in place of the shortcut hint.
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
  const access = useAccess();
  const speedId = useId();
  const noteId = useId();
  const running = status === 'running';
  const halted = status === 'halted';
  const busy = control.isPending;
  const canOperate = access.canOperate;
  const disabled = status === null || halted || busy || !canOperate;
  const describedBy = canOperate ? undefined : noteId;

  const togglePlay = useCallback(() => {
    if (!canOperate || status === null || status === 'halted' || control.isPending) return;
    control.mutate(
      { action: status === 'running' ? 'pause' : 'start' },
      { onError: (e) => toast.error(status === 'running' ? 'Pause failed' : 'Start failed', e) },
    );
  }, [canOperate, control, status, toast]);

  const step = useCallback(
    (steps: number) => {
      if (!canOperate || status !== 'paused' || control.isPending) return;
      control.mutate({ action: 'step', steps }, { onError: (e) => toast.error('Step failed', e) });
    },
    [canOperate, control, status, toast],
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
        aria-describedby={describedBy}
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
        aria-describedby={describedBy}
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
        aria-describedby={describedBy}
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
          disabled={speed === null || setSpeed.isPending || !canOperate}
          aria-describedby={describedBy}
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
      {canOperate ? (
        <span className="muted small shortcut-hint">
          <kbd>Space</kbd> play/pause · <kbd>.</kbd> step
        </span>
      ) : (
        <AccessNote id={noteId} reason={access.reason ?? 'Operator token required.'} />
      )}
    </div>
  );
}
