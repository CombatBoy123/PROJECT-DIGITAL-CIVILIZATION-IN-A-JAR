import type { Calendar, CitizenFrameTuple, Weather } from '@civ/sim-core';

/*
 * Client-side store of the latest world frame received over the stream.
 *
 * The stream sends a keyframe (all citizens) and then deltas (changed citizens
 * only). The store applies them and keeps an estimate of how fast simulation ticks
 * are arriving, so the renderer can interpolate travelling citizens between ticks
 * (render tick = last tick + elapsed real time × estimated ticks per millisecond,
 * capped at one tick ahead). Interpolation is presentation only.
 */

/** Indexes into CitizenFrameTuple. */
export const T_ID = 0;
export const T_ACTIVITY = 1;
export const T_LOCATION = 2;
export const T_FROM = 3;
export const T_TO = 4;
export const T_DEPART = 5;
export const T_ARRIVE = 6;

export interface FrameHeader {
  tick: number;
  calendar: Calendar;
  weather: Weather;
  temperatureC: number;
}

export interface FrameState extends FrameHeader {
  /** Citizens by id. Do not mutate. */
  citizens: ReadonlyMap<number, CitizenFrameTuple>;
  /** Clock value (ms, same clock as `now` passed to the store) when the latest frame arrived. */
  receivedAt: number;
  /** Estimated simulation ticks per millisecond (0 when paused or unknown). */
  ticksPerMs: number;
  /** Incremented on every change; cheap change detection for subscribers. */
  version: number;
}

type Listener = () => void;

/** Number of recent frames used for the tick-rate estimate. */
const RATE_WINDOW = 8;

export class FrameStore {
  private citizens = new Map<number, CitizenFrameTuple>();
  private header: FrameHeader | null = null;
  private receivedAt = 0;
  private running = false;
  private history: { tick: number; at: number }[] = [];
  private version = 0;
  private readonly listeners = new Set<Listener>();

  /** True once a keyframe has been applied since construction or the last clear(). */
  get ready(): boolean {
    return this.header !== null;
  }

  applyKeyframe(header: FrameHeader, citizens: readonly CitizenFrameTuple[], now: number): void {
    this.citizens = new Map(citizens.map((t) => [t[T_ID], t]));
    this.history = [];
    this.accept(header, now);
  }

  /** Apply a delta. Ignored (returns false) until a keyframe has been applied. */
  applyDelta(header: FrameHeader, changed: readonly CitizenFrameTuple[], now: number): boolean {
    if (!this.header) return false;
    for (const t of changed) this.citizens.set(t[T_ID], t);
    this.accept(header, now);
    return true;
  }

  /** Whether the simulation is running; when false the tick rate is treated as 0. */
  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.history = [];
    this.bump();
  }

  /** Forget everything (e.g. after a reset/restore, before the next keyframe). */
  clear(): void {
    this.citizens = new Map();
    this.header = null;
    this.history = [];
    this.bump();
  }

  get state(): FrameState | null {
    if (!this.header) return null;
    return {
      ...this.header,
      citizens: this.citizens,
      receivedAt: this.receivedAt,
      ticksPerMs: this.estimateRate(),
      version: this.version,
    };
  }

  /**
   * Fractional tick to render at time `now`: the last received tick plus the time
   * elapsed since it arrived at the estimated rate, never more than one tick ahead.
   */
  renderTick(now: number): number {
    if (!this.header) return 0;
    const rate = this.estimateRate();
    if (rate <= 0) return this.header.tick;
    return this.header.tick + Math.min(1, Math.max(0, (now - this.receivedAt) * rate));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private accept(header: FrameHeader, now: number): void {
    const previousTick = this.header?.tick;
    this.header = header;
    this.receivedAt = now;
    if (previousTick === undefined || header.tick < previousTick) this.history = [];
    this.history.push({ tick: header.tick, at: now });
    if (this.history.length > RATE_WINDOW) this.history.shift();
    this.bump();
  }

  private estimateRate(): number {
    if (!this.running || this.history.length < 2) return 0;
    const first = this.history[0] as { tick: number; at: number };
    const last = this.history[this.history.length - 1] as { tick: number; at: number };
    const dt = last.at - first.at;
    const dTick = last.tick - first.tick;
    return dt > 0 && dTick > 0 ? dTick / dt : 0;
  }

  private bump(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
