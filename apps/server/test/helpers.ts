import { Writable } from 'node:stream';
import { Simulation, type SimulationConfigInput } from '@civ/sim-core';
import type { CivilizationDetail, CivilizationSummary } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { createPrismaClient } from '../src/db/prisma.js';
import { testDatabaseUrl } from './database-url.js';

/** Small worlds keep the integration tests fast; one season per simulated day. */
export const SMALL_CONFIG: SimulationConfigInput = { population: 20, daysPerSeason: 1 };

/** Every table, children first (TRUNCATE … CASCADE would also cope). */
const TABLES = [
  'audit_log',
  'event_entity',
  'simulation_event',
  'metric_sample',
  'citizen_skill',
  'citizen',
  'household',
  'building',
  'snapshot',
  'world_checkpoint',
  'simulation_config',
  'civilization',
];

export function createTestPrisma(): PrismaClient {
  return createPrismaClient(testDatabaseUrl());
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    DATABASE_URL: testDatabaseUrl(),
    HOST: '127.0.0.1',
    PORT: '0',
    AUTH_MODE: 'disabled',
    CHECKPOINT_INTERVAL_MS: '200',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function startApp(
  prisma: PrismaClient,
  envOverrides: Record<string, string> = {},
  options: Partial<BuildAppOptions> = {},
): Promise<FastifyInstance> {
  return buildApp({ env: testEnv(envOverrides), prisma, logger: false, ...options });
}

/** Collects JSON log lines written by the app's logger. */
export class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    done();
  }
}

export function json<T>(response: LightMyRequestResponse): T {
  return response.json<T>();
}

export async function createCivilization(
  app: FastifyInstance,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<CivilizationDetail> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/civilizations',
    headers,
    payload: { name: 'Testville', seed: 'test-seed', config: SMALL_CONFIG, ...body },
  });
  if (response.statusCode !== 201) throw new Error(`create failed: ${response.body}`);
  return json<CivilizationDetail>(response);
}

export async function control(
  app: FastifyInstance,
  id: string,
  payload: Record<string, unknown>,
): Promise<CivilizationSummary> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/civilizations/${id}/control`,
    payload,
  });
  if (response.statusCode !== 200) throw new Error(`control failed: ${response.body}`);
  return json<CivilizationSummary>(response);
}

/** Hash of the pure engine after `ticks` steps from genesis. */
export function pureHash(seed: string, config: SimulationConfigInput, ticks: number): string {
  const { simulation } = Simulation.create(seed, config);
  for (let i = 0; i < ticks; i++) simulation.step();
  return simulation.hash();
}

export async function checkpointOf(prisma: PrismaClient, id: string) {
  const row = await prisma.worldCheckpoint.findUniqueOrThrow({
    where: { civilizationId: id },
    select: { tick: true, stateHash: true, nextEventSeq: true },
  });
  return { tick: row.tick, stateHash: row.stateHash, nextEventSeq: Number(row.nextEventSeq) };
}

export async function eventSeqs(prisma: PrismaClient, id: string): Promise<number[]> {
  const rows = await prisma.simulationEvent.findMany({
    where: { civilizationId: id },
    select: { seq: true },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => Number(r.seq));
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

export async function waitFor<T>(
  probe: () => T | Promise<T>,
  { timeoutMs = 10_000, intervalMs = 20 } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
