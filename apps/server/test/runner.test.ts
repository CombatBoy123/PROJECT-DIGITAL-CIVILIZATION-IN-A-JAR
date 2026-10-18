import { EventEmitter } from 'node:events';
import { Simulation, type SimulationConfigInput } from '@civ/sim-core';
import type { StreamMessage } from '@civ/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AuditInput, CheckpointWrite, RewindWrite } from '../src/persistence/store.js';
import { SimulationRunner, type RunnerStore } from '../src/runner/runner.js';
import { BACKPRESSURE_BYTES, CivilizationStream, STALLED_CLIENT_MS } from '../src/ws/stream.js';
import { range, waitFor } from './helpers.js';

const CONFIG: SimulationConfigInput = { population: 10, daysPerSeason: 1 };
const log = Fastify({ logger: false }).log;

/** In-memory store; checkpoint writes fail while `failing` is set. */
class FakeStore {
  failing = false;
  /** The next N runtime (status/speed + audit) writes fail. */
  failRuntimeWrites = 0;
  attempts = 0;
  readonly committed: CheckpointWrite[] = [];
  /** Committed audit entries, in order (checkpoint and runtime writes). */
  readonly audits: AuditInput[] = [];
  /** Stored status as the database would hold it. */
  status = 'paused';
  readonly rewinds: RewindWrite[] = [];
  halts = 0;
  /** When set, loadSnapshot waits for this promise. */
  snapshotGate: Promise<void> | null = null;

  writeCheckpoint = async (input: CheckpointWrite): Promise<void> => {
    this.attempts++;
    await new Promise((r) => setTimeout(r, 1));
    if (this.failing) throw new Error('database unavailable at /srv/app/store.ts:149');
    this.committed.push(input);
    this.status = input.status;
    if (input.audit) this.audits.push(input.audit);
  };
  updateRuntime = async (
    _id: string,
    data: { status?: string },
    audit?: AuditInput | null,
  ): Promise<void> => {
    await new Promise((r) => setTimeout(r, 1));
    if (this.failRuntimeWrites > 0) {
      this.failRuntimeWrites--;
      throw new Error('audit insert failed');
    }
    if (data.status) this.status = data.status;
    if (audit) this.audits.push(audit);
  };
  recordHalt = async (): Promise<void> => {
    this.halts++;
  };
  loadCheckpoint = async (): Promise<never> => {
    throw new Error('not used');
  };
  createSnapshot = async (): Promise<never> => {
    throw new Error('not used');
  };
  loadSnapshot = async () => {
    await this.snapshotGate;
    const { simulation } = Simulation.create('runner-seed', CONFIG);
    simulation.run(3);
    return { simulation, name: 'three', tick: 3 };
  };
  rewind = async (input: RewindWrite): Promise<void> => {
    this.rewinds.push(input);
    this.status = 'paused';
  };
  deleteCivilization = async (): Promise<void> => undefined;

  actions(): string[] {
    return this.audits.map((a) => a.action);
  }

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
    // Clients get a classification and a log reference, never the driver's message.
    expect(runner.summary().lastError).toMatch(
      /^Checkpoint failed \(unexpected error; ref [0-9a-f]{8}\)$/,
    );

    // While running, a failing interval checkpoint pauses the loop.
    await runner.start('test');
    await waitFor(() => runner.summary().status === 'paused');
    const pausedAt = runner.summary();
    expect(pausedAt.lastError).toMatch(/^Checkpoint failed \(unexpected error; ref [0-9a-f]{8}\)$/);
    expect(pausedAt.lastError).not.toContain('store.ts');
    // Paused in memory after the failure, RUNNING in the store: not evictable.
    expect(store.status).toBe('running');
    expect(runner.idle).toBe(false);
    expect(pausedAt.tick).toBeGreaterThan(50);
    expect(pausedAt.durableTick).toBe(0);
    expect(store.committed).toHaveLength(0);

    // Persistence recovers: pausing a paused runner with uncommitted ticks writes them.
    store.failing = false;
    const recovered = await runner.pause('test');
    expect(recovered.lastError).toBeNull();
    expect(recovered.durableTick).toBe(recovered.tick);
    expect(store.status).toBe('paused');
    expect(runner.idle).toBe(true);
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

  it('a control action whose status/audit write fails changes nothing and can be retried', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store);
    store.failRuntimeWrites = 1;
    await expect(runner.start('test')).rejects.toThrow(/audit insert failed/);
    expect(runner.summary()).toMatchObject({ status: 'paused', tick: 0 });
    expect(store.status).toBe('paused');
    expect(store.actions()).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.summary().tick).toBe(0); // no loop was started
    // Stepping works (the runner is not stuck in a half-started state) and retrying start works.
    await runner.step(2, 'test');
    await runner.start('test');
    await waitFor(() => runner.summary().tick > 4);
    expect(store.status).toBe('running');

    store.failRuntimeWrites = 1;
    await expect(runner.setSpeed(7, 'test')).rejects.toThrow(/audit insert failed/);
    expect(runner.summary().speed).toBe(0);
    await runner.pause('test');
    expect(store.actions()).toEqual([
      'simulation.stepped',
      'simulation.started',
      'simulation.paused',
    ]);
  });

  it('persists a pause even when no tick is uncommitted', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store, { checkpointIntervalMs: 60_000 });
    // At 1 tick/s the first tick is due after a second: the pause comes before it.
    await runner.setSpeed(1, 'test');
    await runner.start('test');
    expect(store.status).toBe('running');
    const paused = await runner.pause('test');
    expect(paused).toMatchObject({ status: 'paused', tick: 0, durableTick: 0 });
    expect(store.committed).toHaveLength(0); // no checkpoint was needed …
    expect(store.status).toBe('paused'); // … but the status was still stored
    expect(store.actions()).toEqual([
      'simulation.speed_changed',
      'simulation.started',
      'simulation.paused',
    ]);
    expect(runner.idle).toBe(true);
  });

  it('records a halt that happens while a restore reads its snapshot', async () => {
    const store = new FakeStore();
    const { runner } = makeRunner(store);
    await runner.start('test');
    await waitFor(() => runner.summary().tick >= 3);
    let release!: () => void;
    store.snapshotGate = new Promise((r) => {
      release = r;
    });
    const restored = runner.restoreSnapshot('00000000-0000-4000-8000-000000000001', 'test');
    // The engine fails while the snapshot is being read.
    runner.sim.step = () => {
      throw new Error('engine exploded');
    };
    await waitFor(() => runner.summary().status === 'halted');
    release();
    expect(await restored).toMatchObject({ status: 'paused', tick: 3, haltReason: null });
    expect(store.rewinds).toHaveLength(1);
    expect(store.rewinds[0]!.halt?.reason).toMatch(/Engine error at tick \d+: engine exploded/);
    expect(store.rewinds[0]!.audit.action).toBe('snapshot.restored');
    // The queued recordHalt() found the halt already recorded with the rewind.
    await runner.pause('test');
    expect(store.halts).toBe(0);
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

  it('disconnects a client that stays congested for STALLED_CLIENT_MS', async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const store = new FakeStore();
      const { runner } = makeRunner(store);
      const stream = new CivilizationStream(runner, 60_000, () => undefined, log);
      const reader = new FakeSocket();
      const stalled = new FakeSocket();
      stream.add(reader as unknown as WebSocket);
      stream.add(stalled as unknown as WebSocket);
      stream.frame();

      stalled.bufferedAmount = BACKPRESSURE_BYTES + 1;
      for (const elapsed of [0, STALLED_CLIENT_MS / 2, STALLED_CLIENT_MS - 1]) {
        now = 2_000 + elapsed;
        await runner.step(1, 'test');
        stream.frame();
        expect(stalled.readyState, `after ${elapsed} ms`).toBe(WebSocket.OPEN);
      }
      // Draining resets the clock: congestion must be continuous.
      stalled.bufferedAmount = 0;
      now += 1;
      stream.frame();
      stalled.bufferedAmount = BACKPRESSURE_BYTES + 1;
      const congestedAgain = now + 1;
      for (const at of [congestedAgain, congestedAgain + STALLED_CLIENT_MS - 1]) {
        now = at;
        await runner.step(1, 'test');
        stream.frame();
        expect(stalled.readyState).toBe(WebSocket.OPEN);
      }
      now = congestedAgain + STALLED_CLIENT_MS;
      await runner.step(1, 'test');
      stream.frame();
      expect(stalled.readyState).toBe(WebSocket.CLOSED);
      expect(stream.size).toBe(1);
      expect(reader.readyState).toBe(WebSocket.OPEN);
      stream.close();
    } finally {
      clock.mockRestore();
    }
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
