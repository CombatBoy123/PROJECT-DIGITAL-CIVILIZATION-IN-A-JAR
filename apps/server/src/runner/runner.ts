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
import type { Prisma } from '@prisma/client';
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

/** The persistence operations a runner needs (a subset of CivilizationStore, fakeable in tests). */
export type RunnerStore = Pick<
  CivilizationStore,
  | 'writeCheckpoint'
  | 'updateRuntime'
  | 'audit'
  | 'recordHalt'
  | 'loadCheckpoint'
  | 'createSnapshot'
  | 'loadSnapshot'
  | 'rewind'
  | 'deleteCivilization'
>;

/** Buffered metric samples that force a checkpoint. */
const MAX_BUFFERED_METRICS = 5000;
/** Longest pause between slices while running at a finite speed. */
const MAX_SLICE_DELAY_MS = 50;

export type RunnerNotice =
  /** Ticks were executed in memory. The events are live: not yet durable. */
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
  store: RunnerStore;
  settings: RunnerSettings;
  log: FastifyBaseLogger;
}

/** Why the engine stopped: invariant violations, or an unexpected engine exception. */
interface HaltRecord {
  reason: string;
  tick: number;
  details: Prisma.InputJsonObject;
}

function haltRecord(err: unknown, tick: number): HaltRecord {
  if (err instanceof InvariantViolationError) {
    return {
      reason: err.message,
      tick: err.tick,
      details: { violations: err.violations as unknown as Prisma.InputJsonValue[] },
    };
  }
  const reason = `Engine error at tick ${tick}: ${message(err)}`;
  return { reason, tick, details: { engineError: message(err) } };
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
  /** A halt that is not yet recorded in the database. */
  private unrecordedHalt: HaltRecord | null = null;
  private readonly projection = new ProjectionTracker();
  private readonly queue = new SerialQueue();
  private readonly listeners = new Set<(notice: RunnerNotice) => void>();
  private readonly store: RunnerStore;
  private readonly settings: RunnerSettings;
  private readonly log: FastifyBaseLogger;

  /** True while the background loop should keep running; slices re-check it after every await. */
  private looping = false;
  private timer: NodeJS.Timeout | null = null;
  private tickDebt = 0;
  private lastSliceAt = 0;
  private lastFlushAt = 0;
  private flushing: Promise<void> | null = null;
  private disposed = false;
  private lastUsedAt = performance.now();

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
    this.projection.prime(this.simulation.state);
    this.lastFlushAt = performance.now();
    if (this.status === 'running') this.startLoop();
  }

  // ---------------------------------------------------------------- reads

  get sim(): Simulation {
    return this.simulation;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** Whether the runner can be unloaded without losing anything (idle eviction). */
  get idle(): boolean {
    return (
      this.status !== 'running' &&
      !this.flushing &&
      !this.unrecordedHalt &&
      this.pendingEvents.length === 0 &&
      this.simulation.tick === this.durableTick
    );
  }

  /** Milliseconds since the runner was last handed out by the manager. */
  get idleForMs(): number {
    return performance.now() - this.lastUsedAt;
  }

  touch(): void {
    this.lastUsedAt = performance.now();
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

  /**
   * Stop the loop and make the current state durable. Also used to retry
   * persistence after a failed checkpoint: pausing a paused runner that still has
   * uncommitted ticks writes them.
   */
  pause(actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      this.assertNotDisposed();
      const wasRunning = this.status === 'running';
      if (wasRunning) {
        this.status = 'paused';
        this.stopLoop();
        this.notify({ type: 'status' });
      }
      if (this.status === 'paused' && this.hasUncommitted()) await this.checkpoint();
      if (wasRunning) {
        await this.store.audit({
          civilizationId: this.id,
          action: 'simulation.paused',
          actor,
          tick: this.simulation.tick,
          details: {},
        });
      }
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
        if (this.status !== 'paused') break;
        if (this.bufferFull()) await this.checkpoint();
        if (remaining > 0) await yieldToEventLoop();
      }
      if (this.unrecordedHalt) {
        await this.recordHalt();
        return this.summary();
      }
      await this.checkpoint();
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
      this.assertNotDisposed();
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
      this.assertNotDisposed();
      const { simulation, name, tick } = await this.store.loadSnapshot(this.id, snapshotId, {
        invariants: this.settings.invariants,
      });
      const fromTick = this.simulation.tick;
      await this.replaceWorld(simulation, {
        events: [],
        metrics: [],
        truncate: { fromSeq: simulation.state.nextEventSeq, fromTick: tick + 1 },
        audit: {
          action: 'snapshot.restored',
          actor,
          details: { snapshotId, name, fromTick, toTick: tick, stateHash: simulation.hash() },
        },
      });
      return this.summary();
    });
  }

  /** Regenerate the world from the same seed and configuration. Destructive. */
  reset(actor: string): Promise<RunnerSummary> {
    return this.queue.run(async () => {
      this.assertNotDisposed();
      const { seed, config } = this.simulation.state;
      const { simulation, genesis } = Simulation.create(seed, config, {
        invariants: this.settings.invariants,
      });
      const fromTick = this.simulation.tick;
      await this.replaceWorld(simulation, {
        events: genesis.events,
        metrics: genesis.metrics ? [genesis.metrics] : [],
        truncate: { fromSeq: 1, fromTick: 0 },
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
      if (this.disposed) return;
      this.stopLoop();
      if (this.unrecordedHalt) {
        await this.recordHalt();
      } else if (this.status !== 'halted' && this.hasUncommitted()) {
        await this.checkpoint().catch((err: unknown) =>
          this.log.error({ err }, 'Final checkpoint failed'),
        );
      }
      while (this.flushing) await this.flushing.catch(() => undefined);
      this.disposed = true;
      this.listeners.clear();
    });
  }

  /**
   * Delete the civilization (serialised with every other control operation). On
   * success the runner is disposed and subscribers receive `deleted`.
   */
  destroy(actor: string, details: Prisma.InputJsonValue): Promise<void> {
    return this.queue.run(async () => {
      this.assertNotDisposed();
      const wasLooping = this.looping;
      this.stopLoop();
      while (this.flushing) await this.flushing.catch(() => undefined);
      try {
        await this.store.deleteCivilization(this.id, actor, details);
      } catch (err) {
        if (wasLooping && this.status === 'running') this.startLoop();
        throw err;
      }
      this.disposed = true;
      this.pendingEvents = [];
      this.pendingMetrics = [];
      this.notify({ type: 'deleted' });
      this.listeners.clear();
    });
  }

  // ---------------------------------------------------------------- internals

  private assertNotDisposed(): void {
    if (this.disposed) throw new AppError('NOT_FOUND', 'Civilization not found');
  }

  private assertUsable(): void {
    this.assertNotDisposed();
    if (this.status === 'halted') {
      throw new AppError(
        'HALTED',
        `Simulation halted: ${this.haltReason ?? 'invariant violation'}. Restore a snapshot or reset.`,
      );
    }
  }

  private hasUncommitted(): boolean {
    return this.pendingEvents.length > 0 || this.simulation.tick !== this.durableTick;
  }

  private bufferFull(): boolean {
    return (
      this.pendingEvents.length >= this.settings.maxBufferedEvents ||
      this.pendingMetrics.length >= MAX_BUFFERED_METRICS
    );
  }

  private startLoop(): void {
    this.stopLoop();
    this.looping = true;
    this.tickDebt = 0;
    this.lastSliceAt = performance.now();
    // The state is durable (or retried) when the loop starts; the interval counts from here.
    this.lastFlushAt = this.lastSliceAt;
    this.schedule(0);
  }

  private stopLoop(): void {
    this.looping = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.slice().catch((err: unknown) => {
        // Defensive: slice() handles its own failures; never let one crash the process.
        this.log.error({ err }, 'Runner loop failed');
        this.stopLoop();
        this.status = this.status === 'running' ? 'paused' : this.status;
        this.lastError = `Runner loop failed: ${message(err)}`;
        this.notify({ type: 'status' });
      });
    }, delayMs);
  }

  /** One slice of the background loop. */
  private async slice(): Promise<void> {
    if (!this.looping || this.status !== 'running' || this.disposed) return;
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
    if (this.unrecordedHalt) {
      void this.queue.run(() => this.recordHalt());
      return;
    }
    if (!this.looping) return;

    if (this.bufferFull()) {
      // Backpressure: no further ticks until the buffer is durable.
      await this.checkpoint().catch(() => undefined);
    } else if (
      !this.flushing &&
      performance.now() - this.lastFlushAt >= this.settings.checkpointIntervalMs
    ) {
      void this.checkpoint().catch(() => undefined);
    }
    if (!this.looping || this.status !== 'running' || this.timer || this.disposed) return;
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
        // Any engine exception leaves the in-memory state unusable; treat it as a halt.
        this.halt(haltRecord(err, this.simulation.tick));
        break;
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
   * The engine failed (an invariant violation, or an unexpected exception): the
   * in-memory state is impossible or unknown. Stop and drop the
   * uncommitted buffers (they cannot be committed without a consistent state).
   * The halt is recorded and the last durable checkpoint reloaded by recordHalt(),
   * which runs on the control queue.
   */
  private halt(record: HaltRecord): void {
    this.stopLoop();
    this.status = 'halted';
    this.haltReason = record.reason;
    this.unrecordedHalt = record;
    this.pendingEvents = [];
    this.pendingMetrics = [];
    this.log.error({ tick: record.tick, details: record.details }, 'Simulation halted');
    this.notify({ type: 'status' });
  }

  /** Persist a pending halt and reload the last durable state. Runs on the control queue. */
  private async recordHalt(): Promise<void> {
    const record = this.unrecordedHalt;
    if (!record || this.disposed) return;
    try {
      while (this.flushing) await this.flushing.catch(() => undefined);
      await this.store.recordHalt({ civilizationId: this.id, ...record });
      this.unrecordedHalt = null;
      const { simulation } = await this.store.loadCheckpoint(this.id, {
        invariants: this.settings.invariants,
      });
      this.simulation = simulation;
      this.durableTick = simulation.tick;
      this.projection.prime(simulation.state);
      this.notify({ type: 'reset', tick: simulation.tick });
    } catch (persistErr) {
      this.lastError = `Failed to record halt: ${message(persistErr)}`;
      this.log.error({ err: persistErr }, 'Failed to record halt');
      this.notify({ type: 'status' });
    }
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
      // Keep everything in memory (older buffers first); the next checkpoint retries
      // with a full projection rebuild.
      this.pendingEvents = events.concat(this.pendingEvents);
      this.pendingMetrics = metrics.concat(this.pendingMetrics);
      this.projection.invalidate();
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
      truncate: { fromSeq: number; fromTick: number };
      audit: { action: string; actor: string; details: Prisma.InputJsonValue };
    },
  ): Promise<void> {
    const wasLooping = this.looping;
    this.stopLoop();
    while (this.flushing) await this.flushing.catch(() => undefined);
    const encoded = captureState(next.state);
    const projection = new ProjectionTracker().delta(next.state, true);
    try {
      await this.store.rewind({
        civilizationId: this.id,
        encoded,
        projection,
        events: change.events,
        metrics: change.metrics,
        truncate: change.truncate,
        audit: change.audit,
      });
    } catch (err) {
      // Nothing changed in the database; carry on with the current world.
      if (wasLooping && this.status === 'running') this.startLoop();
      throw err;
    }
    this.simulation = next;
    this.pendingEvents = [];
    this.pendingMetrics = [];
    this.unrecordedHalt = null;
    this.projection.prime(next.state);
    this.durableTick = next.tick;
    this.status = 'paused';
    this.haltReason = null;
    this.lastError = null;
    this.notify({ type: 'reset', tick: next.tick });
    this.notify({ type: 'status' });
  }
}
