import { parseConfig, SeedSchema } from '../config.js';
import { EventLog } from '../events/log.js';
import type { SimEvent } from '../events/types.js';
import {
  checkEventSequence,
  checkInvariants,
  InvariantViolationError,
} from '../invariants/check.js';
import { computeMetrics } from '../metrics/compute.js';
import type { MetricSample } from '../metrics/definitions.js';
import type { WorldState } from '../state/schema.js';
import { deserializeState, hashState, serializeState } from '../state/serialize.js';
import { calendarAt, type Calendar } from '../time/clock.js';
import { generateWorld } from '../world/generate.js';
import { createTickContext, WorldIndex } from './context.js';
import { PIPELINE } from './pipeline.js';

/**
 * When invariants are checked. 'every-tick' is the default; 'off' exists for
 * benchmarks and must not be used for experiments whose results matter.
 */
export type InvariantMode = 'every-tick' | 'off';

export interface SimulationOptions {
  invariants?: InvariantMode;
}

/** Outcome of one step (or of genesis, tick 0). */
export interface StepResult {
  tick: number;
  events: SimEvent[];
  /** Metric sample for this tick, or null when the tick is not a sampling tick. */
  metrics: MetricSample | null;
}

export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * A running simulation: the world state plus derived indexes. Deterministic: the
 * same seed, configuration and sequence of calls always produce the same states,
 * events and metrics.
 */
export class Simulation {
  private readonly current: WorldState;
  private readonly lookup: WorldIndex;
  private readonly invariantMode: InvariantMode;
  private failure: InvariantViolationError | null = null;

  private constructor(state: WorldState, options: SimulationOptions = {}) {
    this.current = state;
    this.lookup = new WorldIndex(state);
    this.invariantMode = options.invariants ?? 'every-tick';
  }

  /** Generate a new world (tick 0) from a seed and configuration. */
  static create(
    seed: string,
    configInput: unknown = {},
    options: SimulationOptions = {},
  ): { simulation: Simulation; genesis: StepResult } {
    SeedSchema.parse(seed);
    const config = parseConfig(configInput);
    const { state, events } = generateWorld(seed, config);
    const simulation = new Simulation(state, options);
    simulation.verify(events, 1, 0);
    return {
      simulation,
      genesis: { tick: 0, events, metrics: { tick: 0, values: computeMetrics(state) } },
    };
  }

  /** Restore from serialised state; verifies the hash when given and checks invariants. */
  static deserialize(
    json: string,
    expectedHash?: string,
    options: SimulationOptions = {},
  ): Simulation {
    const simulation = new Simulation(deserializeState(json, expectedHash), options);
    simulation.verify([], simulation.current.nextEventSeq, simulation.current.tick);
    return simulation;
  }

  /** Restore from a state object (deep-copied so the caller's object is never aliased). */
  static fromState(state: WorldState, options: SimulationOptions = {}): Simulation {
    return Simulation.deserialize(serializeState(state), undefined, options);
  }

  get state(): DeepReadonly<WorldState> {
    return this.current;
  }

  get index(): WorldIndex {
    return this.lookup;
  }

  get tick(): number {
    return this.current.tick;
  }

  get calendar(): Calendar {
    return calendarAt(this.current.tick, this.current.config);
  }

  /** The invariant failure that stopped this simulation, if any. */
  get halted(): InvariantViolationError | null {
    return this.failure;
  }

  /** Advance the world by one tick. */
  step(): StepResult {
    if (this.failure) throw this.failure;
    const state = this.current;
    const tick = state.tick + 1;
    const calendar = calendarAt(tick, state.config);
    const firstSeq = state.nextEventSeq;
    const events = new EventLog(state, tick);
    state.tick = tick;
    const ctx = createTickContext(state, this.lookup, tick, calendar, events);
    for (const system of PIPELINE) system.run(ctx);

    const emitted = [...events.list];
    this.verify(emitted, firstSeq, tick);
    const metrics =
      tick % state.config.metricsInterval === 0 ? { tick, values: computeMetrics(state) } : null;
    return { tick, events: emitted, metrics };
  }

  /** Run `count` steps and return their results. */
  run(count: number): StepResult[] {
    const results: StepResult[] = [];
    for (let i = 0; i < count; i++) results.push(this.step());
    return results;
  }

  /** Canonical JSON of the full state. */
  serialize(): string {
    return serializeState(this.current);
  }

  /** Hash of the canonical state. Equal hashes ⇔ (with overwhelming probability) equal states. */
  hash(): string {
    return hashState(this.current);
  }

  private verify(events: readonly SimEvent[], firstSeq: number, tick: number): void {
    if (this.invariantMode === 'off') return;
    const violations = [
      ...checkInvariants(this.current),
      ...checkEventSequence(events, firstSeq, tick),
    ];
    if (violations.length > 0) {
      this.failure = new InvariantViolationError(tick, violations);
      throw this.failure;
    }
  }
}
