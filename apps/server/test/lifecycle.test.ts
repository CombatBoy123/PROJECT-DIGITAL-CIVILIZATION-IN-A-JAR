import { Simulation } from '@civ/sim-core';
import type { ApiErrorBody, CivilizationDetail, CivilizationSummary } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkpointOf,
  control,
  createCivilization,
  createTestPrisma,
  eventSeqs,
  json,
  pureHash,
  range,
  SMALL_CONFIG,
  startApp,
  truncateAll,
} from './helpers.js';

const SEED = 'test-seed';

let prisma: PrismaClient;
let app: FastifyInstance | null = null;

beforeAll(() => {
  prisma = createTestPrisma();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
  app = await startApp(prisma);
});
afterEach(async () => {
  await app?.close();
  app = null;
});

async function summary(id: string): Promise<CivilizationDetail> {
  return json<CivilizationDetail>(await app!.inject({ url: `/api/civilizations/${id}` }));
}

describe('creation (genesis)', () => {
  it('persists the generated world atomically', async () => {
    const civ = await createCivilization(app!);
    const { simulation, genesis } = Simulation.create(SEED, SMALL_CONFIG);

    expect(civ).toMatchObject({
      name: 'Testville',
      seed: SEED,
      status: 'paused',
      tick: 0,
      durableTick: 0,
      population: 20,
      loaded: true,
      lastError: null,
    });
    expect(civ.config.population).toBe(20);
    const checkpoint = await checkpointOf(prisma, civ.id);
    expect(checkpoint.stateHash).toBe(simulation.hash());
    expect(checkpoint.tick).toBe(0);
    expect(await eventSeqs(prisma, civ.id)).toEqual(range(1, genesis.events.length));
    expect(checkpoint.nextEventSeq).toBe(genesis.events.length + 1);
    expect(await prisma.citizen.count({ where: { civilizationId: civ.id } })).toBe(20);
    expect(await prisma.citizenSkill.count({ where: { civilizationId: civ.id } })).toBe(100);
    expect(await prisma.building.count({ where: { civilizationId: civ.id } })).toBe(
      simulation.state.buildings.length,
    );
    expect(await prisma.household.count({ where: { civilizationId: civ.id } })).toBe(
      simulation.state.households.length,
    );
    expect(await prisma.metricSample.count({ where: { civilizationId: civ.id } })).toBe(1);
    const audit = await prisma.auditLog.findMany({ where: { civilizationId: civ.id } });
    expect(audit.map((a) => a.action)).toEqual(['civilization.created']);
  });

  it('generates and records a seed when none is given', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/civilizations',
      payload: { name: 'Random', config: { population: 10 } },
    });
    expect(res.statusCode).toBe(201);
    const civ = res.json<CivilizationDetail>();
    expect(civ.seed).toMatch(/^[0-9a-f]{16}$/);
    const { simulation } = Simulation.create(civ.seed, { population: 10 });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(simulation.hash());
  });

  it('lists civilizations newest first with durable facts', async () => {
    const a = await createCivilization(app!, { name: 'Alpha' });
    const b = await createCivilization(app!, { name: 'Beta' });
    const list = json<{ items: CivilizationSummary[] }>(
      await app!.inject({ url: '/api/civilizations' }),
    );
    expect(list.items.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(list.items.every((c) => c.population === 20)).toBe(true);
  });
});

describe('stepping and running are deterministic', () => {
  it('step N via the API equals the pure engine after N ticks', async () => {
    const civ = await createCivilization(app!);
    const result = await control(app!, civ.id, { action: 'step', steps: 100 });
    expect(result).toMatchObject({ status: 'paused', tick: 100, durableTick: 100 });

    const expected = pureHash(SEED, SMALL_CONFIG, 100);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(expected);
    expect(app!.ctx.runners.peek(civ.id)?.sim.hash()).toBe(expected);

    // Events contiguous by seq, stamped with ticks in order; one metric sample per tick.
    const events = await prisma.simulationEvent.findMany({
      where: { civilizationId: civ.id },
      orderBy: { seq: 'asc' },
    });
    const checkpoint = await checkpointOf(prisma, civ.id);
    expect(events.map((e) => Number(e.seq))).toEqual(range(1, checkpoint.nextEventSeq - 1));
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.tick).toBeGreaterThanOrEqual(events[i - 1]!.tick);
    }
    expect(events.some((e) => e.type === 'SeasonStarted' && e.tick === 24)).toBe(true);
    expect(await prisma.metricSample.count({ where: { civilizationId: civ.id } })).toBe(101);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'simulation.stepped' },
    });
    expect(audit.details).toMatchObject({ requested: 100, fromTick: 0, toTick: 100 });
  });

  it('running at max speed with intermediate checkpoints, then pausing, matches the pure engine', async () => {
    await app!.close();
    // Small buffers force backpressure checkpoints while running.
    app = await startApp(prisma, { CHECKPOINT_INTERVAL_MS: '100', MAX_BUFFERED_EVENTS: '100' });
    const civ = await createCivilization(app);
    await app.inject({
      method: 'PUT',
      url: `/api/civilizations/${civ.id}/speed`,
      payload: { ticksPerSecond: 0 },
    });
    const started = await control(app, civ.id, { action: 'start' });
    expect(started.status).toBe('running');
    expect((await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } })).status).toBe(
      'RUNNING',
    );
    await new Promise((r) => setTimeout(r, 700));
    const paused = await control(app, civ.id, { action: 'pause' });
    expect(paused.status).toBe('paused');
    expect(paused.tick).toBeGreaterThan(200);
    expect(paused.durableTick).toBe(paused.tick);

    const checkpoint = await checkpointOf(prisma, civ.id);
    expect(checkpoint.tick).toBe(paused.tick);
    expect(checkpoint.stateHash).toBe(pureHash(SEED, SMALL_CONFIG, paused.tick));
    expect(await eventSeqs(prisma, civ.id)).toEqual(range(1, checkpoint.nextEventSeq - 1));
    expect(await prisma.metricSample.count({ where: { civilizationId: civ.id } })).toBe(
      paused.tick + 1,
    );
    expect(await prisma.citizen.findFirst({ where: { civilizationId: civ.id } })).not.toBeNull();
    const maxUpdated = await prisma.citizen.aggregate({
      where: { civilizationId: civ.id },
      _max: { updatedTick: true },
    });
    expect(maxUpdated._max.updatedTick).toBeLessThanOrEqual(paused.tick);
  });

  it('refuses to step while running', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'start' });
    const res = await app!.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/control`,
      payload: { action: 'step' },
    });
    expect(res.statusCode).toBe(409);
    await control(app!, civ.id, { action: 'pause' });
  });
});

describe('persistence across restarts', () => {
  it('a new server on the same database continues identically', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'step', steps: 50 });
    await app!.close();

    app = await startApp(prisma);
    const reloaded = await summary(civ.id);
    expect(reloaded).toMatchObject({ tick: 50, durableTick: 50, status: 'paused', loaded: false });
    expect(reloaded.population).toBe(20);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 50));

    const continued = await control(app!, civ.id, { action: 'step', steps: 30 });
    expect(continued.tick).toBe(80);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 80));
    expect(await eventSeqs(prisma, civ.id)).toEqual(
      range(1, (await checkpointOf(prisma, civ.id)).nextEventSeq - 1),
    );
  });

  it('shutdown writes a final checkpoint; interrupted runs are paused on restart', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'start' });
    await new Promise((r) => setTimeout(r, 300));
    const runningTick = app!.ctx.runners.peek(civ.id)!.sim.tick;
    await app!.close();

    const stored = await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.currentTick).toBeGreaterThanOrEqual(runningTick);
    const finalTick = stored.currentTick;

    app = await startApp(prisma);
    const after = await summary(civ.id);
    expect(after).toMatchObject({ status: 'paused', tick: finalTick });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'simulation.paused_on_restart' },
    });
    expect(audit.actor).toBe('system');
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(
      pureHash(SEED, SMALL_CONFIG, finalTick),
    );
  });

  it('resumes interrupted runs when RESUME_RUNNING_ON_START is set', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'start' });
    await app!.close();

    app = await startApp(prisma, { RESUME_RUNNING_ON_START: 'true' });
    const after = await summary(civ.id);
    expect(after.status).toBe('running');
    expect(after.loaded).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { civilizationId: civ.id, action: 'simulation.resumed_on_restart' },
      }),
    ).toBe(1);
    await control(app, civ.id, { action: 'pause' });
  });
});

describe('reset and delete', () => {
  it('reset requires confirmation and regenerates genesis', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'step', steps: 60 });
    await app!.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/snapshots`,
      payload: { name: 'later' },
    });
    const url = `/api/civilizations/${civ.id}/reset`;
    for (const payload of [undefined, {}, { confirm: 'testville' }]) {
      const res = await app!.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiErrorBody>().error.code).toBe('CONFIRMATION_REQUIRED');
    }
    const res = await app!.inject({ method: 'POST', url, payload: { confirm: 'Testville' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<CivilizationSummary>()).toMatchObject({ tick: 0, status: 'paused' });

    const { simulation, genesis } = Simulation.create(SEED, SMALL_CONFIG);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(simulation.hash());
    expect(await eventSeqs(prisma, civ.id)).toEqual(range(1, genesis.events.length));
    expect(await prisma.metricSample.count({ where: { civilizationId: civ.id } })).toBe(1);
    const snapshot = await prisma.snapshot.findFirstOrThrow({ where: { civilizationId: civ.id } });
    expect(snapshot.detachedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'simulation.reset' },
    });
    expect(audit.actor).toBe('local-dev');

    // The regenerated world continues exactly like the original did.
    await control(app!, civ.id, { action: 'step', steps: 10 });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 10));
  });

  it('delete requires confirmation, removes everything and keeps an audit record', async () => {
    const civ = await createCivilization(app!);
    await control(app!, civ.id, { action: 'step', steps: 5 });
    const url = `/api/civilizations/${civ.id}`;
    const refused = await app!.inject({ method: 'DELETE', url, payload: { confirm: 'nope' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<ApiErrorBody>().error.code).toBe('CONFIRMATION_REQUIRED');

    const res = await app!.inject({ method: 'DELETE', url, payload: { confirm: 'Testville' } });
    expect(res.statusCode).toBe(204);
    expect((await app!.inject({ url })).statusCode).toBe(404);
    expect(app!.ctx.runners.peek(civ.id)).toBeUndefined();
    for (const count of [
      prisma.citizen.count({ where: { civilizationId: civ.id } }),
      prisma.simulationEvent.count({ where: { civilizationId: civ.id } }),
      prisma.metricSample.count({ where: { civilizationId: civ.id } }),
      prisma.worldCheckpoint.count({ where: { civilizationId: civ.id } }),
    ]) {
      expect(await count).toBe(0);
    }
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'civilization.deleted' },
    });
    expect(audit.details).toMatchObject({ civilizationId: civ.id, name: 'Testville' });
    // Earlier audit entries survive with the civilization detached.
    expect(await prisma.auditLog.count({ where: { action: 'civilization.created' } })).toBe(1);

    const again = await app!.inject({ method: 'DELETE', url, payload: { confirm: 'Testville' } });
    expect(again.statusCode).toBe(404);
  });
});
