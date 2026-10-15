import type { AddressInfo } from 'node:net';
import { buildFrame, type CitizenFrameTuple } from '@civ/sim-core';
import type { StreamMessage } from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  control,
  createCivilization,
  createTestPrisma,
  startApp,
  truncateAll,
  waitFor,
} from './helpers.js';

let prisma: PrismaClient;
let app: FastifyInstance;
let port: number;

beforeAll(() => {
  prisma = createTestPrisma();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await truncateAll(prisma);
  app = await startApp(prisma, { FRAME_RATE: '10' });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterEach(async () => {
  await app.close();
});

/** The message variant(s) with a given type (frames share one variant for two types). */
type MessageOf<T extends StreamMessage['type']> = StreamMessage & { type: T };

/** A stream client that records every message. */
class Client {
  readonly messages: StreamMessage[] = [];
  readonly socket: WebSocket;
  closed = false;

  constructor(id: string) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/api/civilizations/${id}/stream`);
    this.socket.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as StreamMessage);
    });
    this.socket.on('close', () => {
      this.closed = true;
    });
  }

  of<T extends StreamMessage['type']>(type: T): MessageOf<T>[] {
    return this.messages.filter((m): m is MessageOf<T> => m.type === type);
  }

  wait<T extends StreamMessage['type']>(
    type: T,
    predicate: (m: MessageOf<T>) => boolean = () => true,
  ): Promise<MessageOf<T>> {
    return waitFor(() => this.of(type).find(predicate), { timeoutMs: 5000 });
  }
}

/** Apply keyframes and deltas like a renderer would. */
function replay(messages: StreamMessage[]): Map<number, CitizenFrameTuple> {
  const world = new Map<number, CitizenFrameTuple>();
  for (const m of messages) {
    if (m.type === 'keyframe') {
      world.clear();
      for (const t of m.citizens) world.set(t[0], t);
    } else if (m.type === 'delta') {
      for (const t of m.citizens) world.set(t[0], t);
    }
  }
  return world;
}

describe('live stream', () => {
  it('sends hello and a keyframe, then deltas and events that reproduce the world', async () => {
    const civ = await createCivilization(app);
    const client = new Client(civ.id);
    const hello = await client.wait('hello');
    expect(hello).toMatchObject({
      civilizationId: civ.id,
      status: 'paused',
      tick: 0,
      durableTick: 0,
    });
    const keyframe = await client.wait('keyframe');
    expect(client.messages[0]!.type).toBe('hello');
    expect(keyframe.tick).toBe(0);
    expect(keyframe.citizens).toHaveLength(20);

    // One season per day: stepping past tick 24 emits SeasonStarted.
    await control(app, civ.id, { action: 'step', steps: 30 });
    await client.wait('delta', (m) => m.tick === 30);
    const events = await client.wait('events');
    expect(events.dropped).toBe(0);
    const all = client.of('events').flatMap((m) => m.events);
    expect(all.some((e) => e.type === 'SeasonStarted' && e.tick === 24)).toBe(true);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    await client.wait('checkpoint', (m) => m.tick === 30);

    const sim = app.ctx.runners.peek(civ.id)!.sim;
    const expected = new Map(buildFrame(sim.state).citizens.map((t) => [t[0], t]));
    expect(replay(client.messages)).toEqual(expected);
    client.socket.close();
  });

  it('streams status while running, at most FRAME_RATE frames per second', async () => {
    const civ = await createCivilization(app);
    await app.inject({
      method: 'PUT',
      url: `/api/civilizations/${civ.id}/speed`,
      payload: { ticksPerSecond: 0 },
    });
    const client = new Client(civ.id);
    await client.wait('keyframe');
    await control(app, civ.id, { action: 'start' });
    await client.wait('status', (m) => m.status === 'running');
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 1000));
    await control(app, civ.id, { action: 'pause' });
    const elapsed = (Date.now() - startedAt) / 1000;
    await client.wait('status', (m) => m.status === 'paused');
    const frames = client.of('delta').length;
    expect(frames).toBeGreaterThan(3);
    // FRAME_RATE=10, plus one frame of slack for timer alignment.
    expect(frames).toBeLessThanOrEqual(Math.ceil(elapsed * 10) + 2);
    const durable = await client.wait('checkpoint', (m) => m.tick > 0);
    expect(durable.tick).toBeGreaterThan(0);
    client.socket.close();
  });

  it('a late joiner gets a keyframe of the current world', async () => {
    const civ = await createCivilization(app);
    const early = new Client(civ.id);
    await early.wait('keyframe');
    await control(app, civ.id, { action: 'step', steps: 12 });
    await early.wait('delta', (m) => m.tick === 12);
    const late = new Client(civ.id);
    const keyframe = await late.wait('keyframe');
    expect(keyframe.tick).toBe(12);
    const sim = app.ctx.runners.peek(civ.id)!.sim;
    expect(keyframe.citizens).toEqual(buildFrame(sim.state).citizens);
    early.socket.close();
    late.socket.close();
  });

  it('notifies reset and deleted', async () => {
    const civ = await createCivilization(app);
    const client = new Client(civ.id);
    await client.wait('keyframe');
    await control(app, civ.id, { action: 'step', steps: 10 });
    await client.wait('delta', (m) => m.tick === 10);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/civilizations/${civ.id}/reset`,
      payload: { confirm: 'Testville' },
    });
    expect(reset.statusCode).toBe(200);
    await client.wait('reset', (m) => m.tick === 0);
    const resetIndex = client.messages.findIndex((m) => m.type === 'reset');
    const after = await waitFor(() =>
      client.messages.slice(resetIndex).find((m) => m.type === 'keyframe'),
    );
    expect(after.type === 'keyframe' && after.tick).toBe(0);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/civilizations/${civ.id}`,
      payload: { confirm: 'Testville' },
    });
    expect(del.statusCode).toBe(204);
    await client.wait('deleted');
    await waitFor(() => client.closed);
  });

  it('caps connections in total and per client address', async () => {
    /** 101 when the upgrade succeeds (the socket is returned), else the refusal status. */
    const open = (id: string) =>
      new Promise<{ status: number; socket?: WebSocket }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/civilizations/${id}/stream`);
        ws.on('open', () => resolve({ status: 101, socket: ws }));
        ws.on('unexpected-response', (req, res) => {
          resolve({ status: res.statusCode ?? 0 });
          req.destroy();
        });
        ws.on('error', reject);
      });
    /** The refusal body (the cap is checked before the upgrade). */
    const refusal = async (id: string) =>
      (await app.inject({ url: `/api/civilizations/${id}/stream` })).json<{
        error: { code: string; message: string };
      }>().error;

    for (const [round, [limits, expected]] of (
      [
        [{ STREAM_MAX_CONNECTIONS_PER_ADDRESS: '2' }, /from this address/],
        [{ STREAM_MAX_CONNECTIONS: '2' }, /^Too many live stream connections; try again later$/],
      ] as const
    ).entries()) {
      await app.close();
      app = await startApp(prisma, { FRAME_RATE: '10', ...limits });
      await app.listen({ host: '127.0.0.1', port: 0 });
      port = (app.server.address() as AddressInfo).port;
      const a = await createCivilization(app, { name: `Capped ${round}` });
      const b = await createCivilization(app, { name: `Other ${round}` });

      const first = await open(a.id);
      const second = await open(b.id);
      expect([first.status, second.status]).toEqual([101, 101]);
      expect((await open(a.id)).status).toBe(503);
      expect(await refusal(a.id)).toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringMatching(expected),
      });
      // Closing a connection frees its slot (once the server has seen the close).
      first.socket!.close();
      await waitFor(async () => (await refusal(a.id)).code !== 'UNAVAILABLE');
      const again = await open(a.id);
      expect(again.status).toBe(101);
      second.socket!.close();
      again.socket!.close();
    }
  });

  it('rejects unknown civilizations before the upgrade', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/civilizations/00000000-0000-4000-8000-000000000000/stream`,
      );
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      ws.on('error', () => undefined);
    });
    expect(status).toBe(404);
  });
});
