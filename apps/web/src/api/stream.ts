import { apiPath, type EventDto, type StreamMessage, type StreamStatus } from '@civ/shared';
import type { FrameStore } from '../world/frame-store';

/*
 * WebSocket client for a civilization's live stream (see packages/shared/src/stream.ts).
 *
 * `handleStreamMessage` is the pure protocol step: it applies frames to a FrameStore
 * and forwards everything else to callbacks. `StreamClient` owns the socket lifecycle:
 * same-origin URL, optional ?token=, and reconnection with exponential backoff. After
 * a reconnect the server sends a fresh keyframe, so the store never applies a delta
 * to a stale base.
 */

export interface StreamCallbacks {
  /** `hello` and `status` messages. */
  onStatus?: (status: StreamStatus) => void;
  onEvents?: (events: EventDto[], dropped: number) => void;
  /** A checkpoint up to `tick` became durable. */
  onCheckpoint?: (tick: number) => void;
  /** The world was replaced (reset or restore); a keyframe follows. */
  onReset?: (tick: number) => void;
  onDeleted?: () => void;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

const MESSAGE_TYPES = new Set([
  'hello',
  'keyframe',
  'delta',
  'events',
  'status',
  'checkpoint',
  'reset',
  'deleted',
]);

/** Parse a raw socket payload. Returns null for anything that is not a known message. */
export function parseStreamMessage(data: unknown): StreamMessage | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) return null;
  if (
    (type === 'keyframe' || type === 'delta') &&
    !Array.isArray((value as { citizens?: unknown }).citizens)
  )
    return null;
  if (type === 'events' && !Array.isArray((value as { events?: unknown }).events)) return null;
  return value as StreamMessage;
}

function statusOf(msg: StreamStatus): StreamStatus {
  return {
    status: msg.status,
    speed: msg.speed,
    tick: msg.tick,
    durableTick: msg.durableTick,
    haltReason: msg.haltReason,
    lastError: msg.lastError,
  };
}

/**
 * Apply one stream message. Frames go into the store (timestamped with `now`, the
 * same clock the renderer uses); a delta before the first keyframe is ignored by
 * the store. Other messages are forwarded to the callbacks.
 */
export function handleStreamMessage(
  msg: StreamMessage,
  store: FrameStore,
  now: number,
  callbacks: StreamCallbacks = {},
): void {
  switch (msg.type) {
    case 'hello':
    case 'status':
      store.setRunning(msg.status === 'running');
      callbacks.onStatus?.(statusOf(msg));
      return;
    case 'keyframe':
    case 'delta': {
      const header = {
        tick: msg.tick,
        calendar: msg.calendar,
        weather: msg.weather,
        temperatureC: msg.temperatureC,
      };
      if (msg.type === 'keyframe') store.applyKeyframe(header, msg.citizens, now);
      else store.applyDelta(header, msg.citizens, now);
      return;
    }
    case 'events':
      callbacks.onEvents?.(msg.events, msg.dropped);
      return;
    case 'checkpoint':
      callbacks.onCheckpoint?.(msg.tick);
      return;
    case 'reset':
      store.clear();
      callbacks.onReset?.(msg.tick);
      return;
    case 'deleted':
      callbacks.onDeleted?.();
      return;
  }
}

/** Same-origin ws(s):// URL of the stream endpoint. */
export function streamUrl(
  civilizationId: string,
  token: string | null,
  location: Pick<Location, 'protocol' | 'host'>,
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = apiPath('/api/civilizations/:id/stream', { id: civilizationId });
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${scheme}//${location.host}${path}${query}`;
}

/** Reconnect delay: 0.5 s doubling per attempt, capped at 15 s, with ±20 % jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface StreamClientOptions {
  civilizationId: string;
  store: FrameStore;
  callbacks: StreamCallbacks;
  getToken: () => string | null;
  onConnection?: (state: ConnectionState) => void;
  now?: () => number;
}

export class StreamClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly options: StreamClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect('connecting');
  }

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.options.onConnection?.('closed');
  }

  private connect(state: ConnectionState): void {
    if (this.stopped) return;
    this.options.onConnection?.(state);
    const url = streamUrl(this.options.civilizationId, this.options.getToken(), window.location);
    const socket = new WebSocket(url);
    this.socket = socket;
    const now = this.options.now ?? (() => performance.now());

    socket.onopen = () => {
      this.attempt = 0;
      this.options.onConnection?.('open');
    };
    socket.onmessage = (event: MessageEvent) => {
      const msg = parseStreamMessage(event.data);
      if (!msg) return;
      handleStreamMessage(msg, this.options.store, now(), this.options.callbacks);
      if (msg.type === 'deleted') this.stop();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // An error is always followed by close; reconnection happens there.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.options.onConnection?.('reconnecting');
    const delay = backoffDelay(this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect('reconnecting');
    }, delay);
  }
}
