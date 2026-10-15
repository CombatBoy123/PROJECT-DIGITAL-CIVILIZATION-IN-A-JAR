import type { CitizenListQuery, CivilizationSummary } from '@civ/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { ApiError } from './client';
import {
  api,
  type BuildingListQuery,
  type EventQueryParams,
  type MetricsQueryParams,
} from './endpoints';

/*
 * React Query keys and hooks, one per resource. All keys of a civilization start
 * with ['civ', id] so that stream notifications can invalidate exactly the
 * projection-backed or history-backed queries they affect.
 */

export const queryKeys = {
  meta: ['meta'] as const,
  civilizations: ['civilizations'] as const,
  civ: (id: string) => ['civ', id] as const,
  detail: (id: string) => ['civ', id, 'detail'] as const,
  layout: (id: string) => ['civ', id, 'layout'] as const,
  citizens: (id: string, q?: CitizenListQuery) =>
    q ? (['civ', id, 'citizens', q] as const) : (['civ', id, 'citizens'] as const),
  citizen: (id: string, citizenId?: number) =>
    citizenId === undefined
      ? (['civ', id, 'citizen'] as const)
      : (['civ', id, 'citizen', citizenId] as const),
  buildings: (id: string, q?: BuildingListQuery) =>
    q ? (['civ', id, 'buildings', q] as const) : (['civ', id, 'buildings'] as const),
  building: (id: string, buildingId?: number) =>
    buildingId === undefined
      ? (['civ', id, 'building'] as const)
      : (['civ', id, 'building', buildingId] as const),
  events: (id: string, q?: object) =>
    q ? (['civ', id, 'events', q] as const) : (['civ', id, 'events'] as const),
  metrics: (id: string, q?: object) =>
    q ? (['civ', id, 'metrics', q] as const) : (['civ', id, 'metrics'] as const),
  snapshots: (id: string) => ['civ', id, 'snapshots'] as const,
  audit: (id: string) => ['civ', id, 'audit'] as const,
};

/** Do not retry client errors (4xx); retry transient failures twice. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

// ---------------------------------------------------------------------------
// Invalidation helpers used by the stream client and mutations

/** Queries backed by projection tables and append-only history (refreshed on checkpoints). */
export function invalidateProjections(qc: QueryClient, id: string): void {
  for (const key of [
    queryKeys.citizens(id),
    queryKeys.citizen(id),
    queryKeys.buildings(id),
    queryKeys.building(id),
    queryKeys.events(id),
    queryKeys.metrics(id),
  ]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** After the world was replaced (reset/restore) everything except the meta data is stale. */
export function invalidateWorld(qc: QueryClient, id: string): void {
  void qc.invalidateQueries({ queryKey: queryKeys.civ(id) });
  void qc.invalidateQueries({ queryKey: queryKeys.civilizations });
}

// ---------------------------------------------------------------------------
// Queries

export function useMeta() {
  return useQuery({ queryKey: queryKeys.meta, queryFn: api.meta, staleTime: 60_000 });
}

export function useCivilizations() {
  return useQuery({
    queryKey: queryKeys.civilizations,
    queryFn: api.listCivilizations,
    // Running civilizations advance in the background; keep the table's ticks current.
    refetchInterval: 5_000,
  });
}

export function useCivilization(id: string) {
  return useQuery({ queryKey: queryKeys.detail(id), queryFn: () => api.civilization(id) });
}

export function useLayout(id: string) {
  return useQuery({
    queryKey: queryKeys.layout(id),
    queryFn: () => api.layout(id),
    staleTime: Infinity,
  });
}

export function useCitizens(id: string, q: CitizenListQuery) {
  return useQuery({
    queryKey: queryKeys.citizens(id, q),
    queryFn: () => api.citizens(id, q),
    placeholderData: keepPreviousData,
  });
}

export function useCitizen(id: string, citizenId: number | null) {
  return useQuery({
    queryKey: queryKeys.citizen(id, citizenId ?? 0),
    queryFn: () => api.citizen(id, citizenId as number),
    enabled: citizenId !== null,
  });
}

export function useBuildings(id: string, q: BuildingListQuery) {
  return useQuery({
    queryKey: queryKeys.buildings(id, q),
    queryFn: () => api.buildings(id, q),
    placeholderData: keepPreviousData,
  });
}

export function useBuilding(id: string, buildingId: number | null) {
  return useQuery({
    queryKey: queryKeys.building(id, buildingId ?? 0),
    queryFn: () => api.building(id, buildingId as number),
    enabled: buildingId !== null,
  });
}

/** Newest-first event history with "load older" pagination (keyset cursor `before`). */
export function useEventHistory(
  id: string,
  q: Omit<EventQueryParams, 'before' | 'after'>,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.events(id, { ...q, mode: 'history' }),
    queryFn: ({ pageParam, signal }) =>
      api.events(id, { ...q, before: pageParam ?? undefined }, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

/** A single page of events (e.g. all SeasonStarted events in a chart range). */
export function useEventsPage(id: string, q: EventQueryParams, enabled = true) {
  return useQuery({
    queryKey: queryKeys.events(id, { ...q, mode: 'page' }),
    queryFn: ({ signal }) => api.events(id, q, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMetrics(id: string, q: MetricsQueryParams, enabled = true) {
  return useQuery({
    queryKey: queryKeys.metrics(id, q),
    queryFn: ({ signal }) => api.metrics(id, q, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useSnapshots(id: string) {
  return useQuery({ queryKey: queryKeys.snapshots(id), queryFn: () => api.snapshots(id) });
}

export function useAudit(id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(id),
    queryFn: ({ pageParam }) => api.audit(id, { before: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

// ---------------------------------------------------------------------------
// Mutations

/** Store a fresh summary returned by a control endpoint into the cached detail. */
function mergeSummary(qc: QueryClient, summary: CivilizationSummary): void {
  qc.setQueryData(queryKeys.detail(summary.id), (old: CivilizationSummary | undefined) =>
    old ? { ...old, ...summary } : old,
  );
  void qc.invalidateQueries({ queryKey: queryKeys.civilizations });
}

export function useControl(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.control>[1]) => api.control(id, body),
    onSuccess: (summary) => {
      mergeSummary(qc, summary);
      void qc.invalidateQueries({ queryKey: queryKeys.audit(id) });
    },
  });
}

export function useSetSpeed(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ticksPerSecond: number) => api.setSpeed(id, ticksPerSecond),
    onSuccess: (summary) => mergeSummary(qc, summary),
  });
}

export function useResetWorld(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) => api.reset(id, confirm),
    onSuccess: (summary) => {
      mergeSummary(qc, summary);
      invalidateWorld(qc, id);
    },
  });
}

export function useCreateSnapshot(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; note?: string }) => api.createSnapshot(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.snapshots(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.audit(id) });
    },
  });
}

export function useRestoreSnapshot(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { snapshotId: string; confirm: string }) =>
      api.restoreSnapshot(id, v.snapshotId, v.confirm),
    onSuccess: (summary) => {
      mergeSummary(qc, summary);
      invalidateWorld(qc, id);
    },
  });
}

export function useDeleteCivilization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; confirm: string }) => api.deleteCivilization(v.id, v.confirm),
    onSuccess: (_data, v) => {
      qc.removeQueries({ queryKey: queryKeys.civ(v.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.civilizations });
    },
  });
}

export function useCreateCivilization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createCivilization,
    onSuccess: (detail) => {
      qc.setQueryData(queryKeys.detail(detail.id), detail);
      void qc.invalidateQueries({ queryKey: queryKeys.civilizations });
    },
  });
}
