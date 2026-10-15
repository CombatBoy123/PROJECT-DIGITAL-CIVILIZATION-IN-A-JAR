/*
 * REST route table: the single list of HTTP endpoints, shared by the server (which
 * registers exactly these) and the web client (which builds URLs with `apiPath`).
 * All paths are relative to the server origin. See docs/API.md for details.
 *
 * Auth column: `public` needs no token; `read` needs the viewer or operator token
 * when the server requires tokens for reads; `operate` always needs the operator
 * token (unless AUTH_MODE=disabled on a loopback address).
 */

export interface RouteInfo {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: 'public' | 'read' | 'operate';
  summary: string;
}

export const API_ROUTES = [
  {
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    summary: 'Liveness and database reachability',
  },
  {
    method: 'GET',
    path: '/api/meta',
    auth: 'public',
    summary: 'Engine version, auth mode, stream frame rate',
  },
  {
    method: 'GET',
    path: '/api/civilizations',
    auth: 'read',
    summary: 'List civilizations (ListResponse<CivilizationSummary>)',
  },
  {
    method: 'POST',
    path: '/api/civilizations',
    auth: 'operate',
    summary: 'Create a civilization (genesis); 201 CivilizationDetail',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id',
    auth: 'read',
    summary: 'Civilization detail including configuration',
  },
  {
    method: 'DELETE',
    path: '/api/civilizations/:id',
    auth: 'operate',
    summary: 'Delete (body: { confirm: <exact name> }); 204',
  },
  {
    method: 'POST',
    path: '/api/civilizations/:id/control',
    auth: 'operate',
    summary: 'start | pause | step (ControlRequest); CivilizationSummary',
  },
  {
    method: 'PUT',
    path: '/api/civilizations/:id/speed',
    auth: 'operate',
    summary: 'Set ticks per second (0 = max); CivilizationSummary',
  },
  {
    method: 'POST',
    path: '/api/civilizations/:id/reset',
    auth: 'operate',
    summary: 'Regenerate from seed (body: { confirm: <exact name> }); CivilizationSummary',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/layout',
    auth: 'read',
    summary: 'Map, buildings and households (LayoutResponse)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/frame',
    auth: 'read',
    summary: 'Current citizen positions (FrameResponse)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/citizens',
    auth: 'read',
    summary: 'Paginated, filterable citizen list (Page<CitizenListItem>)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/citizens/:citizenId',
    auth: 'read',
    summary: 'Citizen detail (CitizenDetail)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/buildings',
    auth: 'read',
    summary: 'Paginated building list (Page<BuildingListItem>)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/buildings/:buildingId',
    auth: 'read',
    summary: 'Building detail (BuildingDetail)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/events',
    auth: 'read',
    summary: 'Event log, keyset-paginated (EventPage)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/metrics',
    auth: 'read',
    summary: 'Downsampled metric series (MetricSeriesResponse)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/snapshots',
    auth: 'read',
    summary: 'List snapshots (ListResponse<SnapshotDto>)',
  },
  {
    method: 'POST',
    path: '/api/civilizations/:id/snapshots',
    auth: 'operate',
    summary: 'Save a named snapshot; 201 SnapshotDto',
  },
  {
    method: 'POST',
    path: '/api/civilizations/:id/snapshots/:snapshotId/restore',
    auth: 'operate',
    summary:
      'Rewind to a snapshot (body: { confirm: <exact civilization name> }); CivilizationSummary',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/audit',
    auth: 'read',
    summary: 'Control-action audit log, keyset-paginated (AuditPage)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/export/config',
    auth: 'read',
    summary: 'Experiment configuration (ConfigExport, JSON attachment)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/export/metrics.csv',
    auth: 'read',
    summary: 'Raw metric samples as CSV attachment',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/export/events.ndjson',
    auth: 'read',
    summary: 'Event log as NDJSON attachment (streamed)',
  },
  {
    method: 'GET',
    path: '/api/civilizations/:id/stream',
    auth: 'read',
    summary: 'WebSocket: status, keyframe/delta frames, live events (see stream.ts)',
  },
] as const satisfies readonly RouteInfo[];

export type ApiRoutePath = (typeof API_ROUTES)[number]['path'];

/**
 * Fill `:param` placeholders of a route path. Values are URI-encoded.
 *   apiPath('/api/civilizations/:id/citizens/:citizenId', { id, citizenId: 7 })
 */
export function apiPath(path: ApiRoutePath, params: Record<string, string | number> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`apiPath: missing parameter "${name}" for ${path}`);
    return encodeURIComponent(String(value));
  });
}
