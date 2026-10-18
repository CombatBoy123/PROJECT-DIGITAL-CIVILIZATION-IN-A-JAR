import type { StreamMessage } from '@civ/shared';
import type { CitizenFrameTuple } from '@civ/sim-core';
import { describe, expect, it, vi } from 'vitest';
import { FrameStore } from '../world/frame-store';
import { backoffDelay, handleStreamMessage, parseStreamMessage, streamUrl } from './stream';

const calendar = {
  tick: 0,
  day: 1,
  hour: 0,
  dayOfSeason: 0,
  dayOfYear: 0,
  season: 'spring',
  year: 1,
} as const;

function frame(
  type: 'keyframe' | 'delta',
  tick: number,
  citizens: CitizenFrameTuple[],
): StreamMessage {
  return {
    type,
    tick,
    calendar: { ...calendar, tick },
    weather: 'clear',
    temperatureC: 10,
    citizens,
  };
}

const status = {
  status: 'running',
  speed: 10,
  tick: 5,
  durableTick: 3,
  haltReason: null,
  lastError: null,
} as const;

describe('handleStreamMessage', () => {
  it('applies a keyframe and then a delta', () => {
    const store = new FrameStore();
    handleStreamMessage(
      frame('keyframe', 10, [
        [1, 0, 5, 0, 0, 0, 0],
        [2, 1, 6, 0, 0, 0, 0],
      ]),
      store,
      100,
    );
    handleStreamMessage(frame('delta', 11, [[2, 3, 0, 6, 7, 11, 13]]), store, 200);
    const state = store.state;
    expect(state?.tick).toBe(11);
    expect(state?.receivedAt).toBe(200);
    expect(state?.citizens.get(1)).toEqual([1, 0, 5, 0, 0, 0, 0]);
    expect(state?.citizens.get(2)).toEqual([2, 3, 0, 6, 7, 11, 13]);
  });

  it('ignores a delta that arrives before any keyframe', () => {
    const store = new FrameStore();
    handleStreamMessage(frame('delta', 11, [[2, 3, 0, 6, 7, 11, 13]]), store, 100);
    expect(store.ready).toBe(false);
    expect(store.state).toBeNull();
  });

  it('clears the store on reset and waits for the next keyframe', () => {
    const store = new FrameStore();
    const onReset = vi.fn();
    handleStreamMessage(frame('keyframe', 10, [[1, 0, 5, 0, 0, 0, 0]]), store, 100);
    handleStreamMessage({ type: 'reset', tick: 0 }, store, 150, { onReset });
    expect(store.ready).toBe(false);
    expect(onReset).toHaveBeenCalledWith(0);
    handleStreamMessage(frame('delta', 1, [[1, 1, 5, 0, 0, 0, 0]]), store, 160);
    expect(store.ready).toBe(false);
    handleStreamMessage(frame('keyframe', 0, [[1, 0, 5, 0, 0, 0, 0]]), store, 170);
    expect(store.state?.tick).toBe(0);
  });

  it('marks the store running from status messages and forwards status', () => {
    const store = new FrameStore();
    const onStatus = vi.fn();
    handleStreamMessage({ type: 'hello', civilizationId: 'x', ...status }, store, 0, { onStatus });
    expect(onStatus).toHaveBeenCalledWith(status);
    // Running: two frames one tick apart 100 ms apart give a positive rate.
    handleStreamMessage(frame('keyframe', 1, []), store, 0);
    handleStreamMessage(frame('delta', 2, []), store, 100);
    expect(store.state?.ticksPerMs).toBeCloseTo(0.01);
    handleStreamMessage({ type: 'status', ...status, status: 'paused' }, store, 150, { onStatus });
    expect(store.state?.ticksPerMs).toBe(0);
  });

  it('forwards events, checkpoints and deletion', () => {
    const store = new FrameStore();
    const onEvents = vi.fn();
    const onCheckpoint = vi.fn();
    const onDeleted = vi.fn();
    const cb = { onEvents, onCheckpoint, onDeleted };
    handleStreamMessage({ type: 'events', events: [], dropped: 2 }, store, 0, cb);
    handleStreamMessage({ type: 'checkpoint', tick: 42 }, store, 0, cb);
    handleStreamMessage({ type: 'deleted' }, store, 0, cb);
    expect(onEvents).toHaveBeenCalledWith([], 2);
    expect(onCheckpoint).toHaveBeenCalledWith(42);
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});

describe('parseStreamMessage', () => {
  it('accepts known messages and rejects garbage', () => {
    expect(parseStreamMessage('{"type":"checkpoint","tick":3}')).toEqual({
      type: 'checkpoint',
      tick: 3,
    });
    expect(parseStreamMessage('not json')).toBeNull();
    expect(parseStreamMessage('{"type":"unknown"}')).toBeNull();
    expect(parseStreamMessage('{"type":"delta","tick":1}')).toBeNull();
    expect(parseStreamMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('streamUrl and backoff', () => {
  it('builds same-origin ws(s) URLs with an optional token', () => {
    expect(streamUrl('abc', null, { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/civilizations/abc/stream',
    );
    expect(streamUrl('abc', 't o', { protocol: 'https:', host: 'lab.example' })).toBe(
      'wss://lab.example/api/civilizations/abc/stream?token=t%20o',
    );
  });

  it('backs off exponentially with a cap', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(500);
    expect(backoffDelay(1, mid)).toBe(1000);
    expect(backoffDelay(3, mid)).toBe(4000);
    expect(backoffDelay(20, mid)).toBe(15000);
  });
});
