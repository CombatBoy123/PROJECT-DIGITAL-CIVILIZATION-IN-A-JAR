import { CivilizationIdSchema } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import type { CivilizationStore } from '../persistence/store.js';
import type { RunnerManager } from '../runner/manager.js';

/** Everything route handlers need, passed explicitly to each route module. */
export interface AppContext {
  env: Env;
  prisma: PrismaClient;
  store: CivilizationStore;
  runners: RunnerManager;
}

/** Positive 32-bit integer path segment (entity ids). */
const entityId = z.coerce.number().int().min(1).max(2_147_483_647);

export const CitizenParamsSchema = z.strictObject({
  id: CivilizationIdSchema,
  citizenId: entityId,
});

export const BuildingParamsSchema = z.strictObject({
  id: CivilizationIdSchema,
  buildingId: entityId,
});

export const SnapshotParamsSchema = z.strictObject({
  id: CivilizationIdSchema,
  snapshotId: z.uuid(),
});
