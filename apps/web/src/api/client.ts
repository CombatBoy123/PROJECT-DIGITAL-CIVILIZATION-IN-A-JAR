import {
  API_ROUTES,
  ERROR_CODES,
  apiPath,
  type ApiRoutePath,
  type ErrorCode,
  type RouteInfo,
} from '@civ/shared';
import { observeResponse } from './access';
import { getToken } from './token';

/*
 * Typed fetch wrapper for the REST API. Every request goes through `request`, which
 * builds the URL from the shared route table, attaches the bearer token when the user
 * has entered one, turns error responses into an ApiError carrying the server's
 * { code, message, details }, and reports each answer to the access store (which
 * learns from it whether the token is an operator, viewer or rejected token).
 */

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly (string | number)[]>;

/** Error returned by the API (or synthesised for network/parse failures). */
export class ApiError extends Error {
  constructor(
    /** HTTP status (0 when the request never reached the server). */
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when an (operator) token is missing or rejected. */
  get isAuthError(): boolean {
    return this.code === 'UNAUTHORIZED' || this.code === 'FORBIDDEN';
  }
}

/** A field-level validation issue as reported by the server in `details`. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** Extract `[{ path, message }]` validation issues from an error's details, if present. */
export function fieldIssues(error: unknown): FieldIssue[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details.flatMap((d: unknown) => {
    if (typeof d !== 'object' || d === null) return [];
    const { path, message } = d as Record<string, unknown>;
    if (typeof message !== 'string') return [];
    const p = Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : '';
    return [{ path: p, message }];
  });
}

/** Human-readable one-liner for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const hint =
      error.code === 'UNAUTHORIZED'
        ? ' — enter a valid access token.'
        : error.code === 'FORBIDDEN'
          ? ' — this action needs the operator token.'
          : '';
    return `${error.code}: ${error.message}${hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const KNOWN_CODES = new Set<string>(ERROR_CODES);

/** Parse an error response body into an ApiError (tolerates non-JSON bodies). */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // fall through to a generic error
  }
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  if (err && typeof err.message === 'string') {
    const code =
      typeof err.code === 'string' && KNOWN_CODES.has(err.code)
        ? (err.code as ErrorCode)
        : response.status >= 500
          ? 'INTERNAL'
          : 'VALIDATION_ERROR';
    return new ApiError(response.status, code, err.message, err.details);
  }
  const fallback: ErrorCode =
    response.status === 401
      ? 'UNAUTHORIZED'
      : response.status === 403
        ? 'FORBIDDEN'
        : response.status === 404
          ? 'NOT_FOUND'
          : 'INTERNAL';
  return new ApiError(
    response.status,
    fallback,
    `HTTP ${response.status} ${response.statusText}`.trim(),
  );
}

/** Serialise query parameters, skipping undefined/null/empty values. Arrays become CSV. */
export function buildQuery(params: QueryParams | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | number>;
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
}

/** Build the request URL for a route. */
export function routeUrl(
  path: ApiRoutePath,
  params?: Record<string, string | number>,
  query?: QueryParams,
): string {
  return apiPath(path, params) + buildQuery(query);
}

const ROUTE_AUTH = new Map<string, RouteInfo['auth']>(
  API_ROUTES.map((r) => [`${r.method} ${r.path}`, r.auth]),
);

function headers(hasBody: boolean, token: string | null): Headers {
  const h = new Headers({ Accept: 'application/json' });
  if (hasBody) h.set('Content-Type', 'application/json');
  if (token) h.set('Authorization', `Bearer ${token}`);
  return h;
}

/** Perform a request and return the raw Response (for downloads). Throws ApiError on failure. */
export async function requestRaw(path: ApiRoutePath, options: RequestOptions = {}) {
  const hasBody = options.body !== undefined;
  const method = options.method ?? 'GET';
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(routeUrl(path, options.params, options.query), {
      method,
      headers: headers(hasBody, token),
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached.');
  }
  observeResponse(token, ROUTE_AUTH.get(`${method} ${path}`), response.status);
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

/** Perform a JSON request. 204 responses resolve to undefined. */
export async function request<T>(path: ApiRoutePath, options: RequestOptions = {}): Promise<T> {
  const response = await requestRaw(path, options);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, 'INTERNAL', 'The server sent an unreadable response.');
  }
}
