import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  InvariantViolationError,
  Simulation,
  type Calendar,
  type InvariantMode,
  type MetricSample,
  type SimEvent,
  type StepResult,
} from '@civ/sim-core';
import type { CivilizationStatus } from '@civ/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../http/errors.js';
import { captureState, type EncodedState } from '../persistence/codec.js';
import { ProjectionTracker } from '../persistence/projections.js';
import type { CivilizationStore } from '../persistence/store.js';
import { SerialQueue } from './serial-queue.js';

export interface RunnerSettings {
  /** Maximum real time between checkpoints while running. */
  checkpointIntervalMs: number;
  /** Buffered (uncommitted) events that force a synchronous checkpoint (backpressure). */
  maxBufferedEvents: number;
  invariants: InvariantMode;
  /** Longest stretch of ticks executed before yielding to the event loop. */
  sliceBudgetMs: number;
}

/** Buffered metric samples that force a checkpoint. */
const MAX_BUFFERED_METRICS = 5000;
/** Longest pause between slices while running at a finite speed. */
const MAX_SLICE_DELAY_MS = 50;

export type RunnerNotice =
  | { type: 'advanced'; tick: number; events: readonly SimEvent[] }
  | { type: 'status' }
  | { type: 'checkpoint'; tick: number }
  /** The in-memory world was replaced (restore, reset, or reload after a halt). */
  | { type: 'reset'; tick: number }
  | { type: 'deleted' };

export interface RunnerSummary {
  status: CivilizationStatus;
  speed: number;
  tick: number;
  durableTick: number;
  calendar: Calendar;
  haltReason: string | null;
  lastError: string | null;
}

export interface RunnerInit {
  id: string;
  simulation: Simulation;
  status: CivilizationStatus;
  speed: number;
  haltReason: string | null;
  store: CivilizationStore;
  settings: RunnerSettings;
  log: FastifyBaseLogger;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns one loaded civilization: its in-memory simulation, the background tick
 * loop and the buffers of not-yet-durable events and metrics.
 *
 * Ticks never run inside HTTP handlers; handlers enqueue control operations on a
 * serial queue, and the loop runs in time slices between other work. All state
 * that reaches the database goes through `checkpoint()`, which writes events,
 * metrics, projections and the state blob for one tick in one transaction.
 */
export class SimulationRunner {
  readonly id: string;
  private simulation: Simulation;
  private status: CivilizationStatus;
  private speed: number;
  private durableTick: number;
  private haltReason: string | null;
  private lastError: string | null = null;

  private pendingEvents: SimEvent[] = [];
  private pendingMetrics: MetricSample[] = [];
  private readonly projection = new ProjectionTracker();
  private readonly queue = new SerialQueue();
  private readonly listeners = new Set<(notice: RunnerNotice) => void>();
  private readonly store: CivilizationStore;
  private readonly settings: RunnerSettings;
  private readonly log: FastifyBaseLogger;

  private timer: NodeJS.Timeout | null = null;
  private tickDebt = 0;
  private lastSliceAt = 0;
  private lastFlushAt = 0;
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(init: RunnerInit) {
    this.id = init.id;
    this.simulation = init.simulation;
    this.status = init.status;
    this.speed = init.speed;
    this.haltReason = init.haltReason;
    this.durableTick = init.simulation.tick;
    this.store = init.store;
    this.settings = init.settings;
    this.log = init.log.child({ civilizationId: init.id });
    // The database projection was written together with the checkpoint we loaded.
    this.projection.delta(this.simulation.state);
    this.lastFlushAt = performance.now();
    if (this.status === 'running') this.startLoop();
  }

  // ---------------------------------------------------------------- reads

  get sim(): Simulation {
    return this.simulation;
  }

  summary(): RunnerSummary {
    return {
      status: this.status,
      speed: this.speed,
      tick: this.simulation.tick,
      durableTick: this.durableTick,
      calendar: this.simulation.calendar,
      haltReason: this.haltReason,
      lastError: this.lastError,
    };
  }

  subscribe(listener: (notice: RunnerNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(notice: RunnerNotice): void {
    for (const listener of this.listeners) {
      try {
        listener(notice);
      } catch (err) {
        this.log.error({ err }, 'Runner listener failed');
      }
    }
  }

  // ---------------------------------------------------------------- control

  start(actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      this.assertUsable();
      if (this.status === 'running') return this.summary();
      await this.store.updateRuntime(this.id, { status: 'running' });
      this.status = 'running';
      this.lastError = null;
      await this.store.audit({
        civilizationId: this.id,
        action: 'simulation.started',
        actor,
        tick: this.simulation.tick,
        details: { speed: this.speed },
      });
      this.startLoop();
      this.notify({ type: 'status' });
      return this.summary();
    });
  }

  pause(actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      if (this.status !== 'running') return this.summary();
      this.status = 'paused';
      this.stopLoop();
      this.notify({ type: 'status' });
      await this.checkpoint();
      await this.store.audit({
        civilizationId: this.id,
        action: 'simulation.paused',
        actor,
        tick: this.simulation.tick,
        details: {},
      });
      return this.summary();
    });
  }

  /** Advance a paused simulation by `count` ticks (time-sliced), then checkpoint. */
  step(count: number, actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      this.assertUsable();
      if (this.status === 'running')
        throw new AppError('CONFLICT', 'Pause the simulation before stepping');
      const fromTick = this.simulation.tick;
      let remaining = count;
      while (remaining > 0 && this.status === 'paused') {
        remaining -= this.advance(remaining, performance.now() + this.settings.sliceBudgetMs);
        if (this.bufferFull()) await this.checkpoint();
        if (remaining > 0) await yieldToEventLoop();
      }
      if (this.status === 'paused') await this.checkpoint();
      await this.store.audit({
        civilizationId: this.id,
        action: 'simulation.stepped',
        actor,
        tick: this.simulation.tick,
        details: { requested: count, fromTick, toTick: this.simulation.tick },
      });
      return this.summary();
    });
  }

  setSpeed(ticksPerSecond: number, actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      await this.store.updateRuntime(this.id, { speed: ticksPerSecond });
      this.speed = ticksPerSecond;
      this.tickDebt = 0;
      await this.store.audit({
        civilizationId: this.id,
        action: 'simulation.speed_changed',
        actor,
        tick: this.simulation.tick,
        details: { ticksPerSecond },
      });
      this.notify({ type: 'status' });
      return this.summary();
    });
  }

  /** Save a named snapshot of the current state, atomically consistent with a checkpoint. */
  saveSnapshot(name: string, note: string | null, actor: string) {
    return this.queue.run(async () => {
      this.assertUsable();
      const encoded = await this.checkpoint();
      return this.store.createSnapshot(this.id, name, note, encoded, actor);
    });
  }

  /** Rewind to a snapshot on the current timeline. Destructive: later history is removed. */
  restoreSnapshot(snapshotId: string, actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      const { simulation, name, tick } = await this.store.loadSnapshot(this.id, snapshotId, {
        invariants: this.settings.invariants,
      });
      const fromTick = this.simulation.tick;
      await this.replaceWorld(simulation, {
        events: [],
        metrics: [],
        truncate: { fromSeq: simulation.state.nextEventSeq, afterTick: tick },
        audit: {
          action: 'snapshot.restored',
          actor,
          details: { snapshotId, name, fromTick, toTick: tick },
        },
      });
      return this.summary();
    });
  }

  /** Regenerate the world from the same seed and configuration. Destructive. */
  reset(actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      const { seed, config } = this.simulation.state;
      const { simulation, genesis } = Simulation.create(seed, config, {
        invariants: this.settings.invariants,
      });
      const fromTick = this.simulation.tick;
      await this.replaceWorld(simulation, {
        events: genesis.events,
        metrics: genesis.metrics ? [genesis.metrics] : [],
        truncate: { fromSeq: 1, afterTick: -1 },
        audit: {
          action: 'simulation.reset',
          actor,
          details: { fromTick, stateHash: simulation.hash() },
        },
      });
      return this.summary();
    });
  }

  /** Persist everything and stop the loop (server shutdown). The stored status is kept. */
  shutdown(): Promise<void> {
    return this.queue.run(async () => {
      this.stopLoop();
      if (
        !this.disposed &&
        this.status !== 'halted' &&
        (this.pendingEvents.length > 0 || this.simulation.tick !== this.durableTick)
      ) {
        await this.checkpoint().catch((err: unknown) =>
          this.log.error({ err }, 'Final checkpoint failed'),
        );
      }
      this.disposed = true;
    });
  }

  /** Stop and detach (civilization deleted). Runs on the control queue. */
  dispose(): Promise<void> {
    return this.queue.run(async () => {
      this.stopLoop();
      while (this.flushing) await this.flushing.catch(() => undefined);
      this.disposed = true;
      this.notify({ type: 'deleted' });
      this.listeners.clear();
    });
  }

  // ---------------------------------------------------------------- internals

  private assertUsable(): void {
    if (this.disposed) throw new AppError('NOT_FOUND', 'Civilization not found');
    if (this.status === 'halted') {
      throw new AppError(
        'HALTED',
        `Simulation halted: ${this.haltReason ?? 'invariant violation'}. Restore a snapshot or reset.`,
      );
    }
  }

  private bufferFull(): boolean {
    return (
      this.pendingEvents.length >= this.settings.maxBufferedEvents ||
      this.pendingMetrics.length >= MAX_BUFFERED_METRICS
    );
  }

  private startLoop(): void {
    this.stopLoop();
    this.tickDebt = 0;
    this.lastSliceAt = performance.now();
    this.schedule(0);
  }

  private stopLoop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.slice();
    }, delayMs);
  }

  /** One slice of the background loop. */
  private async slice(): Promise<void> {
    if (this.status !== 'running' || this.disposed) return;
    const now = performance.now();
    let budget = Number.POSITIVE_INFINITY;
    if (this.speed > 0) {
      // Accumulate fractional ticks; cap the debt so a stalled loop does not burst afterwards.
      this.tickDebt = Math.min(
        this.tickDebt + ((now - this.lastSliceAt) * this.speed) / 1000,
        Math.max(1, this.speed),
      );
      budget = Math.floor(this.tickDebt);
    }
    this.lastSliceAt = now;
    const ran = this.advance(budget, now + this.settings.sliceBudgetMs);
    if (this.speed > 0) this.tickDebt -= ran;
    if (this.status !== 'running') return;

    if (this.bufferFull()) {
      // Backpressure: no further ticks until the buffer is durable.
      await this.checkpoint().catch(() => undefined);
    } else if (
      !this.flushing &&
      performance.now() - this.lastFlushAt >= this.settings.checkpointIntervalMs
    ) {
      void this.checkpoint().catch(() => undefined);
    }
    if (this.status !== 'running' || this.timer || this.disposed) return;
    const delay =
      this.speed > 0
        ? Math.min(MAX_SLICE_DELAY_MS, Math.max(0, ((1 - this.tickDebt) * 1000) / this.speed))
        : 0;
    this.schedule(delay);
  }

  /** Execute up to `maxTicks` ticks before `deadline`. Returns the number executed. */
  private advance(maxTicks: number, deadline: number): number {
    let ran = 0;
    const emitted: SimEvent[] = [];
    while (ran < maxTicks && !this.bufferFull()) {
      let result: StepResult;
      try {
        result = this.simulation.step();
      } catch (err) {
        if (err instanceof InvariantViolationError) {
          this.halt(err);
          break;
        }
        throw err;
      }
      ran++;
      for (const e of result.events) {
        this.pendingEvents.push(e);
        emitted.push(e);
      }
      if (result.metrics) this.pendingMetrics.push(result.metrics);
      if (performance.now() >= deadline) break;
    }
    if (ran > 0) this.notify({ type: 'advanced', tick: this.simulation.tick, events: emitted });
    return ran;
  }

  /**
   * An invariant failed: the in-memory state is impossible. Stop, drop the
   * uncommitted buffers (they cannot be committed without a consistent state),
   * record the halt, and reload the last durable checkpoint into memory.
   */
  private halt(err: InvariantViolationError): void {
    this.stopLoop();
    this.status = 'halted';
    this.haltReason = err.message;
    this.pendingEvents = [];
    this.pendingMetrics = [];
    this.log.error(
      { violations: err.violations, tick: err.tick },
      'Simulation halted by invariant violation',
    );
    this.notify({ type: 'status' });
    void this.queue.run(async () => {
      try {
        while (this.flushing) await this.flushing.catch(() => undefined);
        await this.store.updateRuntime(this.id, { status: 'halted', haltReason: err.message });
        await this.store.audit({
          civilizationId: this.id,
          action: 'simulation.halted',
          actor: 'engine',
          tick: err.tick,
          details: { violations: err.violations as unknown as object[] },
        });
        const { simulation } = await this.store.loadCheckpoint(this.id, {
          invariants: this.settings.invariants,
        });
        this.simulation = simulation;
        this.durableTick = simulation.tick;
        this.projection.reset();
        this.projection.delta(simulation.state);
        this.notify({ type: 'reset', tick: simulation.tick });
      } catch (persistErr) {
        this.lastError = `Failed to record halt: ${message(persistErr)}`;
        this.log.error({ err: persistErr }, 'Failed to record halt');
        this.notify({ type: 'status' });
      }
    });
  }

  /**
   * Write the current state as a checkpoint (waiting for any in-flight write first).
   * Resolves with the state that became durable.
   */
  private async checkpoint(): Promise<EncodedState> {
    while (this.flushing) await this.flushing.catch(() => undefined);
    const encoded = captureState(this.simulation.state);
    const events = this.pendingEvents;
    const metrics = this.pendingMetrics;
    this.pendingEvents = [];
    this.pendingMetrics = [];
    const projection = this.projection.delta(this.simulation.state);
    const write = this.store.writeCheckpoint({
      civilizationId: this.id,
      encoded,
      events,
      metrics,
      projection,
      status: this.status,
    });
    this.flushing = write;
    this.lastFlushAt = performance.now();
    try {
      await write;
      this.durableTick = encoded.tick;
      this.lastError = null;
      this.notify({ type: 'checkpoint', tick: encoded.tick });
      return encoded;
    } catch (err) {
      // Keep everything in memory; the next checkpoint retries with a full projection write.
      this.pendingEvents = events.concat(this.pendingEvents);
      this.pendingMetrics = metrics.concat(this.pendingMetrics);
      this.projection.reset();
      this.lastError = `Checkpoint failed: ${message(err)}`;
      this.log.error({ err }, 'Checkpoint failed');
      if (this.status === 'running') {
        this.status = 'paused';
        this.stopLoop();
      }
      this.notify({ type: 'status' });
      throw new AppError('INTERNAL', this.lastError);
    } finally {
      if (this.flushing === write) this.flushing = null;
    }
  }

  private async replaceWorld(
    next: Simulation,
    change: {
      events: readonly SimEvent[];
      metrics: readonly MetricSample[];
      truncate: { fromSeq: number; afterTick: number };
      audit: { action: string; actor: string; details: Record<string, unknown> };
    },
  ): Promise<void> {
    this.stopLoop();
    while (this.flushing) await this.flushing.catch(() => undefined);
    const encoded = captureState(next.state);
    const projection = this.projection.delta(next.state, true);
    try {
      await this.store.rewind({
        civilizationId: this.id,
        encoded,
        projection,
        events: change.events,
        metrics: change.metrics,
        truncate: change.truncate,
        audit: {
          action: change.audit.action,
          actor: change.audit.actor,
          details: change.audit.details as never,
        },
      });
    } catch (err) {
      // Nothing changed in the database; re-sync the tracker with the current world.
      this.projection.reset();
      this.projection.delta(this.simulation.state);
      this.projection.reset();
      if (this.status === 'running') this.startLoop();
      throw err;
    }
    this.simulation = next;
    this.pendingEvents = [];
    this.pendingMetrics = [];
    this.durableTick = next.tick;
    this.status = 'paused';
    this.haltReason = null;
    this.lastError = null;
    this.notify({ type: 'reset', tick: next.tick });
    this.notify({ type: 'status' });
  }
}
