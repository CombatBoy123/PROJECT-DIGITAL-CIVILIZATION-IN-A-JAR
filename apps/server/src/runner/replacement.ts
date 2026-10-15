import {
  Simulation,
  type DeepReadonly,
  type InvariantMode,
  type MetricSample,
  type SimEvent,
  type SimulationConfig,
} from '@civ/sim-core';
import type { Prisma } from '@prisma/client';
import { captureState } from '../persistence/codec.js';
import { ProjectionTracker } from '../persistence/projections.js';
import type { CivilizationStore, HaltInput, RewindWrite } from '../persistence/store.js';

/*
 * World replacements (reset and snapshot restore). They are built without the current
 * in-memory world, so the same code serves a loaded runner and a civilization whose
 * stored state cannot be loaded (RunnerManager recovery).
 */

/** A world that replaces the current timeline, with the history and audit entry to write. */
export interface WorldReplacement {
  simulation: Simulation;
  /** Records of the replacement timeline to insert (genesis on reset). */
  events: readonly SimEvent[];
  metrics: readonly MetricSample[];
  truncate: RewindWrite['truncate'];
  audit: { action: string; actor: string; details: Prisma.InputJsonObject };
}

/** Regenerate genesis from the civilization's seed and configuration. */
export function resetReplacement(
  seed: string,
  config: DeepReadonly<SimulationConfig>,
  invariants: InvariantMode,
  actor: string,
  details: Prisma.InputJsonObject,
): WorldReplacement {
  const { simulation, genesis } = Simulation.create(seed, config, { invariants });
  return {
    simulation,
    events: genesis.events,
    metrics: genesis.metrics ? [genesis.metrics] : [],
    truncate: { fromSeq: 1, fromTick: 0 },
    audit: {
      action: 'simulation.reset',
      actor,
      details: { ...details, stateHash: simulation.hash() },
    },
  };
}

/** Load a (verified) snapshot of the current timeline as the replacement world. */
export async function restoreReplacement(
  store: Pick<CivilizationStore, 'loadSnapshot'>,
  civilizationId: string,
  snapshotId: string,
  invariants: InvariantMode,
  actor: string,
  details: Prisma.InputJsonObject,
): Promise<WorldReplacement> {
  const { simulation, name, tick } = await store.loadSnapshot(civilizationId, snapshotId, {
    invariants,
  });
  return {
    simulation,
    events: [],
    metrics: [],
    truncate: { fromSeq: simulation.state.nextEventSeq, fromTick: tick + 1 },
    audit: {
      action: 'snapshot.restored',
      actor,
      details: { snapshotId, name, ...details, toTick: tick, stateHash: simulation.hash() },
    },
  };
}

/** The database write of a replacement: state blob, full projection rebuild and history. */
export function rewindWrite(
  civilizationId: string,
  replacement: WorldReplacement,
  halt: HaltInput | null,
): RewindWrite {
  const { simulation } = replacement;
  return {
    civilizationId,
    encoded: captureState(simulation.state),
    projection: new ProjectionTracker().delta(simulation.state, true),
    events: replacement.events,
    metrics: replacement.metrics,
    truncate: replacement.truncate,
    audit: replacement.audit,
    halt,
  };
}
