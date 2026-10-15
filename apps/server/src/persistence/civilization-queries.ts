import { SimulationConfigSchema, type SimulationConfig } from '@civ/sim-core';
import type { Civilization, PrismaClient } from '@prisma/client';
import { AppError, notFound } from '../http/errors.js';

/** A civilization row with its validated configuration. */
export interface CivilizationRecord {
  row: Civilization;
  config: SimulationConfig;
  configSchemaVersion: number;
}

/** Upper bound for the (unpaginated) civilization list. */
export const MAX_LISTED_CIVILIZATIONS = 1000;

/** Stored configurations are re-validated before use, like state blobs. */
export function readConfig(params: unknown, civilizationId: string): SimulationConfig {
  const parsed = SimulationConfigSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError('INTERNAL', `Stored configuration of ${civilizationId} is invalid`);
  }
  return parsed.data;
}

export async function findCivilization(
  prisma: PrismaClient,
  id: string,
): Promise<CivilizationRecord> {
  const row = await prisma.civilization.findUnique({ where: { id }, include: { config: true } });
  if (!row) throw notFound('Civilization');
  if (!row.config) throw new AppError('INTERNAL', `Civilization ${id} has no configuration`);
  const { config, ...civ } = row;
  return {
    row: civ,
    config: readConfig(config.params, id),
    configSchemaVersion: config.schemaVersion,
  };
}

/** Newest first. */
export async function listCivilizations(prisma: PrismaClient): Promise<CivilizationRecord[]> {
  const rows = await prisma.civilization.findMany({
    include: { config: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: MAX_LISTED_CIVILIZATIONS,
  });
  return rows.flatMap(({ config, ...row }) =>
    config
      ? [
          {
            row,
            config: readConfig(config.params, row.id),
            configSchemaVersion: config.schemaVersion,
          },
        ]
      : [],
  );
}

/** Citizen counts from the projection (as of each civilization's durable tick). */
export async function countPopulations(
  prisma: PrismaClient,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const groups = await prisma.citizen.groupBy({
    by: ['civilizationId'],
    where: { civilizationId: { in: [...ids] } },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.civilizationId, g._count._all]));
}

/** Throws NOT_FOUND unless the civilization exists. */
export async function assertCivilizationExists(prisma: PrismaClient, id: string): Promise<void> {
  const row = await prisma.civilization.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw notFound('Civilization');
}
