import { randomBytes } from 'node:crypto';
import { SeedSchema, Simulation, type SimulationConfig } from '@civ/sim-core';
import {
  CivilizationParamsSchema,
  ControlRequestSchema,
  CreateCivilizationRequestSchema,
  SpeedRequestSchema,
  type CivilizationDetail,
  type CivilizationSummary,
  type ListResponse,
} from '@civ/shared';
import type { FastifyInstance } from 'fastify';
import { conflict, parseInput } from '../http/errors.js';
import { findCivilization } from '../persistence/civilization-queries.js';
import { captureState } from '../persistence/codec.js';
import { ProjectionTracker } from '../persistence/projections.js';
import {
  civilizationDetail,
  civilizationSummaries,
  civilizationSummary,
} from './civilization-views.js';
import { requireConfirmation } from './confirm.js';
import type { AppContext } from './context.js';

/** Speed of a new civilization (ticks per second); one of the UI's presets. */
export const DEFAULT_SPEED = 5;

/** A random seed that satisfies SeedSchema (16 hex characters, 64 bits of entropy). */
export function generateSeed(): string {
  return SeedSchema.parse(randomBytes(8).toString('hex'));
}

/** Civilization lifecycle and control. Every mutation is audited with the caller's actor. */
export function registerCivilizationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, runners, store } = ctx;
  const params = (input: unknown) => parseInput(CivilizationParamsSchema, input, 'path');

  app.get('/api/civilizations', async (): Promise<ListResponse<CivilizationSummary>> => {
    return { items: await civilizationSummaries(prisma, runners) };
  });

  app.post('/api/civilizations', async (request, reply) => {
    const body = parseInput(CreateCivilizationRequestSchema, request.body, 'request body');
    // Cheap early check; the unique index still decides under concurrency.
    if (await prisma.civilization.findUnique({ where: { name: body.name }, select: { id: true } }))
      throw conflict(`A civilization named "${body.name}" already exists`);
    const seed = body.seed ?? generateSeed();
    const { simulation, genesis } = Simulation.create(seed, body.config ?? {}, {
      invariants: ctx.env.INVARIANT_CHECKS,
    });
    const encoded = captureState(simulation.state);
    const id = await store.createCivilization({
      name: body.name,
      seed,
      config: simulation.state.config as SimulationConfig,
      speed: DEFAULT_SPEED,
      actor: request.principal.actor,
      encoded,
      events: genesis.events,
      metrics: genesis.metrics ? [genesis.metrics] : [],
      projection: new ProjectionTracker().delta(simulation.state, true),
    });
    runners.adopt(id, simulation, DEFAULT_SPEED);
    const detail: CivilizationDetail = await civilizationDetail(prisma, runners, id);
    return reply.status(201).send(detail);
  });

  app.get('/api/civilizations/:id', async (request): Promise<CivilizationDetail> => {
    const { id } = params(request.params);
    return civilizationDetail(prisma, runners, id);
  });

  app.delete('/api/civilizations/:id', async (request, reply) => {
    const { id } = params(request.params);
    const { row } = await findCivilization(prisma, id);
    requireConfirmation(request.body, row.name);
    await runners.delete(id, request.principal.actor, {
      civilizationId: id,
      name: row.name,
      seed: row.seed,
      durableTick: row.currentTick,
    });
    return reply.status(204).send();
  });

  app.post('/api/civilizations/:id/control', async (request): Promise<CivilizationSummary> => {
    const { id } = params(request.params);
    const command = parseInput(ControlRequestSchema, request.body, 'request body');
    const runner = await runners.get(id);
    const actor = request.principal.actor;
    switch (command.action) {
      case 'start':
        await runner.start(actor);
        break;
      case 'pause':
        await runner.pause(actor);
        break;
      case 'step':
        await runner.step(command.steps, actor);
        break;
    }
    return civilizationSummary(prisma, runners, id);
  });

  app.put('/api/civilizations/:id/speed', async (request): Promise<CivilizationSummary> => {
    const { id } = params(request.params);
    const { ticksPerSecond } = parseInput(SpeedRequestSchema, request.body, 'request body');
    const runner = await runners.get(id);
    await runner.setSpeed(ticksPerSecond, request.principal.actor);
    return civilizationSummary(prisma, runners, id);
  });

  app.post('/api/civilizations/:id/reset', async (request): Promise<CivilizationSummary> => {
    const { id } = params(request.params);
    const { row } = await findCivilization(prisma, id);
    requireConfirmation(request.body, row.name);
    await runners.reset(id, request.principal.actor);
    return civilizationSummary(prisma, runners, id);
  });
}
