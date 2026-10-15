import type {
  AuditPage,
  AuditQuery,
  BuildingDetail,
  BuildingListItem,
  CitizenDetail,
  CitizenListItem,
  CitizenListQuery,
  CivilizationDetail,
  CivilizationSummary,
  ControlRequest,
  CreateCivilizationRequest,
  EventPage,
  EventQuery,
  LayoutResponse,
  ListResponse,
  MetaResponse,
  MetricSeriesResponse,
  MetricsQuery,
  Page,
  SnapshotDto,
} from '@civ/shared';
import type { BuildingKind } from '@civ/sim-core';
import { request, type QueryParams } from './client';

/*
 * One typed function per REST endpoint (see packages/shared/src/routes.ts). Query
 * hooks and mutations are built on these; nothing else in the app calls fetch for
 * JSON resources.
 */

export interface BuildingListQuery {
  kind?: BuildingKind;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Event query as sent by this client (types as an array instead of CSV). */
export type EventQueryParams = Omit<EventQuery, 'types'> & { types?: readonly string[] };

export type MetricsQueryParams = Omit<MetricsQuery, 'keys'> & { keys?: readonly string[] };

const civ = (id: string) => ({ id });

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),

  listCivilizations: () => request<ListResponse<CivilizationSummary>>('/api/civilizations'),
  createCivilization: (body: CreateCivilizationRequest) =>
    request<CivilizationDetail>('/api/civilizations', { method: 'POST', body }),
  civilization: (id: string) =>
    request<CivilizationDetail>('/api/civilizations/:id', { params: civ(id) }),
  deleteCivilization: (id: string, confirm: string) =>
    request<void>('/api/civilizations/:id', {
      method: 'DELETE',
      params: civ(id),
      body: { confirm },
    }),

  control: (id: string, body: ControlRequest) =>
    request<CivilizationSummary>('/api/civilizations/:id/control', {
      method: 'POST',
      params: civ(id),
      body,
    }),
  setSpeed: (id: string, ticksPerSecond: number) =>
    request<CivilizationSummary>('/api/civilizations/:id/speed', {
      method: 'PUT',
      params: civ(id),
      body: { ticksPerSecond },
    }),
  reset: (id: string, confirm: string) =>
    request<CivilizationSummary>('/api/civilizations/:id/reset', {
      method: 'POST',
      params: civ(id),
      body: { confirm },
    }),

  layout: (id: string) =>
    request<LayoutResponse>('/api/civilizations/:id/layout', { params: civ(id) }),

  citizens: (id: string, query: CitizenListQuery) =>
    request<Page<CitizenListItem>>('/api/civilizations/:id/citizens', {
      params: civ(id),
      query: query as QueryParams,
    }),
  citizen: (id: string, citizenId: number) =>
    request<CitizenDetail>('/api/civilizations/:id/citizens/:citizenId', {
      params: { id, citizenId },
    }),
  buildings: (id: string, query: BuildingListQuery) =>
    request<Page<BuildingListItem>>('/api/civilizations/:id/buildings', {
      params: civ(id),
      query: query as QueryParams,
    }),
  building: (id: string, buildingId: number) =>
    request<BuildingDetail>('/api/civilizations/:id/buildings/:buildingId', {
      params: { id, buildingId },
    }),

  events: (id: string, query: EventQueryParams, signal?: AbortSignal) =>
    request<EventPage>('/api/civilizations/:id/events', {
      params: civ(id),
      query: query as QueryParams,
      signal,
    }),
  metrics: (id: string, query: MetricsQueryParams, signal?: AbortSignal) =>
    request<MetricSeriesResponse>('/api/civilizations/:id/metrics', {
      params: civ(id),
      query: query as QueryParams,
      signal,
    }),

  snapshots: (id: string) =>
    request<ListResponse<SnapshotDto>>('/api/civilizations/:id/snapshots', { params: civ(id) }),
  createSnapshot: (id: string, body: { name: string; note?: string }) =>
    request<SnapshotDto>('/api/civilizations/:id/snapshots', {
      method: 'POST',
      params: civ(id),
      body,
    }),
  restoreSnapshot: (id: string, snapshotId: string, confirm: string) =>
    request<CivilizationSummary>('/api/civilizations/:id/snapshots/:snapshotId/restore', {
      method: 'POST',
      params: { id, snapshotId },
      body: { confirm },
    }),

  audit: (id: string, query: AuditQuery) =>
    request<AuditPage>('/api/civilizations/:id/audit', {
      params: civ(id),
      query: query as QueryParams,
    }),
};
