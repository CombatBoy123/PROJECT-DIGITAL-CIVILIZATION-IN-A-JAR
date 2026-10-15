import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { AppError } from '../http/errors.js';

/*
 * Authentication and authorisation.
 *
 * Roles: `viewer` may read; `operator` may also mutate (create, control, snapshot,
 * restore, reset, delete). In AUTH_MODE=disabled — permitted only on a loopback
 * address — every request acts as the `local-dev` operator.
 *
 * Tokens are sent as `Authorization: Bearer <token>`. Browsers cannot set headers on
 * WebSocket connections, so the stream endpoint also accepts `?token=` (redacted
 * from logs).
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

const PUBLIC_PATHS = new Set(['/api/health', '/api/meta']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const query = request.query as Record<string, unknown> | undefined;
  if (request.url.includes('/stream') && typeof query?.token === 'string') return query.token;
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

export function registerAuth(app: FastifyInstance, env: Env): void {
  app.decorateRequest('principal', null as unknown as Principal);

  app.addHook('onRequest', async (request) => {
    request.principal = { role: 'viewer', actor: 'anonymous' };
    // CORS preflights carry no credentials; @fastify/cors answers them.
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;

    const token = extractToken(request);
    const principal = resolvePrincipal(env, token);
    if (!principal) {
      throw new AppError(
        'UNAUTHORIZED',
        token ? 'Invalid token' : 'A token is required to read this server',
      );
    }
    const mutating =
      request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    if (mutating && principal.role !== 'operator') {
      throw new AppError(
        principal.actor === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN',
        'Operator token required for this action',
      );
    }
    request.principal = principal;
  });
}
