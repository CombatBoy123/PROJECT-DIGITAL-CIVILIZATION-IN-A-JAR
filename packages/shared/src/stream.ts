import type { Calendar, CitizenFrameTuple, Weather } from '@civ/sim-core';
import type { CivilizationStatus, EventDto } from './api.js';

/*
 * WebSocket protocol (server → client only). Endpoint:
 *   GET /api/civilizations/:id/stream   (token via ?token=… when reads require auth)
 *
 * Frames are sent at most FRAME_RATE times per second regardless of simulation
 * speed. A client first receives `hello` and a `keyframe`; afterwards `delta`
 * frames contain only citizens whose position tuple changed. A client that falls
 * behind (socket buffer full) skips deltas and receives a new keyframe once it has
 * drained, so it never applies a delta to a stale base.
 */

export interface StreamStatus {
  status: CivilizationStatus;
  speed: number;
  tick: number;
  durableTick: number;
  haltReason: string | null;
  lastError: string | null;
}

export type StreamMessage =
  | ({ type: 'hello'; civilizationId: string } & StreamStatus)
  | {
      type: 'keyframe' | 'delta';
      tick: number;
      calendar: Calendar;
      weather: Weather;
      temperatureC: number;
      citizens: CitizenFrameTuple[];
    }
  | { type: 'events'; events: EventDto[]; dropped: number }
  | ({ type: 'status' } & StreamStatus)
  | { type: 'checkpoint'; tick: number }
  /** The world was replaced (restore/reset): refetch layout and lists, then await a keyframe. */
  | { type: 'reset'; tick: number }
  | { type: 'deleted' };

/** Maximum events per `events` message; extra events are counted in `dropped`. */
export const MAX_STREAMED_EVENTS = 200;
