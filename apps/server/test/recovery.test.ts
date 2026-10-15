import { Simulation } from '@civ/sim-core';
import type { ApiErrorBody, CivilizationDetail, SnapshotDto } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/http/errors.js';
import {
  iterateEvents,
  iterateMetricSamples,
  timelineGuard,
} from '../src/persistence/history-queries.js';
import {
  checkpointOf,
  control,
  createCivilization,
  createTestPrisma,
  json,
  pureHash,
  SMALL_CONFIG,
  startApp,
  truncateAll,
  waitFor,
} from './helpers.js';

const SEED = 'test-seed';

let prisma: PrismaClient;
let app: FastifyInstance;

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
  await app.close();
});

async function detail(id: string): Promise<CivilizationDetail> {
  return json<CivilizationDetail>(await app.inject({ url: `/api/civilizations/${id}` }));
}

async function storedStatus(id: string): Promise<string> {
  return (await prisma.civilization.findUniqueOrThrow({ where: { id } })).status;
}

describe('paused status is durable', () => {
  it('a pause with nothing uncommitted is stored, so eviction and reload keep it paused', async () => {
    await app.close();
    app = await startApp(prisma, { CHECKPOINT_INTERVAL_MS: '2000' }, { idleEvictMs: 100 });
    const civ = await createCivilization(app);
    await app.inject({
      method: 'PUT',
      url: `/api/civilizations/${civ.id}/speed`,
      payload: { ticksPerSecond: 1 },
    });
    await control(app, civ.id, { action: 'start' });
    const paused = await control(app, civ.id, { action: 'pause' });
    expect(paused).toMatchObject({ status: 'paused', tick: 0 });
    expect(await storedStatus(civ.id)).toBe('PAUSED');

    await waitFor(() => app.ctx.runners.peek(civ.id) === undefined, { timeoutMs: 5000 });
    const list = json<{ items: CivilizationDetail[] }>(
      await app.inject({ url: '/api/civilizations' }),
    );
    expect(list.items.map((c) => c.status)).toEqual(['paused']);
    // Reloading (any read that needs the runner) must not resume it.
    expect((await app.inject({ url: `/api/civilizations/${civ.id}/frame` })).statusCode).toBe(200);
    expect(app.ctx.runners.peek(civ.id)?.summary().status).toBe('paused');
    // At 1 tick/s a resumed runner would have ticked (and would never be evicted again).
    await new Promise((r) => setTimeout(r, 1300));
    expect(await detail(civ.id)).toMatchObject({ status: 'paused', tick: 0 });
    expect(await storedStatus(civ.id)).toBe('PAUSED');
    const actions = await prisma.auditLog.findMany({
      where: { civilizationId: civ.id },
      orderBy: { id: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'civilization.created',
      'simulation.speed_changed',
      'simulation.started',
      'simulation.paused',
    ]);
  });
});

describe('persistence failures', () => {
  it('report a classified message with a log reference, never driver internals', async () => {
    const civ = await createCivilization(app);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION civ_test_fail_checkpoint() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated disk failure'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER civ_test_fail_checkpoint BEFORE INSERT OR UPDATE ON "world_checkpoint"
      FOR EACH ROW EXECUTE FUNCTION civ_test_fail_checkpoint()`);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/civilizations/${civ.id}/control`,
        payload: { action: 'step', steps: 2 },
      });
      expect(res.statusCode).toBe(500);
      const message = res.json<ApiErrorBody>().error.message;
      expect(message).toMatch(/^Checkpoint failed \(database error[^)]*; ref [0-9a-f]{8}\)$/);
      const shown = await detail(civ.id);
      expect(shown.lastError).toBe(message);
      for (const leak of ['store.ts', 'simulated disk failure', 'invocation', '/home/']) {
        expect(res.body).not.toContain(leak);
        expect(JSON.stringify(shown)).not.toContain(leak);
      }
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS civ_test_fail_checkpoint ON "world_checkpoint"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS civ_test_fail_checkpoint()`);
    }
    // Persistence recovered: the retained ticks are committed by the next pause.
    const recovered = await control(app, civ.id, { action: 'pause' });
    expect(recovered).toMatchObject({ tick: 2, durableTick: 2, lastError: null });
  });
});

describe('unloadable stored state', () => {
  async function corrupt(id: string): Promise<void> {
    await app.close();
    await prisma.worldCheckpoint.update({
      where: { civilizationId: id },
      data: { stateHash: '0'.repeat(32) },
    });
    app = await startApp(prisma);
  }

  it('is shown as halted with the reason, and reset or restore recover it', async () => {
    const civ = await createCivilization(app);
    await control(app, civ.id, { action: 'step', steps: 6 });
    const saved = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/snapshots`,
      payload: { name: 'good' },
    });
    const good = saved.json<SnapshotDto>();
    await control(app, civ.id, { action: 'step', steps: 18 });
    await corrupt(civ.id);

    const frame = await app.inject({ url: `/api/civilizations/${civ.id}/frame` });
    expect(frame.statusCode).toBe(500);
    expect(frame.json<ApiErrorBody>().error.message).toMatch(
      /^The stored state could not be loaded: State hash mismatch/,
    );
    const shown = await detail(civ.id);
    expect(shown).toMatchObject({ status: 'halted', durableTick: 24 });
    expect(shown.haltReason).toMatch(/Stored state could not be loaded: State hash mismatch/);
    // Repeated failures do not flood the audit log.
    await app.inject({ url: `/api/civilizations/${civ.id}/layout` });
    expect(
      await prisma.auditLog.count({
        where: { civilizationId: civ.id, action: 'simulation.state_unloadable' },
      }),
    ).toBe(1);

    // Restore does not need the corrupt checkpoint.
    const restored = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/snapshots/${good.id}/restore`,
      payload: { confirm: 'Testville' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<CivilizationDetail>()).toMatchObject({
      status: 'paused',
      tick: 6,
      haltReason: null,
    });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(good.stateHash);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'snapshot.restored' },
    });
    expect(audit.details).toMatchObject({
      fromTick: 24,
      toTick: 6,
      recoveredFromUnloadableState: true,
    });
    await control(app, civ.id, { action: 'step', steps: 4 });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 10));

    // Reset does not need it either; concurrent requests share one recovery.
    await corrupt(civ.id);
    const resets = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: `/api/civilizations/${civ.id}/reset`,
          payload: { confirm: 'Testville' },
        }),
      ),
    );
    expect(resets.map((r) => r.statusCode)).toEqual([200, 200]);
    const { simulation } = Simulation.create(SEED, SMALL_CONFIG);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(simulation.hash());
    expect(await detail(civ.id)).toMatchObject({ status: 'paused', tick: 0, haltReason: null });
    await control(app, civ.id, { action: 'step', steps: 3 });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 3));
  });
});

describe('exports during a rewind', () => {
  it('abort instead of ending early or mixing timelines', async () => {
    const civ = await createCivilization(app);
    await control(app, civ.id, { action: 'step', steps: 40 });
    const row = await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } });
    const boundary = (await checkpointOf(prisma, civ.id)).nextEventSeq;
    expect(boundary).toBeGreaterThan(20);

    const events = iterateEvents(prisma, civ.id, {}, boundary, {
      pageSize: 5,
      verify: timelineGuard(prisma, civ.id, row.timeline),
    });
    const metrics = iterateMetricSamples(
      prisma,
      civ.id,
      ['population.total'],
      { fromTick: 0, throughTick: 40 },
      { pageSize: 5, verify: timelineGuard(prisma, civ.id, row.timeline) },
    );
    expect((await events.next()).value).toHaveLength(5);
    expect((await metrics.next()).value).toHaveLength(5);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/reset`,
      payload: { confirm: 'Testville' },
    });
    expect(reset.statusCode).toBe(200);
    expect((await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } })).timeline).toBe(
      row.timeline + 1,
    );
    for (const pages of [events, metrics]) {
      const failure = await pages.next().then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('CONFLICT');
    }

    // Without a rewind, the same paging reads everything below the boundary.
    const fresh = await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } });
    await control(app, civ.id, { action: 'step', steps: 40 });
    const all: number[] = [];
    for await (const page of iterateEvents(prisma, civ.id, {}, boundary, {
      pageSize: 7,
      verify: timelineGuard(prisma, civ.id, fresh.timeline),
    })) {
      all.push(...page.map((e) => e.seq));
    }
    expect(all).toEqual(Array.from({ length: boundary - 1 }, (_, i) => i + 1));
  });
});
