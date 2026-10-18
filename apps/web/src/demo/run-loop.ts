import type { DemoEngine } from './engine';

/*
 * Real-time driver of the demo: a requestAnimationFrame loop with a tick debt.
 * Each animation frame adds (elapsed seconds × speed) simulated hours to the debt and
 * steps the whole ticks it holds, at most MAX_TICKS_PER_FRAME per frame so a slow
 * phone never freezes; a backlog larger than that is dropped (the run slows down
 * instead of spiralling). The loop runs only while playing, the page is visible and
 * the simulation has not halted. Wall-clock time decides only *when* ticks run,
 * never what happens in them.
 */

/** Speeds offered in the playback bar, in simulated hours (ticks) per real second. */
export const SPEEDS = [1, 4, 12, 48] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 4;

/**
 * Upper bound of ticks stepped in one animation frame. 48 h/s needs 6 fps at this
 * bound; one tick costs about 0.2 ms for 100 people and 1.5 ms for 1,000 (Node), so
 * a full frame's worth stays well under a frame budget.
 */
export const MAX_TICKS_PER_FRAME = 8;
/** Longer gaps between frames (tab switch, debugger) count as this many ms. */
const MAX_FRAME_GAP_MS = 250;

export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

const rafScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

type Steppable = Pick<DemoEngine, 'step' | 'setRunning' | 'halted'>;

export class RunLoop {
  private playing = false;
  private hidden = false;
  private speed: number = DEFAULT_SPEED;
  private debt = 0;
  private last: number | null = null;
  private handle: number | null = null;

  constructor(
    private readonly engine: Steppable,
    private readonly scheduler: FrameScheduler = rafScheduler,
  ) {}

  get active(): boolean {
    return this.playing && !this.hidden && this.engine.halted === null;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.sync();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, speed);
  }

  /** The document became hidden (stop stepping) or visible again (resume if playing). */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.sync();
  }

  destroy(): void {
    this.playing = false;
    this.sync();
  }

  private sync(): void {
    const active = this.active;
    this.engine.setRunning(active);
    if (active && this.handle === null) {
      this.last = null;
      // The first frame after Play steps one tick at once, so Play responds immediately.
      this.debt = 1;
      this.handle = this.scheduler.request(this.frame);
    } else if (!active && this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
  }

  private readonly frame = (now: number): void => {
    this.handle = null;
    if (!this.active) {
      this.sync();
      return;
    }
    if (this.last !== null) {
      const dt = Math.min(MAX_FRAME_GAP_MS, Math.max(0, now - this.last));
      this.debt += (dt / 1000) * this.speed;
    }
    this.last = now;
    const ticks = Math.min(MAX_TICKS_PER_FRAME, Math.floor(this.debt));
    if (ticks > 0) {
      this.debt -= ticks;
      this.engine.step(ticks);
    }
    if (this.debt > MAX_TICKS_PER_FRAME) this.debt = MAX_TICKS_PER_FRAME;
    if (this.active) this.handle = this.scheduler.request(this.frame);
    else this.sync();
  };
}
