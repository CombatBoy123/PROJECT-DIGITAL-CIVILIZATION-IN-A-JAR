import { ENGINE_VERSION } from '@civ/sim-core';
import { MAX_STEPS_PER_REQUEST, type HealthResponse, type MetaResponse } from '@civ/shared';
import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db/prisma.js';
import type { AppContext } from './context.js';

/** Public endpoints: liveness and server capabilities. */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async (_request, reply) => {
    const up = await pingDatabase(ctx.prisma);
    const body: HealthResponse = { ok: up, database: up ? 'up' : 'down' };
    return reply.status(up ? 200 : 503).send(body);
  });

  app.get('/api/meta', async (): Promise<MetaResponse> => {
    return {
      engineVersion: ENGINE_VERSION,
      authMode: ctx.env.AUTH_MODE,
      readRequiresToken: ctx.env.AUTH_MODE === 'token' && ctx.env.VIEWER_TOKEN !== undefined,
      frameRate: ctx.env.FRAME_RATE,
      maxStepsPerRequest: MAX_STEPS_PER_REQUEST,
    };
  });
}
