import {
  CONFIG_SCHEMA_VERSION,
  ENGINE_VERSION,
  STATE_SCHEMA_VERSION,
  type MetricSample,
  type SimEvent,
  type SimulationConfig,
  type SimulationOptions,
  type Simulation,
} from '@civ/sim-core';
import type { CivilizationStatus } from '@civ/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError, conflict, notFound } from '../http/errors.js';
import { compress, decodeSimulation, type EncodedState } from './codec.js';
import { entityKindToDb, statusToDb } from './mappers.js';
import { writeProjection, type ProjectionDelta } from './projections.js';
import type { Tx } from './sql.js';

/** Interactive transaction limits for large writes (genesis of thousands of citizens, rewinds). */
const TX_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;
const INSERT_CHUNK = 5000;

export interface CheckpointWrite {
  civilizationId: string;
  encoded: EncodedState;
  events: readonly SimEvent[];
  metrics: readonly MetricSample[];
  projection: ProjectionDelta;
  status: CivilizationStatus;
}

export interface RewindWrite {
  civilizationId: string;
  encoded: EncodedState;
  projection: ProjectionDelta;
  /**
   * History of the abandoned timeline to remove: events with `seq >= fromSeq` and
   * metric samples with `tick >= fromTick`. A restore keeps everything the restored
   * state already contains (`fromSeq = nextEventSeq`, `fromTick = tick + 1`); a reset
   * removes everything (`1`, `0`) and re-inserts the regenerated genesis records.
   */
  truncate: { fromSeq: number; fromTick: number };
  /** Events and metrics of the replacement timeline to insert (e.g. genesis on reset). */
  events: readonly SimEvent[];
  metrics: readonly MetricSample[];
  audit: { action: string; actor: string; details: Prisma.InputJsonValue };
}

/**
 * A rewind must leave exactly the history that leads to the new state: everything
 * kept or inserted lies before the state's next event seq / at or before its tick.
 */
function assertRewindConsistent(input: RewindWrite): void {
  const { encoded, truncate, events, metrics } = input;
  const ok =
    truncate.fromSeq >= 1 &&
    truncate.fromSeq <= encoded.nextEventSeq &&
    truncate.fromTick >= 0 &&
    truncate.fromTick <= encoded.tick + 1 &&
    events.every((e) => e.seq >= truncate.fromSeq && e.seq < encoded.nextEventSeq) &&
    metrics.every((m) => m.tick >= truncate.fromTick && m.tick <= encoded.tick);
  if (!ok) throw new Error('rewind: replacement history is inconsistent with the target state');
}

export interface AuditInput {
  civilizationId: string | null;
  action: string;
  actor: string;
  tick: number | null;
  details: Prisma.InputJsonValue;
}

function chunks<T>(items: readonly T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * All database writes for civilizations. Every multi-row change that must stay
 * consistent (checkpoint, genesis, rewind) happens inside a single transaction.
 */
export class CivilizationStore {
  constructor(readonly prisma: PrismaClient) {}

  private async insertEvents(
    tx: Tx,
    civilizationId: string,
    events: readonly SimEvent[],
  ): Promise<void> {
    for (const part of chunks(events)) {
      await tx.simulationEvent.createMany({
        data: part.map((e) => ({
          civilizationId,
          seq: BigInt(e.seq),
          tick: e.tick,
          type: e.type,
          causeSeq: e.causeSeq === null ? null : BigInt(e.causeSeq),
          payload: e.payload as unknown as Prisma.InputJsonValue,
        })),
      });
    }
    const refs = events.flatMap((e) =>
      e.refs.map((r) => ({
        civilizationId,
        eventSeq: BigInt(e.seq),
        entityKind: entityKindToDb(r.kind),
        entityId: r.id,
        role: r.role,
      })),
    );
    for (const part of chunks(refs)) await tx.eventEntity.createMany({ data: part });
  }

  private async insertMetrics(
    tx: Tx,
    civilizationId: string,
    metrics: readonly MetricSample[],
  ): Promise<void> {
    for (const part of chunks(metrics)) {
      await tx.metricSample.createMany({
        data: part.map((m) => ({
          civilizationId,
          tick: m.tick,
          values: m.values as unknown as Prisma.InputJsonValue,
        })),
      });
    }
  }

  private async upsertCheckpoint(
    tx: Tx,
    civilizationId: string,
    encoded: EncodedState,
    gz: Buffer,
  ): Promise<void> {
    const data = {
      tick: encoded.tick,
      nextEventSeq: BigInt(encoded.nextEventSeq),
      stateHash: encoded.hash,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      state: new Uint8Array(gz),
      sizeBytes: encoded.sizeBytes,
    };
    await tx.worldCheckpoint.upsert({
      where: { civilizationId },
      create: { civilizationId, ...data },
      update: data,
    });
  }

  async audit(input: AuditInput, tx: Tx | PrismaClient = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        civilizationId: input.civilizationId,
        action: input.action,
        actor: input.actor,
        tick: input.tick,
        details: input.details,
      },
    });
  }

  /** Persist a new civilization with its genesis state, events and first metric sample. */
  async createCivilization(input: {
    name: string;
    seed: string;
    config: SimulationConfig;
    speed: number;
    actor: string;
    encoded: EncodedState;
    events: readonly SimEvent[];
    metrics: readonly MetricSample[];
    projection: ProjectionDelta;
  }): Promise<string> {
    const gz = await compress(input.encoded.json);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const civ = await tx.civilization.create({
          data: {
            name: input.name,
            seed: input.seed,
            speed: input.speed,
            status: 'PAUSED',
            currentTick: input.encoded.tick,
            engineVersion: ENGINE_VERSION,
            config: {
              create: {
                schemaVersion: CONFIG_SCHEMA_VERSION,
                params: input.config as unknown as Prisma.InputJsonValue,
              },
            },
          },
        });
        await this.insertEvents(tx, civ.id, input.events);
        await this.insertMetrics(tx, civ.id, input.metrics);
        await writeProjection(tx, civ.id, input.encoded.tick, input.projection);
        await this.upsertCheckpoint(tx, civ.id, input.encoded, gz);
        await this.audit(
          {
            civilizationId: civ.id,
            action: 'civilization.created',
            actor: input.actor,
            tick: 0,
            details: {
              name: input.name,
              seed: input.seed,
              population: input.config.population,
              stateHash: input.encoded.hash,
            },
          },
          tx,
        );
        return civ.id;
      }, TX_OPTIONS);
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict(`A civilization named "${input.name}" already exists`);
      throw err;
    }
  }

  /** Atomic checkpoint: events, metrics, projection, state blob and status in one transaction. */
  async writeCheckpoint(input: CheckpointWrite): Promise<void> {
    const gz = await compress(input.encoded.json);
    await this.prisma.$transaction(async (tx) => {
      await this.insertEvents(tx, input.civilizationId, input.events);
      await this.insertMetrics(tx, input.civilizationId, input.metrics);
      await writeProjection(tx, input.civilizationId, input.encoded.tick, input.projection);
      await this.upsertCheckpoint(tx, input.civilizationId, input.encoded, gz);
      await tx.civilization.update({
        where: { id: input.civilizationId },
        data: { currentTick: input.encoded.tick, status: statusToDb(input.status) },
      });
    }, TX_OPTIONS);
  }

  /** Load the latest durable state of a civilization (hash-verified, invariant-checked). */
  async loadCheckpoint(civilizationId: string, options: SimulationOptions) {
    const civ = await this.prisma.civilization.findUnique({
      where: { id: civilizationId },
      include: { checkpoint: true },
    });
    if (!civ) throw notFound('Civilization');
    if (!civ.checkpoint) throw new AppError('INTERNAL', 'Civilization has no checkpoint');
    if (civ.checkpoint.stateSchemaVersion !== STATE_SCHEMA_VERSION) {
      throw new AppError(
        'CONFLICT',
        `Checkpoint uses state schema ${civ.checkpoint.stateSchemaVersion}; this server reads ${STATE_SCHEMA_VERSION}`,
      );
    }
    const simulation = await decodeSimulation(
      civ.checkpoint.state,
      civ.checkpoint.stateHash,
      options,
    );
    return { civ, simulation };
  }

  /**
   * Replace the current timeline with another state (snapshot restore or reset):
   * removes the abandoned history (see RewindWrite.truncate), inserts the
   * replacement records, detaches snapshots that lie in the abandoned future,
   * rebuilds projections and the checkpoint, and clears any halt.
   */
  async rewind(input: RewindWrite): Promise<void> {
    assertRewindConsistent(input);
    const gz = await compress(input.encoded.json);
    const { civilizationId, encoded, truncate } = input;
    await this.prisma.$transaction(async (tx) => {
      // event_entity rows cascade with their events.
      await tx.simulationEvent.deleteMany({
        where: { civilizationId, seq: { gte: BigInt(truncate.fromSeq) } },
      });
      await tx.metricSample.deleteMany({
        where: { civilizationId, tick: { gte: truncate.fromTick } },
      });
      await this.insertEvents(tx, civilizationId, input.events);
      await this.insertMetrics(tx, civilizationId, input.metrics);
      await tx.snapshot.updateMany({
        where: { civilizationId, tick: { gt: encoded.tick }, detachedAt: null },
        data: { detachedAt: new Date() },
      });
      await writeProjection(tx, civilizationId, encoded.tick, input.projection);
      await this.upsertCheckpoint(tx, civilizationId, encoded, gz);
      await tx.civilization.update({
        where: { id: civilizationId },
        data: { currentTick: encoded.tick, status: 'PAUSED', haltReason: null },
      });
      await this.audit(
        {
          civilizationId,
          action: input.audit.action,
          actor: input.audit.actor,
          tick: encoded.tick,
          details: input.audit.details,
        },
        tx,
      );
    }, TX_OPTIONS);
  }

  /** Record an invariant halt: status, reason and audit entry in one transaction. */
  async recordHalt(input: {
    civilizationId: string;
    reason: string;
    tick: number;
    details: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.civilization.update({
        where: { id: input.civilizationId },
        data: { status: 'HALTED', haltReason: input.reason },
      });
      await this.audit(
        {
          civilizationId: input.civilizationId,
          action: 'simulation.halted',
          actor: 'engine',
          tick: input.tick,
          details: input.details,
        },
        tx,
      );
    });
  }

  async createSnapshot(
    civilizationId: string,
    name: string,
    note: string | null,
    encoded: EncodedState,
    actor: string,
  ) {
    const gz = await compress(encoded.json);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const snapshot = await tx.snapshot.create({
          data: {
            civilizationId,
            name,
            note,
            tick: encoded.tick,
            nextEventSeq: BigInt(encoded.nextEventSeq),
            stateHash: encoded.hash,
            stateSchemaVersion: STATE_SCHEMA_VERSION,
            state: new Uint8Array(gz),
            sizeBytes: encoded.sizeBytes,
          },
          omit: { state: true },
        });
        await this.audit(
          {
            civilizationId,
            action: 'snapshot.created',
            actor,
            tick: encoded.tick,
            details: { snapshotId: snapshot.id, name, stateHash: encoded.hash },
          },
          tx,
        );
        return snapshot;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A snapshot named "${name}" already exists`);
      throw err;
    }
  }

  async loadSnapshot(
    civilizationId: string,
    snapshotId: string,
    options: SimulationOptions,
  ): Promise<{ simulation: Simulation; name: string; tick: number }> {
    const snapshot = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, civilizationId },
    });
    if (!snapshot) throw notFound('Snapshot');
    if (snapshot.detachedAt) {
      throw conflict(
        'This snapshot belongs to an abandoned timeline (the civilization was rewound before it) and cannot be restored in place',
      );
    }
    if (snapshot.stateSchemaVersion !== STATE_SCHEMA_VERSION) {
      throw conflict(
        `Snapshot uses state schema ${snapshot.stateSchemaVersion}; this server reads ${STATE_SCHEMA_VERSION}`,
      );
    }
    const simulation = await decodeSimulation(snapshot.state, snapshot.stateHash, options);
    return { simulation, name: snapshot.name, tick: snapshot.tick };
  }

  async updateRuntime(
    civilizationId: string,
    data: { status?: CivilizationStatus; speed?: number; haltReason?: string | null },
  ): Promise<void> {
    await this.prisma.civilization.update({
      where: { id: civilizationId },
      data: {
        ...(data.status ? { status: statusToDb(data.status) } : {}),
        ...(data.speed !== undefined ? { speed: data.speed } : {}),
        ...(data.haltReason !== undefined ? { haltReason: data.haltReason } : {}),
      },
    });
  }

  async deleteCivilization(
    civilizationId: string,
    actor: string,
    details: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.audit(
          { civilizationId: null, action: 'civilization.deleted', actor, tick: null, details },
          tx,
        );
        // Snapshots, projections, events, metrics and the checkpoint cascade.
        await tx.civilization.delete({ where: { id: civilizationId } });
      }, TX_OPTIONS);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')
        throw notFound('Civilization');
      throw err;
    }
  }

  /**
   * Civilizations stored as RUNNING when the server starts were interrupted by a
   * restart or crash (their uncommitted ticks are lost and will be re-simulated
   * identically). Returns their ids and durable ticks.
   */
  async listInterrupted(): Promise<{ id: string; tick: number }[]> {
    const rows = await this.prisma.civilization.findMany({
      where: { status: 'RUNNING' },
      select: { id: true, currentTick: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.id, tick: r.currentTick }));
  }

  /** Mark an interrupted civilization as paused, with an audit entry explaining why. */
  async pauseInterrupted(civilizationId: string, tick: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.civilization.update({
        where: { id: civilizationId },
        data: { status: 'PAUSED' },
      });
      await this.audit(
        {
          civilizationId,
          action: 'simulation.paused_on_restart',
          actor: 'system',
          tick,
          details: {
            reason: 'The server restarted while the simulation was running',
            resumedFromTick: tick,
          },
        },
        tx,
      );
    });
  }
}
