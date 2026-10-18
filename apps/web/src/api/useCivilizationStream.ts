import type { EventDto, StreamStatus } from '@civ/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FrameStore, type FrameHeader } from '../world/frame-store';
import { throttle } from '../lib/throttle';
import { invalidateProjections, invalidateWorld, queryKeys } from './queries';
import { StreamClient, type ConnectionState } from './stream';
import { getToken, subscribeToken } from './token';

/*
 * React binding of the stream client for one civilization: owns the FrameStore,
 * keeps the latest status, refreshes queries on checkpoint/reset notifications and
 * fans live events out to subscribers (the event feed) without re-rendering the page.
 */

/** Minimum time between two checkpoint-driven refreshes of projection queries. */
const CHECKPOINT_REFRESH_MS = 1_500;

export type LiveEventMessage =
  { kind: 'events'; events: EventDto[]; dropped: number } | { kind: 'reset'; tick: number };

export interface CivilizationStream {
  frames: FrameStore;
  status: StreamStatus | null;
  connection: ConnectionState;
  /** Latest frame header (tick, calendar, weather), null until the first keyframe. */
  header: FrameHeader | null;
  /** Subscribe to live events and world resets; returns an unsubscribe function. */
  subscribeLive: (listener: (message: LiveEventMessage) => void) => () => void;
}

function sameHeader(a: FrameHeader | null, b: FrameHeader | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.tick === b.tick && a.weather === b.weather && a.temperatureC === b.temperatureC;
}

export function useToken(): string | null {
  return useSyncExternalStore(subscribeToken, getToken, getToken);
}

export function useCivilizationStream(
  civilizationId: string,
  options: { onDeleted?: () => void } = {},
): CivilizationStream {
  const qc = useQueryClient();
  const token = useToken();
  // Callers remount (key) per civilization, so one store per hook instance never mixes worlds.
  const [frames] = useState(() => new FrameStore());
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [header, setHeader] = useState<FrameHeader | null>(null);
  const listeners = useRef(new Set<(message: LiveEventMessage) => void>());
  const onDeletedRef = useRef(options.onDeleted);
  useEffect(() => {
    onDeletedRef.current = options.onDeleted;
  }, [options.onDeleted]);

  // Mirror the frame header into React state (only when it actually changes).
  useEffect(() => {
    const update = () => {
      const s = frames.state;
      const next: FrameHeader | null = s
        ? { tick: s.tick, calendar: s.calendar, weather: s.weather, temperatureC: s.temperatureC }
        : null;
      setHeader((prev) => (sameHeader(prev, next) ? prev : next));
    };
    update();
    return frames.subscribe(update);
  }, [frames]);

  useEffect(() => {
    const emit = (message: LiveEventMessage) => {
      for (const listener of listeners.current) listener(message);
    };
    const refresh = throttle(
      () => invalidateProjections(qc, civilizationId),
      CHECKPOINT_REFRESH_MS,
    );
    const client = new StreamClient({
      civilizationId,
      store: frames,
      getToken,
      onConnection: setConnection,
      callbacks: {
        onStatus: (s) => {
          setStatus(s);
          // Keep the cached detail (used before the stream connects) in step.
          qc.setQueryData(queryKeys.detail(civilizationId), (old: object | undefined) =>
            old ? { ...old, ...s } : old,
          );
        },
        onEvents: (events, dropped) => emit({ kind: 'events', events, dropped }),
        onCheckpoint: (tick) => {
          setStatus((prev) =>
            prev ? { ...prev, durableTick: Math.max(prev.durableTick, tick) } : prev,
          );
          refresh();
        },
        onReset: (tick) => {
          emit({ kind: 'reset', tick });
          invalidateWorld(qc, civilizationId);
        },
        onDeleted: () => onDeletedRef.current?.(),
      },
    });
    client.start();
    return () => {
      refresh.cancel();
      client.stop();
    };
  }, [civilizationId, frames, qc, token]);

  const subscribeLive = useMemo(
    () => (listener: (message: LiveEventMessage) => void) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
    [],
  );

  return { frames, status, connection, header, subscribeLive };
}
