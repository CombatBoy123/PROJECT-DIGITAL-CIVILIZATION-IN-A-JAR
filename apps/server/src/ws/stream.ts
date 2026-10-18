import {
  buildFrame,
  type CitizenFrameTuple,
  type SimEvent,
  type Simulation,
  type WorldFrame,
} from '@civ/sim-core';
import {
  CivilizationParamsSchema,
  MAX_STREAMED_EVENTS,
  type EventDto,
  type StreamMessage,
  type StreamStatus,
} from '@civ/shared';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { AppError, parseInput } from '../http/errors.js';
import type { AppContext } from '../routes/context.js';
import type { RunnerNotice, SimulationRunner } from '../runner/runner.js';

/*
 * Live stream of one civilization (protocol: packages/shared/src/stream.ts).
 *
 * One CivilizationStream per civilization with subscribers. It computes each frame
 * once and broadcasts the same message to every client:
 *  - frames go out at most FRAME_RATE times per second, independent of the
 *    simulation speed; a delta holds only citizens whose CitizenFrameTuple changed
 *    since the previous frame;
 *  - live events are batched per frame (at most MAX_STREAMED_EVENTS per message,
 *    the rest counted in `dropped`);
 *  - status, checkpoint, reset and deleted notices are forwarded immediately.
 *
 * Live events are sent as soon as the engine emits them, before they are durable.
 * A halt (invariant violation) or a restore/reset can roll them back; clients then
 * receive `reset` and must refetch history from the REST API, which only serves
 * durable events.
 *
 * Backpressure: a client whose socket buffer exceeds BACKPRESSURE_BYTES skips
 * deltas and events (counted as dropped); once drained it receives a fresh
 * keyframe, so a delta is never applied to a stale base. A client that stays
 * congested for STALLED_CLIENT_MS is disconnected, so a client that stops reading
 * cannot pin server memory.
 *
 * Connections are capped in total and per client address (STREAM_MAX_CONNECTIONS,
 * STREAM_MAX_CONNECTIONS_PER_ADDRESS): beyond the cap an upgrade is refused with
 * 503 UNAVAILABLE.
 */

/** Socket buffer above which a client is considered congested. */
export const BACKPRESSURE_BYTES = 1 << 20;
/** Continuous congestion after which a client is disconnected. */
export const STALLED_CLIENT_MS = 10_000;
/** Liveness ping interval; clients that miss a pong are terminated. */
const PING_INTERVAL_MS = 30_000;
/** WebSocket close code "Try Again Later" (RFC 6455 registry). */
const CLOSE_TRY_AGAIN_LATER = 1013;

interface Client {
  socket: WebSocket;
  /** Holds the current baseline (has received a keyframe and every delta since). */
  synced: boolean;
  /** Events skipped for this client since its last events message. */
  dropped: number;
  alive: boolean;
  /** When the client's socket buffer last went above BACKPRESSURE_BYTES (null: not congested). */
  congestedSince: number | null;
}

interface Baseline {
  sim: Simulation;
  tick: number;
  tuples: Map<number, CitizenFrameTuple>;
}

function toEventDto(e: SimEvent): EventDto {
  return {
    seq: e.seq,
    tick: e.tick,
    type: e.type,
    payload: e.payload as unknown as Record<string, unknown>,
    refs: e.refs.map((r) => ({ ...r })),
    causeSeq: e.causeSeq,
  };
}

function sameTuple(a: CitizenFrameTuple, b: CitizenFrameTuple): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function frameMessage(
  type: 'keyframe' | 'delta',
  frame: WorldFrame,
  citizens: CitizenFrameTuple[],
) {
  const message: StreamMessage = {
    type,
    tick: frame.tick,
    calendar: frame.calendar,
    weather: frame.weather,
    temperatureC: frame.temperatureC,
    citizens,
  };
  return JSON.stringify(message);
}

function streamStatus(runner: SimulationRunner): StreamStatus {
  const s = runner.summary();
  return {
    status: s.status,
    speed: s.speed,
    tick: s.tick,
    durableTick: s.durableTick,
    haltReason: s.haltReason,
    lastError: s.lastError,
  };
}

export class CivilizationStream {
  private readonly clients = new Set<Client>();
  private baseline: Baseline | null = null;
  private pendingEvents: EventDto[] = [];
  private pendingDropped = 0;
  private lastFrameAt = 0;
  private readonly frameTimer: NodeJS.Timeout;
  private readonly pingTimer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    readonly runner: SimulationRunner,
    private readonly frameIntervalMs: number,
    private readonly onEmpty: () => void,
    private readonly log: FastifyBaseLogger,
  ) {
    this.unsubscribe = runner.subscribe((notice) => this.onNotice(notice));
    this.frameTimer = setInterval(() => this.frame(), frameIntervalMs);
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    const client: Client = { socket, synced: false, dropped: 0, alive: true, congestedSince: null };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.remove(client));
    socket.on('error', (err) => {
      this.log.debug({ err }, 'Stream socket error');
      this.remove(client);
    });
    // Clients only listen; anything they send is ignored.
    this.send(
      client,
      JSON.stringify({
        type: 'hello',
        civilizationId: this.runner.id,
        ...streamStatus(this.runner),
      } satisfies StreamMessage),
    );
    if (this.baselineIsCurrent()) {
      this.sendKeyframe(client, buildFrame(this.runner.sim.state));
    } else if (performance.now() - this.lastFrameAt >= this.frameIntervalMs) {
      this.frame();
    }
    // Otherwise the next frame (within one frame interval) delivers the keyframe.
  }

  /** Stop streaming: close every socket and detach from the runner. */
  close(code = 1001, reason = 'Server shutting down'): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.frameTimer);
    clearInterval(this.pingTimer);
    this.unsubscribe();
    for (const client of this.clients) client.socket.close(code, reason);
    this.clients.clear();
    this.onEmpty();
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0) this.close();
  }

  private baselineIsCurrent(): boolean {
    const b = this.baseline;
    return b !== null && b.sim === this.runner.sim && b.tick === this.runner.sim.tick;
  }

  private send(client: Client, data: string): boolean {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    client.socket.send(data);
    return true;
  }

  private broadcast(message: StreamMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) this.send(client, data);
  }

  private sendKeyframe(client: Client, frame: WorldFrame, data?: string): void {
    if (this.send(client, data ?? frameMessage('keyframe', frame, frame.citizens)))
      client.synced = true;
  }

  private onNotice(notice: RunnerNotice): void {
    switch (notice.type) {
      case 'advanced':
        for (const e of notice.events) {
          if (this.pendingEvents.length >= MAX_STREAMED_EVENTS) {
            // Keep the most recent events; older ones are counted as dropped.
            this.pendingEvents.shift();
            this.pendingDropped++;
          }
          this.pendingEvents.push(toEventDto(e));
        }
        break;
      case 'status':
        this.broadcast({ type: 'status', ...streamStatus(this.runner) });
        break;
      case 'checkpoint':
        this.broadcast({ type: 'checkpoint', tick: notice.tick });
        break;
      case 'reset':
        // Live events of the abandoned timeline are void; every client needs a keyframe.
        this.pendingEvents = [];
        this.pendingDropped = 0;
        this.baseline = null;
        this.broadcast({ type: 'reset', tick: notice.tick });
        this.frame();
        break;
      case 'deleted':
        this.broadcast({ type: 'deleted' });
        this.close(1000, 'Civilization deleted');
        break;
    }
  }

  /** Compute one frame and send it (keyframe, delta or nothing) plus batched events. */
  frame(): void {
    if (this.closed) return;
    this.lastFrameAt = performance.now();
    const sim = this.runner.sim;
    const previous = this.baseline;
    const sameWorld = previous !== null && previous.sim === sim;
    const advanced = !sameWorld || previous.tick !== sim.tick;
    const needsKeyframe = [...this.clients].some((c) => !c.synced);
    if (!advanced && !needsKeyframe && this.pendingEvents.length === 0) return;

    let changed: CitizenFrameTuple[] | null = null;
    let frame: WorldFrame | null = null;
    if (advanced || needsKeyframe) {
      frame = buildFrame(sim.state);
      const tuples = new Map(frame.citizens.map((t) => [t[0], t]));
      let everyoneNeedsKeyframe = !sameWorld;
      if (sameWorld && advanced) {
        changed = [];
        for (const t of frame.citizens) {
          const before = previous.tuples.get(t[0]);
          if (!before || !sameTuple(before, t)) changed.push(t);
        }
        // Deltas cannot express removals: fall back to keyframes.
        for (const id of previous.tuples.keys()) {
          if (!tuples.has(id)) everyoneNeedsKeyframe = true;
        }
      }
      if (everyoneNeedsKeyframe) {
        changed = null;
        for (const client of this.clients) client.synced = false;
      }
      this.baseline = { sim, tick: frame.tick, tuples };
    }

    const events = this.pendingEvents;
    const dropped = this.pendingDropped;
    this.pendingEvents = [];
    this.pendingDropped = 0;
    let keyframeData: string | undefined;
    const deltaData = frame && changed ? frameMessage('delta', frame, changed) : null;

    for (const client of this.clients) {
      const congested = client.socket.bufferedAmount > BACKPRESSURE_BYTES;
      if (congested) {
        client.congestedSince ??= this.lastFrameAt;
        if (this.lastFrameAt - client.congestedSince >= STALLED_CLIENT_MS) {
          this.log.debug('Disconnecting a stalled stream client');
          client.socket.terminate();
          continue;
        }
        // Skip everything; the client resynchronises with a keyframe once drained.
        if (frame && (deltaData || !client.synced)) client.synced = false;
        client.dropped += events.length;
        continue;
      }
      client.congestedSince = null;
      if (frame && !client.synced) {
        keyframeData ??= frameMessage('keyframe', frame, frame.citizens);
        this.sendKeyframe(client, frame, keyframeData);
      } else if (deltaData) {
        this.send(client, deltaData);
      }
      if (events.length > 0 || client.dropped > 0) {
        const message: StreamMessage = {
          type: 'events',
          events,
          dropped: dropped + client.dropped,
        };
        if (this.send(client, JSON.stringify(message))) client.dropped = 0;
      }
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}

export interface StreamLimits {
  maxConnections: number;
  maxConnectionsPerAddress: number;
}

/** All live streams of this server, one per civilization with subscribers. */
export class StreamHub {
  private readonly streams = new Map<string, CivilizationStream>();
  private connections = 0;
  private readonly perAddress = new Map<string, number>();

  constructor(
    private readonly frameRate: number,
    private readonly log: FastifyBaseLogger,
    private readonly limits: StreamLimits,
  ) {}

  /** Open stream connections (all civilizations). */
  get connectionCount(): number {
    return this.connections;
  }

  /** Throws UNAVAILABLE when another connection from `address` would exceed a cap. */
  assertCapacity(address: string): void {
    if (this.connections >= this.limits.maxConnections) {
      throw new AppError('UNAVAILABLE', 'Too many live stream connections; try again later');
    }
    if ((this.perAddress.get(address) ?? 0) >= this.limits.maxConnectionsPerAddress) {
      throw new AppError(
        'UNAVAILABLE',
        'Too many live stream connections from this address; close other streams first',
      );
    }
  }

  /**
   * Subscribe an upgraded socket. The caps are re-checked here (the upgrade happens
   * after the pre-upgrade check), and a socket beyond them is closed with 1013.
   */
  attach(runner: SimulationRunner, socket: WebSocket, address: string): void {
    try {
      this.assertCapacity(address);
    } catch {
      socket.close(CLOSE_TRY_AGAIN_LATER, 'Too many stream connections');
      return;
    }
    this.connections++;
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
    socket.once('close', () => {
      this.connections--;
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left > 0) this.perAddress.set(address, left);
      else this.perAddress.delete(address);
    });

    let stream = this.streams.get(runner.id);
    if (!stream || stream.runner !== runner) {
      stream?.close();
      const created: CivilizationStream = new CivilizationStream(
        runner,
        Math.round(1000 / this.frameRate),
        () => {
          if (this.streams.get(runner.id) === created) this.streams.delete(runner.id);
        },
        this.log.child({ civilizationId: runner.id }),
      );
      stream = created;
      this.streams.set(runner.id, stream);
    }
    stream.add(socket);
  }

  closeAll(): void {
    for (const stream of [...this.streams.values()]) stream.close();
  }
}

/** The runner resolved during preValidation, handed to the WebSocket handler. */
const resolvedRunners = new WeakMap<FastifyRequest, SimulationRunner>();

/**
 * GET /api/civilizations/:id/stream. Authentication runs in the global onRequest
 * hook (token via `?token=` because browsers cannot set WebSocket headers). The
 * civilization is resolved before the upgrade, so unknown ids get a plain 404.
 */
export function registerStreamRoute(app: FastifyInstance, ctx: AppContext): StreamHub {
  const hub = new StreamHub(ctx.env.FRAME_RATE, app.log, {
    maxConnections: ctx.env.STREAM_MAX_CONNECTIONS,
    maxConnectionsPerAddress: ctx.env.STREAM_MAX_CONNECTIONS_PER_ADDRESS,
  });
  app.route({
    method: 'GET',
    url: '/api/civilizations/:id/stream',
    preValidation: async (request) => {
      const { id } = parseInput(CivilizationParamsSchema, request.params, 'path');
      // Before loading the civilization, so refused connections cost nothing.
      hub.assertCapacity(request.ip);
      resolvedRunners.set(request, await ctx.runners.get(id));
    },
    handler: async () => {
      throw new AppError('VALIDATION_ERROR', 'This endpoint requires a WebSocket upgrade');
    },
    wsHandler: (socket, request) => {
      const runner = resolvedRunners.get(request);
      if (!runner) {
        socket.close(1011, 'Civilization not resolved');
        return;
      }
      hub.attach(runner, socket, request.ip);
    },
  });
  app.addHook('onClose', async () => hub.closeAll());
  return hub;
}
