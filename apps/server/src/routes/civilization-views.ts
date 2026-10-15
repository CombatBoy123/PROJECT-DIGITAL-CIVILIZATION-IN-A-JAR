import { calendarAt } from '@civ/sim-core';
import type { CivilizationDetail, CivilizationSummary } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import {
  countPopulations,
  findCivilization,
  listCivilizations,
  type CivilizationRecord,
} from '../persistence/civilization-queries.js';
import { statusFromDb } from '../persistence/mappers.js';
import type { RunnerManager } from '../runner/manager.js';

/*
 * Civilization DTOs combine the stored row (durable facts) with the loaded runner,
 * when there is one (live status, in-memory tick, last persistence error).
 */

function toSummary(
  record: CivilizationRecord,
  runners: RunnerManager,
  storedPopulation: number,
): CivilizationSummary {
  const { row, config } = record;
  const runner = runners.peek(row.id);
  const live = runner?.summary();
  return {
    id: row.id,
    name: row.name,
    seed: row.seed,
    status: live?.status ?? statusFromDb(row.status),
    speed: live?.speed ?? row.speed,
    durableTick: live?.durableTick ?? row.currentTick,
    tick: live?.tick ?? row.currentTick,
    calendar: live?.calendar ?? calendarAt(row.currentTick, config),
    population: runner ? runner.sim.state.citizens.length : storedPopulation,
    engineVersion: row.engineVersion,
    haltReason: live ? live.haltReason : row.haltReason,
    lastError: live?.lastError ?? null,
    loaded: runner !== undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(
  record: CivilizationRecord,
  runners: RunnerManager,
  storedPopulation: number,
): CivilizationDetail {
  return {
    ...toSummary(record, runners, storedPopulation),
    config: record.config,
    configSchemaVersion: record.configSchemaVersion,
  };
}

export async function civilizationSummaries(
  prisma: PrismaClient,
  runners: RunnerManager,
): Promise<CivilizationSummary[]> {
  const records = await listCivilizations(prisma);
  const populations = await countPopulations(
    prisma,
    records.map((r) => r.row.id),
  );
  return records.map((r) => toSummary(r, runners, populations.get(r.row.id) ?? 0));
}

async function storedPopulation(prisma: PrismaClient, id: string): Promise<number> {
  return (await countPopulations(prisma, [id])).get(id) ?? 0;
}

export async function civilizationSummary(
  prisma: PrismaClient,
  runners: RunnerManager,
  id: string,
): Promise<CivilizationSummary> {
  const record = await findCivilization(prisma, id);
  return toSummary(record, runners, await storedPopulation(prisma, id));
}

export async function civilizationDetail(
  prisma: PrismaClient,
  runners: RunnerManager,
  id: string,
): Promise<CivilizationDetail> {
  const record = await findCivilization(prisma, id);
  return toDetail(record, runners, await storedPopulation(prisma, id));
}
