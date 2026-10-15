import { resolve } from 'node:path';
import type { Writable } from 'node:stream';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerAuth } from './auth/auth.js';
import type { Env } from './config/env.js';
import { registerErrorHandling } from './http/errors.js';
import { CivilizationStore } from './persistence/store.js';
import { registerCivilizationRoutes } from './routes/civilizations.js';
import type { AppContext } from './routes/context.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorldRoutes } from './routes/world.js';
import { RunnerManager } from './runner/manager.js';
import type { RunnerSettings } from './runner/runner.js';
import { registerStreamRoute } from './ws/stream.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared services (store, runner manager, …); exposed for tests and tooling. */
    ctx: AppContext;
  }
}

export interface BuildAppOptions {
  env: Env;
  prisma: PrismaClient;
  /**
   * `false` disables logging; a stream receives the JSON log lines (tests).
   * Defaults to stdout at LOG_LEVEL.
   */
  logger?: false | { stream: Writable };
  /** Run startup recovery of civilizations interrupted while RUNNING (default true). */
  recover?: boolean;
  /** Overrides for runner tuning (tests). */
  runnerSettings?: Partial<RunnerSettings>;
  /** Idle time before a paused runner is unloaded (0 disables; default 15 minutes). */
  idleEvictMs?: number;
}

const registeredApiRoutes = new WeakMap<FastifyInstance, readonly string[]>();

/** `METHOD /api/...` of every API route the app registered (to compare with API_ROUTES). */
export function listApiRoutes(app: FastifyInstance): readonly string[] {
  return registeredApiRoutes.get(app) ?? [];
}

/** Longest stretch of ticks before a runner yields to the event loop. */
const SLICE_BUDGET_MS = 12;

/** Hide the `?token=` value of WebSocket URLs in logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
}

function loggerOptions(env: Env, stream?: Writable) {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: ['req.headers.authorization', 'headers.authorization', 'req.query.token'],
      censor: '[redacted]',
    },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
        };
      },
    },
    ...(stream ? { stream } : {}),
  };
}

/**
 * Build the HTTP/WebSocket server: logging, CORS, auth, routes (exactly the
 * API_ROUTES table of @civ/shared), the stream hub, optional static web app,
 * startup recovery, and shutdown (final checkpoints) on close. The caller owns
 * `prisma` and disconnects it after `app.close()`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { env, prisma } = options;
  const app = Fastify({
    logger:
      options.logger === false ? false : loggerOptions(env, options.logger?.stream ?? undefined),
    // Request bodies are small JSON documents (configs, commands).
    bodyLimit: 256 * 1024,
  });

  const store = new CivilizationStore(prisma);
  const runners = new RunnerManager({
    store,
    log: app.log,
    idleEvictMs: options.idleEvictMs,
    settings: {
      checkpointIntervalMs: env.CHECKPOINT_INTERVAL_MS,
      maxBufferedEvents: env.MAX_BUFFERED_EVENTS,
      invariants: env.INVARIANT_CHECKS,
      sliceBudgetMs: SLICE_BUDGET_MS,
      ...options.runnerSettings,
    },
  });
  const ctx: AppContext = { env, prisma, store, runners };
  app.decorate('ctx', ctx);

  const apiRoutes: string[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (route.url.startsWith('/api/') && method !== 'HEAD')
        apiRoutes.push(`${method} ${route.url}`);
    }
  });
  registeredApiRoutes.set(app, apiRoutes);

  registerErrorHandling(app, { spaFallback: env.WEB_DIST_DIR !== undefined });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 600,
  });
  // Before auth: its onRequest hook marks upgrade requests so that a rejected
  // upgrade (401/403/404) gets its raw socket destroyed after the response.
  await app.register(websocket, { options: { maxPayload: 4096 } });
  registerAuth(app, env);

  registerSystemRoutes(app, ctx);
  registerCivilizationRoutes(app, ctx);
  registerWorldRoutes(app, ctx);
  registerHistoryRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerStreamRoute(app, ctx);

  if (env.WEB_DIST_DIR) {
    await app.register(fastifyStatic, {
      root: resolve(env.WEB_DIST_DIR),
      prefix: '/',
      index: ['index.html'],
    });
  }

  // Final checkpoints after the server stopped accepting requests.
  app.addHook('onClose', async () => runners.shutdown());

  if (options.recover ?? true) await runners.recoverInterrupted(env.RESUME_RUNNING_ON_START);
  await app.ready();
  return app;
}
