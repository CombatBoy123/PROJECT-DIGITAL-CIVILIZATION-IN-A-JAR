import { timingSafeEqual } from 'node:crypto';
import { API_ROUTES, type RouteInfo } from '@civ/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { AppError } from '../http/errors.js';

/*
 * Authentication and authorisation.
 *
 * Roles: `viewer` may read; `operator` may also mutate (create, control, snapshot,
 * restore, reset, delete). In AUTH_MODE=disabled — permitted only on a loopback
 * address — every request acts as the `local-dev` operator, but only requests
 * addressed to a loopback host from a loopback (or CORS_ORIGINS) origin are served,
 * so a web page cannot reach the server through DNS rebinding.
 *
 * The access level of a request comes from the route it was matched to (the `auth`
 * column of API_ROUTES), never from the raw URL: the router decodes and normalises
 * the path (`/%61pi/…` reaches `/api/…`), so string tests on `request.url` can be
 * bypassed. Routes under /api that are missing from API_ROUTES require the operator.
 *
 * Tokens are sent as `Authorization: Bearer <token>`. Browsers cannot set headers on
 * WebSocket connections, so WebSocket upgrades of the stream route also accept
 * `?token=` (redacted from logs); no other request reads a token from the URL.
 */

export type Role = 'viewer' | 'operator';

export interface Principal {
  role: Role;
  /** Recorded in the audit log. */
  actor: 'operator' | 'viewer' | 'anonymous' | 'local-dev';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export type RouteAccess = RouteInfo['auth'];

const ROUTE_ACCESS = new Map<string, RouteAccess>(
  API_ROUTES.map((r) => [`${r.method} ${r.path}`, r.auth]),
);

/** The only route that accepts `?token=` (WebSocket upgrades only). */
const STREAM_ROUTE = '/api/civilizations/:id/stream';

/**
 * Access a request needs, from its matched route pattern (`request.routeOptions.url`).
 * Unmatched requests (undefined) only reach the not-found handler. HEAD uses the GET
 * entry. Unlisted routes under /api fail closed (`operate`); other routes (the static
 * web app) are public.
 */
export function requiredAccess(method: string, routeUrl: string | undefined): RouteAccess {
  if (routeUrl === undefined) return 'public';
  const listed = ROUTE_ACCESS.get(`${method === 'HEAD' ? 'GET' : method} ${routeUrl}`);
  if (listed) return listed;
  return routeUrl === '/api' || routeUrl.startsWith('/api/') ? 'operate' : 'public';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === 'websocket';
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  if (
    request.method === 'GET' &&
    request.routeOptions.url === STREAM_ROUTE &&
    isWebSocketUpgrade(request)
  ) {
    const query = request.query as Record<string, unknown> | undefined;
    if (typeof query?.token === 'string') return query.token;
  }
  return null;
}

export function resolvePrincipal(env: Env, token: string | null): Principal | null {
  if (env.AUTH_MODE === 'disabled') return { role: 'operator', actor: 'local-dev' };
  if (token && env.OPERATOR_TOKEN && safeEqual(token, env.OPERATOR_TOKEN))
    return { role: 'operator', actor: 'operator' };
  if (token && env.VIEWER_TOKEN && safeEqual(token, env.VIEWER_TOKEN))
    return { role: 'viewer', actor: 'viewer' };
  if (token) return null; // a token was presented but is wrong
  return env.VIEWER_TOKEN ? null : { role: 'viewer', actor: 'anonymous' };
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 and ::1 (as written in a Host header or URL). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return octets !== null && octets.slice(1).every((o) => Number(o) <= 255);
}

/** Whether a Host header names a loopback host (with an optional port); strict syntax. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  return match?.[1] !== undefined && isLoopbackHostname(match[1]);
}

/** Whether a browser Origin may use a server in AUTH_MODE=disabled. */
export function isTrustedLocalOrigin(origin: string, allowed: readonly string[]): boolean {
  if (allowed.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque origin "null"
  }
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname)
  );
}

/**
 * AUTH_MODE=disabled trusts every request, which is only safe for requests that
 * come from this machine. Binding to loopback keeps other machines out, but a page
 * in the developer's browser can rebind its own host name to 127.0.0.1 and then send
 * same-origin requests (CORS does not apply). Such requests carry the attacker's
 * host name in `Host` (and `Origin`), so both are checked.
 */
function assertLocalRequest(request: FastifyRequest, env: Env): void {
  if (!isLoopbackHostHeader(request.headers.host)) {
    throw new AppError(
      'FORBIDDEN',
      'With AUTH_MODE=disabled the server only answers requests addressed to a loopback host (localhost, 127.0.0.1 or [::1])',
    );
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !isTrustedLocalOrigin(origin, env.CORS_ORIGINS)) {
    throw new AppError(
      'FORBIDDEN',
      'With AUTH_MODE=disabled the server only accepts browser requests from loopback origins or CORS_ORIGINS',
    );
  }
}

export function registerAuth(app: FastifyInstance, env: Env): void {
  app.decorateRequest('principal', null as unknown as Principal);

  app.addHook('onRequest', async (request) => {
    request.principal = { role: 'viewer', actor: 'anonymous' };
    if (env.AUTH_MODE === 'disabled') assertLocalRequest(request, env);
    // CORS preflights carry no credentials; @fastify/cors answers them.
    if (request.method === 'OPTIONS') return;
    const access = requiredAccess(request.method, request.routeOptions.url);
    if (access === 'public') return;

    const token = extractToken(request);
    const principal = resolvePrincipal(env, token);
    if (!principal) {
      throw new AppError(
        'UNAUTHORIZED',
        token ? 'Invalid token' : 'A token is required to read this server',
      );
    }
    if (access === 'operate' && principal.role !== 'operator') {
      throw new AppError(
        principal.actor === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN',
        'Operator token required for this action',
      );
    }
    request.principal = principal;
  });
}
