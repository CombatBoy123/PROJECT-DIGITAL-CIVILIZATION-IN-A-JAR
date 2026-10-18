import { TICKS_PER_DAY } from '@civ/sim-core';
import { useId, useRef, type KeyboardEvent } from 'react';
import { SPEEDS, type Speed } from './run-loop';

/*
 * Play/Pause, single-hour and single-day steps, and the speed choice (simulated
 * hours per real second): a radio group on wider screens, a native select with the
 * unit in every option on phones (one 44px control instead of four small ones).
 * Only one of the two is displayed (CSS), so assistive technology sees one control.
 */

export function PlaybackBar({
  playing,
  halted,
  speed,
  onTogglePlay,
  onStep,
  onSpeed,
}: {
  playing: boolean;
  halted: boolean;
  speed: Speed;
  onTogglePlay: () => void;
  onStep: (ticks: number) => void;
  onSpeed: (speed: Speed) => void;
}) {
  const radios = useRef(new Map<Speed, HTMLButtonElement>());
  const labelId = useId();
  const selectId = useId();

  // Radio group keyboard pattern: arrows move the choice.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = SPEEDS.indexOf(speed);
    let next = index;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % SPEEDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (index - 1 + SPEEDS.length) % SPEEDS.length;
    else return;
    e.preventDefault();
    const s = SPEEDS[next];
    if (s === undefined) return;
    onSpeed(s);
    radios.current.get(s)?.focus();
  };

  return (
    <div className="playback" role="group" aria-label="Simulation controls">
      <button
        type="button"
        className={`btn playback-play ${playing ? '' : 'btn-primary'}`}
        disabled={halted}
        onClick={onTogglePlay}
        data-testid="play-pause"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="btn-icon">
          {playing ? <path d="M5 3.5v9M11 3.5v9" /> : <path d="M5 3l8 5-8 5z" />}
        </svg>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        className="btn"
        disabled={halted}
        onClick={() => onStep(1)}
        title="Advance one hour (one tick)"
        data-testid="step-hour"
      >
        +1 <span className="label-long">hour</span>
        <span className="label-short">h</span>
      </button>
      <button
        type="button"
        className="btn"
        disabled={halted}
        onClick={() => onStep(TICKS_PER_DAY)}
        title="Advance one day (24 ticks)"
        data-testid="step-day"
      >
        +1 <span className="label-long">day</span>
        <span className="label-short">d</span>
      </button>
      <div className="speed speed-picker">
        <label htmlFor={selectId} className="sr-only">
          Speed, in simulated hours per second
        </label>
        <select
          id={selectId}
          className="speed-select"
          value={speed}
          onChange={(e) => {
            const s = SPEEDS.find((v) => v === Number(e.target.value));
            if (s !== undefined) onSpeed(s);
          }}
          data-testid="speed-select"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} h/s
            </option>
          ))}
        </select>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="speed-caret">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>
      <div className="speed speed-radios">
        <span className="speed-label" id={labelId}>
          Speed <span className="muted">h/s</span>
        </span>
        <div
          className="segmented"
          role="radiogroup"
          aria-labelledby={labelId}
          onKeyDown={onKeyDown}
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              ref={(el) => {
                if (el) radios.current.set(s, el);
                else radios.current.delete(s);
              }}
              type="button"
              role="radio"
              aria-checked={s === speed}
              aria-label={`${s} simulated ${s === 1 ? 'hour' : 'hours'} per second`}
              tabIndex={s === speed ? 0 : -1}
              className="segment"
              onClick={() => onSpeed(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
