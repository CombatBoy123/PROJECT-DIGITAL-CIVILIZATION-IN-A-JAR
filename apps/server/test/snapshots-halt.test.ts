import type { WorldState } from '@civ/sim-core';
import type { ApiErrorBody, CivilizationSummary, SnapshotDto } from '@civ/shared';
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

async function snapshot(id: string, name: string): Promise<SnapshotDto> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/civilizations/${id}/snapshots`,
    payload: { name, note: `at ${name}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json<SnapshotDto>();
}

function restore(id: string, snapshotId: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/civilizations/${id}/snapshots/${snapshotId}/restore`,
    payload: payload as Record<string, unknown> | undefined,
  });
}

describe('snapshots', () => {
  it('save, step, restore reproduces the snapshot exactly and later history is removed', async () => {
    const civ = await createCivilization(app);
    await control(app, civ.id, { action: 'step', steps: 30 });
    const early = await snapshot(civ.id, 'early');
    expect(early).toMatchObject({ tick: 30, note: 'at early', detachedAt: null });
    expect(early.stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 30));
    const earlySeq = (await checkpointOf(prisma, civ.id)).nextEventSeq;

    await control(app, civ.id, { action: 'step', steps: 40 });
    const late = await snapshot(civ.id, 'late');
    expect(late.tick).toBe(70);
    await control(app, civ.id, { action: 'step', steps: 20 });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/snapshots`,
      payload: { name: 'early' },
    });
    expect(duplicate.statusCode).toBe(409);

    // Confirmation is required.
    for (const payload of [undefined, { confirm: 'Wrong' }]) {
      const res = await restore(civ.id, early.id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json<ApiErrorBody>().error.code).toBe('CONFIRMATION_REQUIRED');
    }
    const res = await restore(civ.id, early.id, { confirm: 'Testville' });
    expect(res.statusCode).toBe(200);
    expect(res.json<CivilizationSummary>()).toMatchObject({
      tick: 30,
      durableTick: 30,
      status: 'paused',
    });

    const checkpoint = await checkpointOf(prisma, civ.id);
    expect(checkpoint.stateHash).toBe(early.stateHash);
    expect(checkpoint.nextEventSeq).toBe(earlySeq);
    expect(await eventSeqs(prisma, civ.id)).toEqual(range(1, earlySeq - 1));
    const maxMetric = await prisma.metricSample.aggregate({
      where: { civilizationId: civ.id },
      _max: { tick: true },
      _count: true,
    });
    expect(maxMetric._max.tick).toBe(30);
    expect(maxMetric._count).toBe(31);

    // The later snapshot belongs to the abandoned timeline.
    const list = json<{ items: SnapshotDto[] }>(
      await app.inject({ url: `/api/civilizations/${civ.id}/snapshots` }),
    );
    expect(list.items.map((s) => s.name)).toEqual(['late', 'early']);
    expect(list.items[0]!.detachedAt).not.toBeNull();
    expect(list.items[1]!.detachedAt).toBeNull();
    const detached = await restore(civ.id, late.id, { confirm: 'Testville' });
    expect(detached.statusCode).toBe(409);
    expect(detached.json<ApiErrorBody>().error.code).toBe('CONFLICT');

    // Resuming from the snapshot reproduces the original continuation.
    await control(app, civ.id, { action: 'step', steps: 40 });
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(late.stateHash);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'snapshot.restored' },
    });
    expect(audit.details).toMatchObject({ snapshotId: early.id, fromTick: 90, toTick: 30 });
  });

  it('restore of an unknown snapshot is 404 and snapshots survive a restart', async () => {
    const civ = await createCivilization(app);
    await control(app, civ.id, { action: 'step', steps: 5 });
    const snap = await snapshot(civ.id, 'five');
    const missing = await restore(civ.id, '00000000-0000-4000-8000-000000000000', {
      confirm: 'Testville',
    });
    expect(missing.statusCode).toBe(404);

    await control(app, civ.id, { action: 'step', steps: 5 });
    await app.close();
    app = await startApp(prisma);
    const res = await restore(civ.id, snap.id, { confirm: 'Testville' });
    expect(res.statusCode).toBe(200);
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(snap.stateHash);
  });
});

describe('invariant halt', () => {
  it('halts on an impossible state, records why, and reset clears it', async () => {
    const civ = await createCivilization(app);
    await control(app, civ.id, { action: 'step', steps: 10 });
    const runner = app.ctx.runners.peek(civ.id)!;
    // Corrupt the in-memory world: money appears from nowhere.
    const state = runner.sim.state as unknown as WorldState;
    state.citizens[0]!.balanceCents += 1;

    const halted = await control(app, civ.id, { action: 'step', steps: 5 });
    expect(halted.status).toBe('halted');
    expect(halted.haltReason).toMatch(/MONEY_CONSERVATION/);
    // The last durable state is reloaded; uncommitted ticks are discarded.
    expect(halted.tick).toBe(10);
    expect(runner.sim.hash()).toBe(pureHash(SEED, SMALL_CONFIG, 10));

    const stored = await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } });
    expect(stored.status).toBe('HALTED');
    expect(stored.haltReason).toMatch(/MONEY_CONSERVATION/);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { civilizationId: civ.id, action: 'simulation.halted' },
    });
    expect(audit.actor).toBe('engine');
    expect(audit.tick).toBe(11);
    expect(JSON.stringify(audit.details)).toContain('MONEY_CONSERVATION');
    expect((await checkpointOf(prisma, civ.id)).tick).toBe(10);

    for (const payload of [{ action: 'start' }, { action: 'step' }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/civilizations/${civ.id}/control`,
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<ApiErrorBody>().error.code).toBe('HALTED');
    }
    const snap = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/snapshots`,
      payload: { name: 'bad' },
    });
    expect(snap.statusCode).toBe(409);

    // The halt survives a restart.
    await app.close();
    app = await startApp(prisma);
    const detail = json<CivilizationSummary>(
      await app.inject({ url: `/api/civilizations/${civ.id}` }),
    );
    expect(detail.status).toBe('halted');

    const reset = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/reset`,
      payload: { confirm: 'Testville' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<CivilizationSummary>()).toMatchObject({
      status: 'paused',
      haltReason: null,
      tick: 0,
    });
    const after = await control(app, civ.id, { action: 'step', steps: 3 });
    expect(after.status).toBe('paused');
    expect((await checkpointOf(prisma, civ.id)).stateHash).toBe(pureHash(SEED, SMALL_CONFIG, 3));
  });

  it('a halt while running is detected by the background loop', async () => {
    const civ = await createCivilization(app);
    const runner = app.ctx.runners.peek(civ.id)!;
    await control(app, civ.id, { action: 'start' });
    const state = runner.sim.state as unknown as WorldState;
    state.citizens[0]!.balanceCents = -5;
    for (let i = 0; i < 100 && runner.summary().status !== 'halted'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runner.summary().status).toBe('halted');
    // Recording happens on the control queue; a queued pause observes it.
    await control(app, civ.id, { action: 'pause' });
    const stored = await prisma.civilization.findUniqueOrThrow({ where: { id: civ.id } });
    expect(stored.status).toBe('HALTED');
    expect(stored.haltReason).toMatch(/NEGATIVE_BALANCE/);
  });
});
