import { Readable } from 'node:stream';
import {
  CivilizationParamsSchema,
  EventsExportQuerySchema,
  MetricsExportQuerySchema,
  type ConfigExport,
} from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, notFound, parseInput } from '../http/errors.js';
import { readConfig } from '../persistence/civilization-queries.js';
import { iterateEvents, iterateMetricSamples } from '../persistence/history-queries.js';
import { toNumber } from '../persistence/mappers.js';
import type { AppContext } from './context.js';
import { assertTickRange, parseEventTypes, parseMetricKeys } from './history.js';

/** File-name-safe version of a civilization name for Content-Disposition. */
export function exportFileName(civilizationName: string, suffix: string): string {
  const base = civilizationName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'civilization'}-${suffix}`;
}

function attachment(reply: FastifyReply, contentType: string, fileName: string): FastifyReply {
  return reply
    .header('content-type', contentType)
    .header('content-disposition', `attachment; filename="${fileName}"`)
    .header('cache-control', 'no-store');
}

/** The civilization with its durable checkpoint boundary (what an export may include). */
async function durableBoundary(prisma: PrismaClient, id: string) {
  const civ = await prisma.civilization.findUnique({
    where: { id },
    include: {
      config: true,
      checkpoint: { select: { tick: true, nextEventSeq: true, stateHash: true } },
    },
  });
  if (!civ) throw notFound('Civilization');
  if (!civ.config || !civ.checkpoint)
    throw new AppError('INTERNAL', 'Civilization has no checkpoint');
  return { civ, config: civ.config, checkpoint: civ.checkpoint };
}

function csvCell(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Downloads. Exports read the history in keyset pages and stream the response, so
 * memory stays bounded regardless of history length. Each export is cut at the
 * durable boundary observed when it starts.
 */
export function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const params = (input: unknown) => parseInput(CivilizationParamsSchema, input, 'path');

  app.get('/api/civilizations/:id/export/config', async (request, reply) => {
    const { id } = params(request.params);
    const { civ, config, checkpoint } = await durableBoundary(prisma, id);
    const body: ConfigExport = {
      format: 'civ-config',
      formatVersion: 1,
      name: civ.name,
      seed: civ.seed,
      engineVersion: civ.engineVersion,
      configSchemaVersion: config.schemaVersion,
      config: readConfig(config.params, id),
      exportedAtTick: checkpoint.tick,
      stateHashAtExport: checkpoint.stateHash,
    };
    return attachment(
      reply,
      'application/json; charset=utf-8',
      exportFileName(civ.name, 'config.json'),
    ).send(JSON.stringify(body, null, 2));
  });

  app.get('/api/civilizations/:id/export/metrics.csv', async (request, reply) => {
    const { id } = params(request.params);
    const q = parseInput(MetricsExportQuerySchema, request.query, 'query');
    assertTickRange(q.fromTick, q.toTick);
    const keys = parseMetricKeys(q.keys);
    const { civ, checkpoint } = await durableBoundary(prisma, id);
    const throughTick = Math.min(q.toTick ?? checkpoint.tick, checkpoint.tick);
    const pages = iterateMetricSamples(prisma, id, keys, {
      fromTick: q.fromTick ?? 0,
      throughTick,
    });
    async function* lines(): AsyncGenerator<string> {
      yield `tick,${keys.join(',')}\n`;
      for await (const rows of pages) {
        yield rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
      }
    }
    return attachment(
      reply,
      'text/csv; charset=utf-8',
      exportFileName(civ.name, 'metrics.csv'),
    ).send(Readable.from(lines()));
  });

  app.get('/api/civilizations/:id/export/events.ndjson', async (request, reply) => {
    const { id } = params(request.params);
    const q = parseInput(EventsExportQuerySchema, request.query, 'query');
    assertTickRange(q.fromTick, q.toTick);
    const types = parseEventTypes(q.types);
    const { civ, checkpoint } = await durableBoundary(prisma, id);
    const pages = iterateEvents(
      prisma,
      id,
      { types, fromTick: q.fromTick, toTick: q.toTick },
      toNumber(checkpoint.nextEventSeq),
    );
    async function* lines(): AsyncGenerator<string> {
      for await (const events of pages) {
        yield events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      }
    }
    return attachment(
      reply,
      'application/x-ndjson; charset=utf-8',
      exportFileName(civ.name, 'events.ndjson'),
    ).send(Readable.from(lines()));
  });
}
