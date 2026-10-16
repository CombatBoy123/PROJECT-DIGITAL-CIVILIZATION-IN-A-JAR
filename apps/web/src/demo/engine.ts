import {
  buildLayout,
  calendarAt,
  citizenFrameTuple,
  computeMetrics,
  InvariantViolationError,
  Simulation,
  type Calendar,
  type CitizenFrameTuple,
  type MetricValues,
  type SimEvent,
  type SimulationConfigInput,
  type WorldState,
} from '@civ/sim-core';
import type { LayoutResponse } from '@civ/shared';
import { FrameStore, type FrameHeader } from '../world/frame-store';

/*
 * Controller of the browser demo: owns one Simulation and everything the page shows
 * about it. Pure TypeScript (no React, no PixiJS, no DOM), so it is unit-tested in
 * Node like the engine itself.
 *
 *  - step(n) advances the world, keeps the newest events in a bounded ring and feeds
 *    the FrameStore with a delta of the citizens whose frame tuple changed;
 *  - savePoint()/restore() keep one in-memory save point (serialised state + hash)
 *    and restore it through Simulation.deserialize, which verifies the hash and
 *    re-checks every invariant;
 *  - resetToGenesis() regenerates the world from the same seed and configuration;
 *  - an InvariantViolationError (or any other engine error) halts the run; the
 *    message is kept for the page and further steps are refused.
 *
 * The clock used for the FrameStore (`now`) is injectable so tests are deterministic.
 * Nothing here feeds wall-clock time into the simulation.
 */

/** How many recent events the page keeps (newest last). */
export const EVENT_RING_SIZE = 400;

export interface WorldSettings {
  seed: string;
  config: SimulationConfigInput;
}

export const DEFAULT_SETTINGS: WorldSettings = { seed: 'demo-1', config: { population: 100 } };

export interface SavePoint {
  tick: number;
  hash: string;
  json: string;
}

type Listener = () => void;

export interface DemoEngineOptions {
  /** Clock for FrameStore arrival times (ms). Defaults to performance.now. */
  now?: () => number;
  /** Store to feed; a new one is created when omitted. */
  frames?: FrameStore;
  /** Ring capacity (tests use small values). */
  eventCapacity?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameTuple(a: CitizenFrameTuple, b: CitizenFrameTuple): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class DemoEngine {
  readonly frames: FrameStore;
  private readonly now: () => number;
  private readonly capacity: number;
  private sim!: Simulation;
  private currentSettings!: WorldSettings;
  private currentLayout!: LayoutResponse;
  private currentMetrics!: MetricValues;
  private ring: SimEvent[] = [];
  private lastTuples = new Map<number, CitizenFrameTuple>();
  private saved: SavePoint | null = null;
  private failure: string | null = null;
  private isRunning = false;
  private changeCount = 0;
  private readonly listeners = new Set<Listener>();

  constructor(settings: WorldSettings = DEFAULT_SETTINGS, options: DemoEngineOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.frames = options.frames ?? new FrameStore();
    this.capacity = Math.max(1, options.eventCapacity ?? EVENT_RING_SIZE);
    this.create(settings);
  }

  // --- Lifecycle --------------------------------------------------------------

  /**
   * Generate a new world. Throws (leaving the current world untouched) when the seed
   * or configuration is invalid.
   */
  create(settings: WorldSettings): void {
    const { simulation, genesis } = Simulation.create(settings.seed, settings.config);
    this.currentSettings = { seed: settings.seed, config: structuredClone(settings.config) };
    this.saved = null;
    this.ring = [];
    this.adopt(simulation);
    this.pushEvents(genesis.events);
    this.emit();
  }

  /** Back to tick 0 with the same seed and configuration (the save point is kept). */
  resetToGenesis(): void {
    const saved = this.saved;
    this.create(this.currentSettings);
    this.saved = saved;
    this.emit();
  }

  /** Remember the current state in memory (replaces any earlier save point). */
  savePoint(): SavePoint | null {
    if (this.failure) return null;
    this.saved = { tick: this.sim.tick, hash: this.sim.hash(), json: this.sim.serialize() };
    this.emit();
    return this.saved;
  }

  /**
   * Return to the save point. The hash is verified and invariants are re-checked by
   * Simulation.deserialize. The event ring is cleared: events after the save point
   * never happened in the restored timeline. Returns false when there is no save point.
   */
  restore(): boolean {
    const saved = this.saved;
    if (!saved) return false;
    const simulation = Simulation.deserialize(saved.json, saved.hash);
    this.ring = [];
    this.adopt(simulation);
    this.emit();
    return true;
  }

  // --- Running ---------------------------------------------------------------

  /**
   * Advance up to `count` ticks. Returns the number of ticks actually completed;
   * fewer than requested only when the simulation halted.
   */
  step(count = 1): number {
    if (this.failure || count <= 0) return 0;
    let done = 0;
    try {
      for (; done < count; done++) {
        const result = this.sim.step();
        this.pushEvents(result.events);
      }
    } catch (error) {
      this.failure =
        error instanceof InvariantViolationError
          ? error.message
          : `The engine stopped: ${errorMessage(error)}`;
      this.setRunning(false);
    }
    if (done > 0) {
      this.currentMetrics = computeMetrics(this.sim.state as WorldState);
      this.feedDelta();
    }
    this.emit();
    return done;
  }

  /** Tell the FrameStore whether ticks are arriving continuously (for interpolation). */
  setRunning(running: boolean): void {
    const next = running && this.failure === null;
    if (next === this.isRunning) return;
    this.isRunning = next;
    this.frames.setRunning(next);
    this.emit();
  }

  // --- Read access -------------------------------------------------------------

  get settings(): WorldSettings {
    return this.currentSettings;
  }
  get state(): Simulation['state'] {
    return this.sim.state;
  }
  get index(): Simulation['index'] {
    return this.sim.index;
  }
  get tick(): number {
    return this.sim.tick;
  }
  get calendar(): Calendar {
    return this.sim.calendar;
  }
  get daysPerSeason(): number {
    return this.sim.state.config.daysPerSeason;
  }
  get layout(): LayoutResponse {
    return this.currentLayout;
  }
  get metrics(): MetricValues {
    return this.currentMetrics;
  }
  /** Recent events, oldest first (at most the ring capacity). */
  get events(): readonly SimEvent[] {
    return this.ring;
  }
  get savePointInfo(): Omit<SavePoint, 'json'> | null {
    return this.saved ? { tick: this.saved.tick, hash: this.saved.hash } : null;
  }
  /** Why the run stopped, or null while healthy. */
  get halted(): string | null {
    return this.failure;
  }
  get running(): boolean {
    return this.isRunning;
  }
  /** Incremented on every change; cheap change detection for subscribers. */
  get version(): number {
    return this.changeCount;
  }

  /** Calendar of an arbitrary tick in this world. */
  calendarAt(tick: number): Calendar {
    return calendarAt(tick, this.sim.state.config);
  }

  /** State hash at the current tick: equal for equal seed, settings and tick. */
  fingerprint(): string {
    return this.sim.hash();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Internals ---------------------------------------------------------------

  private adopt(simulation: Simulation): void {
    this.sim = simulation;
    this.failure = null;
    const state = simulation.state;
    this.currentLayout = { ...buildLayout(state), asOfTick: state.tick };
    this.currentMetrics = computeMetrics(state as WorldState);
    const tuples = state.citizens.map(citizenFrameTuple);
    this.lastTuples = new Map(tuples.map((t) => [t[0], t]));
    this.frames.applyKeyframe(this.header(), tuples, this.now());
  }

  private header(): FrameHeader {
    const state = this.sim.state;
    return {
      tick: state.tick,
      calendar: this.sim.calendar,
      weather: state.environment.weather,
      temperatureC: state.environment.temperatureC,
    };
  }

  /** Send the FrameStore only the citizens whose tuple changed (a keyframe if the set changed). */
  private feedDelta(): void {
    const citizens = this.sim.state.citizens;
    const changed: CitizenFrameTuple[] = [];
    const next = new Map<number, CitizenFrameTuple>();
    for (const c of citizens) {
      const t = citizenFrameTuple(c);
      next.set(t[0], t);
      const before = this.lastTuples.get(t[0]);
      if (!before || !sameTuple(before, t)) changed.push(t);
    }
    const sameSet = next.size === this.lastTuples.size;
    this.lastTuples = next;
    if (sameSet) this.frames.applyDelta(this.header(), changed, this.now());
    else this.frames.applyKeyframe(this.header(), [...next.values()], this.now());
  }

  private pushEvents(events: readonly SimEvent[]): void {
    if (events.length === 0) return;
    for (const e of events) this.ring.push(e);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  private emit(): void {
    this.changeCount++;
    for (const listener of this.listeners) listener();
  }
}
