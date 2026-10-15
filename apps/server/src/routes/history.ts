import { EVENT_TYPES, METRIC_KEYS, type EventType, type MetricKey } from '@civ/sim-core';
import {
  AuditQuerySchema,
  CivilizationParamsSchema,
  CreateSnapshotRequestSchema,
  EventQuerySchema,
  MetricsQuerySchema,
  type AuditPage,
  type CivilizationSummary,
  type EventPage,
  type ListResponse,
  type MetricSeriesResponse,
  type SnapshotDto,
} from '@civ/shared';
import type { FastifyInstance } from 'fastify';
import { AppError, parseInput } from '../http/errors.js';
import { assertCivilizationExists, findCivilization } from '../persistence/civilization-queries.js';
import {
  listAudit,
  listEvents,
  listSnapshots,
  metricSeries,
  toSnapshotDto,
  type EventCursor,
} from '../persistence/history-queries.js';
import { civilizationSummary } from './civilization-views.js';
import { requireConfirmation } from './confirm.js';
import { SnapshotParamsSchema, type AppContext } from './context.js';

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);
const METRIC_KEY_SET = new Set<string>(METRIC_KEYS);

function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', `Invalid query`, [
    { path: field, message, code: 'custom' },
  ]);
}

/** Validate a list of event types against the engine's catalogue. */
export function parseEventTypes(types: readonly string[] | undefined): EventType[] | undefined {
  if (!types || types.length === 0) return undefined;
  const unknown = types.filter((t) => !EVENT_TYPE_SET.has(t));
  if (unknown.length > 0) throw invalid('types', `Unknown event type(s): ${unknown.join(', ')}`);
  return types as EventType[];
}

/** Validate metric keys against the registry; defaults to every metric. */
export function parseMetricKeys(keys: readonly string[] | undefined): MetricKey[] {
  if (!keys || keys.length === 0) return [...METRIC_KEYS];
  const unknown = keys.filter((k) => !METRIC_KEY_SET.has(k));
  if (unknown.length > 0) throw invalid('keys', `Unknown metric key(s): ${unknown.join(', ')}`);
  return [...new Set(keys)] as MetricKey[];
}

/** Reject inverted tick ranges instead of silently returning nothing. */
export function assertTickRange(fromTick: number | undefined, toTick: number | undefined): void {
  if (fromTick !== undefined && toTick !== undefined && fromTick > toTick)
    throw invalid('fromTick', 'fromTick must not be greater than toTick');
}

/** Event log, metric series, snapshots and the audit log. */
export function registerHistoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, runners } = ctx;
  const params = (input: unknown) => parseInput(CivilizationParamsSchema, input, 'path');

  app.get('/api/civilizations/:id/events', async (request): Promise<EventPage> => {
    const { id } = params(request.params);
    const q = parseInput(EventQuerySchema, request.query, 'query');
    if (q.before !== undefined && q.after !== undefined)
      throw invalid('before', 'Use either before or after, not both');
    assertTickRange(q.fromTick, q.toTick);
    const types = parseEventTypes(q.types);
    await assertCivilizationExists(prisma, id);
    const cursor: EventCursor =
      q.after !== undefined
        ? { direction: 'after', seq: q.after }
        : { direction: 'before', seq: q.before ?? null };
    return listEvents(
      prisma,
      id,
      {
        types,
        citizenId: q.citizenId,
        buildingId: q.buildingId,
        householdId: q.householdId,
        fromTick: q.fromTick,
        toTick: q.toTick,
      },
      cursor,
      q.limit,
    );
  });

  app.get('/api/civilizations/:id/metrics', async (request): Promise<MetricSeriesResponse> => {
    const { id } = params(request.params);
    const q = parseInput(MetricsQuerySchema, request.query, 'query');
    assertTickRange(q.fromTick, q.toTick);
    const keys = parseMetricKeys(q.keys);
    await assertCivilizationExists(prisma, id);
    return metricSeries(prisma, id, keys, { fromTick: q.fromTick, toTick: q.toTick }, q.maxPoints);
  });

  app.get(
    '/api/civilizations/:id/snapshots',
    async (request): Promise<ListResponse<SnapshotDto>> => {
      const { id } = params(request.params);
      await assertCivilizationExists(prisma, id);
      return { items: await listSnapshots(prisma, id) };
    },
  );

  app.post('/api/civilizations/:id/snapshots', async (request, reply) => {
    const { id } = params(request.params);
    const body = parseInput(CreateSnapshotRequestSchema, request.body, 'request body');
    const runner = await runners.get(id);
    const snapshot = await runner.saveSnapshot(
      body.name,
      body.note ? body.note : null,
      request.principal.actor,
    );
    const dto: SnapshotDto = toSnapshotDto(snapshot);
    return reply.status(201).send(dto);
  });

  app.post(
    '/api/civilizations/:id/snapshots/:snapshotId/restore',
    async (request): Promise<CivilizationSummary> => {
      const { id, snapshotId } = parseInput(SnapshotParamsSchema, request.params, 'path');
      const { row } = await findCivilization(prisma, id);
      requireConfirmation(request.body, row.name);
      const runner = await runners.get(id);
      await runner.restoreSnapshot(snapshotId, request.principal.actor);
      return civilizationSummary(prisma, runners, id);
    },
  );

  app.get('/api/civilizations/:id/audit', async (request): Promise<AuditPage> => {
    const { id } = params(request.params);
    const q = parseInput(AuditQuerySchema, request.query, 'query');
    await assertCivilizationExists(prisma, id);
    return listAudit(prisma, id, q.before, q.limit);
  });
}
