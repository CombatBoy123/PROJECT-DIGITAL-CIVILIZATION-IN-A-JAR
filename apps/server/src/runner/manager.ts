import type { Simulation } from '@civ/sim-core';
import type { CivilizationStatus } from '@civ/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../http/errors.js';
import { statusFromDb } from '../persistence/mappers.js';
import type { CivilizationStore } from '../persistence/store.js';
import { SimulationRunner, type RunnerSettings } from './runner.js';

export interface RunnerManagerOptions {
  store: CivilizationStore;
  settings: RunnerSettings;
  log: FastifyBaseLogger;
  /**
   * Unload runners that are paused or halted, fully durable, have no stream
   * subscribers and were not used for this long. 0 disables eviction.
   */
  idleEvictMs?: number;
}

/** Default idle time after which a paused runner is unloaded. */
export const DEFAULT_IDLE_EVICT_MS = 15 * 60_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the loaded civilizations of this server process. A civilization is loaded
 * lazily from its latest checkpoint the first time it is needed (single-flight:
 * concurrent requests share one load), and stays loaded while it runs, while
 * clients are streaming it, or until it has been idle for a while.
 */
export class RunnerManager {
  private readonly loaded = new Map<string, SimulationRunner>();
  private readonly loading = new Map<string, Promise<SimulationRunner>>();
  private readonly store: CivilizationStore;
  private readonly settings: RunnerSettings;
  private readonly log: FastifyBaseLogger;
  private readonly idleEvictMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(options: RunnerManagerOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.log = options.log;
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
    if (this.idleEvictMs > 0) {
      this.sweepTimer = setInterval(() => this.evictIdle(), Math.min(this.idleEvictMs, 60_000));
      this.sweepTimer.unref();
    }
  }

  /** The runner of a civilization, loading it if necessary. Throws NOT_FOUND for unknown ids. */
  async get(id: string): Promise<SimulationRunner> {
    if (this.closing) throw new AppError('INTERNAL', 'The server is shutting down');
    const ready = this.loaded.get(id);
    if (ready) {
      ready.touch();
      return ready;
    }
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    const runner = await pending;
    runner.touch();
    return runner;
  }

  /** The runner if it is already loaded (never triggers a load). */
  peek(id: string): SimulationRunner | undefined {
    return this.loaded.get(id);
  }

  /** Register a runner for a simulation that was just created and persisted (genesis). */
  adopt(id: string, simulation: Simulation, speed: number): SimulationRunner {
    const runner = this.createRunner(id, simulation, 'paused', speed, null);
    this.loaded.set(id, runner);
    return runner;
  }

  /**
   * Delete a civilization. A loaded runner deletes it on its control queue (so the
   * deletion cannot interleave with a step or checkpoint); a civilization whose
   * stored state cannot be loaded is deleted directly.
   */
  async delete(id: string, actor: string, details: Prisma.InputJsonValue): Promise<void> {
    let runner: SimulationRunner | undefined;
    try {
      runner = await this.get(id);
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') throw err;
      if (this.closing) throw err;
      this.log.warn({ err, civilizationId: id }, 'Deleting a civilization that cannot be loaded');
    }
    if (runner) await runner.destroy(actor, details);
    else await this.store.deleteCivilization(id, actor, details);
    if (this.loaded.get(id) === runner) this.loaded.delete(id);
  }

  /**
   * Startup recovery. Civilizations stored as RUNNING were interrupted by a restart:
   * with `resume`, load and continue them from their last checkpoint; otherwise mark
   * them paused with an audit entry.
   */
  async recoverInterrupted(resume: boolean): Promise<void> {
    for (const { id, tick } of await this.store.listInterrupted()) {
      if (resume) {
        try {
          await this.get(id);
          await this.store.audit({
            civilizationId: id,
            action: 'simulation.resumed_on_restart',
            actor: 'system',
            tick,
            details: { resumedFromTick: tick },
          });
          this.log.info({ civilizationId: id, tick }, 'Resumed interrupted civilization');
          continue;
        } catch (err) {
          this.log.error({ err, civilizationId: id }, 'Could not resume civilization; pausing it');
        }
      }
      await this.store.pauseInterrupted(id, tick);
      this.log.info({ civilizationId: id, tick }, 'Paused civilization interrupted by restart');
    }
  }

  /** Final checkpoints for every loaded civilization; no new loads afterwards. */
  async shutdown(): Promise<void> {
    this.closing = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await Promise.allSettled([...this.loading.values()]);
    const runners = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.allSettled(runners.map((r) => r.shutdown()));
  }

  private async load(id: string): Promise<SimulationRunner> {
    let loadedState: Awaited<ReturnType<CivilizationStore['loadCheckpoint']>>;
    try {
      loadedState = await this.store.loadCheckpoint(id, { invariants: this.settings.invariants });
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Corrupt blob, hash mismatch or a stored state that violates invariants.
      this.log.error({ err, civilizationId: id }, 'Failed to load civilization state');
      throw new AppError('INTERNAL', `The stored state could not be loaded: ${message(err)}`);
    }
    const { civ, simulation } = loadedState;
    if (this.closing) throw new AppError('INTERNAL', 'The server is shutting down');
    const runner = this.createRunner(
      id,
      simulation,
      statusFromDb(civ.status),
      civ.speed,
      civ.haltReason,
    );
    this.loaded.set(id, runner);
    return runner;
  }

  private createRunner(
    id: string,
    simulation: Simulation,
    status: CivilizationStatus,
    speed: number,
    haltReason: string | null,
  ): SimulationRunner {
    return new SimulationRunner({
      id,
      simulation,
      status,
      speed,
      haltReason,
      store: this.store,
      settings: this.settings,
      log: this.log,
    });
  }

  /** Unload idle runners (they are fully durable, so this loses nothing). */
  private evictIdle(): void {
    for (const [id, runner] of this.loaded) {
      if (runner.idle && runner.subscriberCount === 0 && runner.idleForMs >= this.idleEvictMs) {
        this.loaded.delete(id);
        void runner.shutdown();
        this.log.debug({ civilizationId: id }, 'Unloaded idle civilization');
      }
    }
  }
}
