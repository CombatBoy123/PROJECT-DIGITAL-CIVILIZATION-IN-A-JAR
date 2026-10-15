import { EventEmitter } from 'node:events';
import { Simulation, type SimulationConfigInput } from '@civ/sim-core';
import type { StreamMessage } from '@civ/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { CheckpointWrite } from '../src/persistence/store.js';
import { SimulationRunner, type RunnerStore } from '../src/runner/runner.js';
import { BACKPRESSURE_BYTES, CivilizationStream } from '../src/ws/stream.js';
import { range, waitFor } from './helpers.js';

const CONFIG: SimulationConfigInput = { population: 10, daysPerSeason: 1 };
const log = Fastify({ logger: false }).log;

/** In-memory store; checkpoint writes fail while `failing` is set. */
class FakeStore {
  failing = false;
  attempts = 0;
  readonly committed: CheckpointWrite[] = [];

  writeCheckpoint = async (input: CheckpointWrite): Promise<void> => {
    this.attempts++;
    await new Promise((r) => setTimeout(r, 1));
    if (this.failing) throw new Error('database unavailable');
    this.committed.push(input);
  };
  updateRuntime = async (): Promise<void> => undefined;
  audit = async (): Promise<void> => undefined;
  recordHalt = async (): Promise<void> => undefined;
  loadCheckpoint = async (): Promise<never> => {
    throw new Error('not used');
  };
  createSnapshot = async (): Promise<never> => {
    throw new Error('not used');
  };
  loadSnapshot = async (): Promise<never> => {
    throw new Error('not used');
  };
  rewind = async (): Promise<void> => undefined;
  deleteCivilization = async (): Promise<void> => undefined;

  committedSeqs(): number[] {
    return this.committed.flatMap((c) => c.events.map((e) => e.seq));
  }

  committedMetricTicks(): number[] {
    return this.committed.flatMap((c) => c.metrics.map((m) => m.tick));
  }
}

const runners: SimulationRunner[] = [];

function makeRunner(store: FakeStore, overrides: Partial<{ checkpointIntervalMs: number }> = {}) {
  const { simulation, genesis } = Simulation.create('runner-seed', CONFIG);
  const runner = new SimulationRunner({
    id: 'civ',
    simulation,
    status: 'paused',
    speed: 0,
    haltReason: null,
    store: store as unknown as RunnerStore,
    settings: {
      checkpointIntervalMs: overrides.checkpointIntervalMs ?? 30,
      maxBufferedEvents: 100_000,
      invariants: 'every-tick',
      sliceBudgetMs: 5,
    },
    log,
  });
  runners.push(runner);
  return { runner, firstSeq: genesis.events.length + 1 };
}

afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown();
});

describe('SimulationRunner checkpoint failures', () => {
  it('keeps buffered history when a checkpoint fails and commits it exactly once later', async () => {
    const store = new FakeStore();
    const { runner, firstSeq } = makeRunner(store);

    store.failing = true;
    await expect(runner.step(50, 'test')).rejects.toThrow(/Checkpoint failed/);
    expect(runner.summary()).toMatchObject({ status: 'paused', tick: 50, durableTick: 0 });
    expect(runner.summary().lastError).toMatch(/database unavailable/);

    // While running, a failing interval checkpoint pauses the loop.
    await runner.start('test');
    await waitFor(() => runner.summary().status === 'paused');
    const pausedAt = runner.summary();
    expect(pausedAt.lastError).toMatch(/Checkpoint failed: database unavailable/);
    expect(pausedAt.tick).toBeGreaterThan(50);
    expect(pausedAt.durableTick).toBe(0);
    expect(store.committed).toHaveLength(0);

    // Persistence recovers: pausing a paused runner with uncommitted ticks writes them.
    store.failing = false;
    const recovered = await runner.pause('test');
    expect(recovered.lastError).toBeNull();
    expect(recovered.durableTick).toBe(recovered.tick);
    expect(recovered.tick).toBe(pausedAt.tick);

    const last = store.committed[store.committed.length - 1]!;
    expect(last.encoded.tick).toBe(recovered.tick);
    expect(last.projection.full).toBe(true); // rebuilt after the failed write
    expect(store.committedSeqs()).toEqual(range(firstSeq, last.encoded.nextEventSeq - 1));
    expect(store.committedSeqs().length).toBeGreaterThan(0);
    expect(store.committedMetricTicks()).toEqual(range(1, recovered.tick));

    // Later checkpoints continue the sequence without gaps or duplicates.
    await runner.step(30, 'test');
    const final = store.committed[store.committed.length - 1]!;
    expect(final.projection.full).toBe(false);
    expect(store.committedSeqs()).toEqual(range(firstSeq, final.encoded.nextEventSeq - 1));
    expect(store.committedMetricTicks()).toEqual(range(1, recovered.tick + 30));
    expect(runner.sim.hash()).toBe(
      (() => {
        const s = Simulation.create('runner-seed', CONFIG).simulation;
        s.run(recovered.tick + 30);
        return s.hash();
      })(),
    );
  });

  it('serialises control operations', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store);
    const order: number[] = [];
    await Promise.all([
      runner.step(5, 'a').then((s) => order.push(s.tick)),
      runner.step(5, 'b').then((s) => order.push(s.tick)),
      runner.step(5, 'c').then((s) => order.push(s.tick)),
    ]);
    expect(order).toEqual([5, 10, 15]);
    expect(store.committed.map((c) => c.encoded.tick)).toEqual([5, 10, 15]);
  });
});

/** Minimal stand-in for a ws socket whose buffer level the test controls. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: StreamMessage[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as StreamMessage);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  ping(): void {}
  terminate(): void {
    this.close();
  }
}

describe('CivilizationStream backpressure', () => {
  it('skips deltas for a congested client and resynchronises it with a keyframe', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store);
    const stream = new CivilizationStream(runner, 60_000, () => undefined, log);
    const fast = new FakeSocket();
    const slow = new FakeSocket();
    stream.add(fast as unknown as WebSocket);
    stream.add(slow as unknown as WebSocket);
    stream.frame();
    expect(fast.sent.map((m) => m.type)).toEqual(['hello', 'keyframe']);
    expect(slow.sent.map((m) => m.type)).toEqual(['hello', 'keyframe']);

    slow.bufferedAmount = BACKPRESSURE_BYTES + 1;
    await runner.step(30, 'test');
    stream.frame();
    const fastTypes = fast.sent.map((m) => m.type);
    expect(fastTypes).toContain('delta');
    expect(fastTypes).toContain('events');
    expect(slow.sent.filter((m) => m.type === 'delta' || m.type === 'events')).toHaveLength(0);

    // Drained: the next frame brings a keyframe (never a delta on a stale base),
    // and the skipped events are reported as dropped.
    slow.bufferedAmount = 0;
    await runner.step(1, 'test');
    stream.frame();
    const resync = slow.sent.filter((m) => m.type === 'keyframe' || m.type === 'delta');
    expect(resync.map((m) => m.type)).toEqual(['keyframe', 'keyframe']);
    expect(resync[1]!.type === 'keyframe' && resync[1]!.tick).toBe(31);
    const events = slow.sent.filter((m) => m.type === 'events');
    expect(events[0]!.type === 'events' && events[0]!.dropped).toBeGreaterThan(0);
    stream.close();
  });

  it('caps events per message and counts the rest as dropped', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store);
    const stream = new CivilizationStream(runner, 60_000, () => undefined, log);
    const socket = new FakeSocket();
    stream.add(socket as unknown as WebSocket);
    stream.frame();
    // Many simulated days produce more than MAX_STREAMED_EVENTS events in one frame.
    await runner.step(1000, 'test');
    await runner.step(1000, 'test');
    await runner.step(1000, 'test');
    await runner.step(1000, 'test');
    stream.frame();
    const message = socket.sent.find((m) => m.type === 'events');
    expect(message?.type).toBe('events');
    if (message?.type !== 'events') return;
    expect(message.events.length).toBeLessThanOrEqual(200);
    const total = store.committedSeqs().length;
    expect(total).toBeGreaterThan(200);
    expect(message.events.length).toBe(200);
    expect(message.events.length + message.dropped).toBe(total);
    // The most recent events are kept.
    expect(message.events[199]!.seq).toBe(store.committedSeqs()[total - 1]);
    stream.close();
  });
});
