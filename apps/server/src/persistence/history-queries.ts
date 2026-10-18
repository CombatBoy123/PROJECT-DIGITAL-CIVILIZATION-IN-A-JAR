import {
  METRIC_DEFINITIONS,
  type EntityKind,
  type EntityRef,
  type EventType,
  type MetricKey,
  type MetricKind,
} from '@civ/sim-core';
import type {
  AuditEntryDto,
  AuditPage,
  EventDto,
  EventPage,
  MetricSeriesResponse,
  SnapshotDto,
} from '@civ/shared';
import { Prisma, type PrismaClient, type Snapshot } from '@prisma/client';
import { AppError } from '../http/errors.js';
import { fromDbEnum, toNumber } from './mappers.js';

/*
 * Reads of the append-only history tables (events, metric samples, snapshots,
 * audit log). Everything is paginated with keyset cursors or bounded by a row
 * limit; nothing loads unbounded history into memory. Events and metrics are only
 * written together with their checkpoint, so every row returned here is durable.
 */

// ---------------------------------------------------------------------------
// Events

export interface EventFilter {
  types?: readonly EventType[];
  citizenId?: number;
  buildingId?: number;
  householdId?: number;
  fromTick?: number;
  toTick?: number;
}

export type EventCursor =
  { direction: 'before'; seq: number | null } | { direction: 'after'; seq: number };

interface EventRow {
  seq: bigint;
  tick: number;
  type: string;
  cause_seq: bigint | null;
  payload: Prisma.JsonValue;
}

function entityCondition(kind: EntityKind, id: number): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "event_entity" x
    WHERE x."civilization_id" = e."civilization_id" AND x."event_seq" = e."seq"
      AND x."entity_kind" = ${kind.toUpperCase()}::"EntityKind" AND x."entity_id" = ${id}::int
  )`;
}

function eventConditions(civilizationId: string, filter: EventFilter): Prisma.Sql[] {
  const conds = [Prisma.sql`e."civilization_id" = ${civilizationId}::uuid`];
  if (filter.types && filter.types.length > 0)
    conds.push(Prisma.sql`e."type" IN (${Prisma.join([...filter.types])})`);
  if (filter.fromTick !== undefined) conds.push(Prisma.sql`e."tick" >= ${filter.fromTick}::int`);
  if (filter.toTick !== undefined) conds.push(Prisma.sql`e."tick" <= ${filter.toTick}::int`);
  if (filter.citizenId !== undefined) conds.push(entityCondition('citizen', filter.citizenId));
  if (filter.buildingId !== undefined) conds.push(entityCondition('building', filter.buildingId));
  if (filter.householdId !== undefined)
    conds.push(entityCondition('household', filter.householdId));
  return conds;
}

/** Entity references of a batch of events (one query), keyed by seq. */
async function loadRefs(
  prisma: PrismaClient,
  civilizationId: string,
  seqs: readonly bigint[],
): Promise<Map<bigint, EntityRef[]>> {
  const refs = new Map<bigint, EntityRef[]>();
  if (seqs.length === 0) return refs;
  const rows = await prisma.eventEntity.findMany({
    where: { civilizationId, eventSeq: { in: [...seqs] } },
    orderBy: [{ eventSeq: 'asc' }, { entityKind: 'asc' }, { entityId: 'asc' }, { role: 'asc' }],
  });
  for (const r of rows) {
    const list = refs.get(r.eventSeq) ?? [];
    list.push({ kind: fromDbEnum<EntityKind>(r.entityKind), id: r.entityId, role: r.role });
    refs.set(r.eventSeq, list);
  }
  return refs;
}

async function toEventDtos(
  prisma: PrismaClient,
  civilizationId: string,
  rows: readonly EventRow[],
): Promise<EventDto[]> {
  const refs = await loadRefs(
    prisma,
    civilizationId,
    rows.map((r) => r.seq),
  );
  return rows.map((r) => ({
    seq: toNumber(r.seq),
    tick: r.tick,
    type: r.type as EventType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    refs: refs.get(r.seq) ?? [],
    causeSeq: r.cause_seq === null ? null : toNumber(r.cause_seq),
  }));
}

/**
 * One page of events. `before` pages go backwards in time (newest first, the
 * default when no cursor is given); `after` pages go forwards (oldest first).
 * `nextCursor` continues in the same direction, or is null when exhausted.
 */
export async function listEvents(
  prisma: PrismaClient,
  civilizationId: string,
  filter: EventFilter,
  cursor: EventCursor,
  limit: number,
): Promise<EventPage> {
  const conds = eventConditions(civilizationId, filter);
  const descending = cursor.direction === 'before';
  if (cursor.seq !== null) {
    conds.push(
      descending
        ? Prisma.sql`e."seq" < ${cursor.seq}::bigint`
        : Prisma.sql`e."seq" > ${cursor.seq}::bigint`,
    );
  }
  const order = descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const rows = await prisma.$queryRaw<EventRow[]>`
    SELECT e."seq", e."tick", e."type", e."cause_seq", e."payload"
    FROM "simulation_event" e
    WHERE ${Prisma.join(conds, ' AND ')}
    ORDER BY e."seq" ${order}
    LIMIT ${limit + 1}::int`;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await toEventDtos(prisma, civilizationId, page);
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.seq : null };
}

/** Rows per page when streaming events for export. */
export const EVENT_EXPORT_PAGE = 2000;

/**
 * Options of the paged export iterators. Each page is a separate query, so a rewind
 * (restore or reset) committed between two pages would delete or replace rows the
 * export has not read yet. `verify` runs after each page is read and before it is
 * yielded; it throws when that happened (see `timelineGuard`), so an export either
 * contains one consistent timeline or fails — it never ends early looking complete.
 */
export interface ExportPaging {
  pageSize?: number;
  verify?: () => Promise<void>;
}

/**
 * A `verify` for ExportPaging: throws CONFLICT once the civilization's timeline
 * generation differs from `timeline` (the value read when the export started), and
 * NOT_FOUND once it was deleted. A rewind increments the generation in its own
 * transaction, so a check that runs after a page was read sees every rewind that
 * could have affected that page.
 */
export function timelineGuard(
  prisma: PrismaClient,
  civilizationId: string,
  timeline: number,
): () => Promise<void> {
  return async () => {
    const row = await prisma.civilization.findUnique({
      where: { id: civilizationId },
      select: { timeline: true },
    });
    if (!row) {
      throw new AppError('NOT_FOUND', 'The civilization was deleted while the export was running');
    }
    if (row.timeline !== timeline) {
      throw new AppError(
        'CONFLICT',
        'The civilization was rewound (snapshot restore or reset) while the export was running; the export was aborted',
      );
    }
  };
}

/**
 * All events matching `filter` in ascending seq, page by page. The export is cut at
 * the durable boundary observed when it starts (`belowSeq`), so events committed
 * while the export streams are not partially included; `paging.verify` detects
 * rewinds (which delete rows below the boundary).
 */
export async function* iterateEvents(
  prisma: PrismaClient,
  civilizationId: string,
  filter: EventFilter,
  belowSeq: number,
  paging: ExportPaging = {},
): AsyncGenerator<EventDto[]> {
  const pageSize = paging.pageSize ?? EVENT_EXPORT_PAGE;
  let after = 0;
  for (;;) {
    const conds = [
      ...eventConditions(civilizationId, filter),
      Prisma.sql`e."seq" > ${after}::bigint`,
      Prisma.sql`e."seq" < ${belowSeq}::bigint`,
    ];
    const rows = await prisma.$queryRaw<EventRow[]>`
      SELECT e."seq", e."tick", e."type", e."cause_seq", e."payload"
      FROM "simulation_event" e
      WHERE ${Prisma.join(conds, ' AND ')}
      ORDER BY e."seq" ASC
      LIMIT ${pageSize}::int`;
    const items = await toEventDtos(prisma, civilizationId, rows);
    await paging.verify?.();
    if (items.length === 0) return;
    yield items;
    const last = items[items.length - 1];
    if (!last || rows.length < pageSize) return;
    after = last.seq;
  }
}

// ---------------------------------------------------------------------------
// Metrics

const KIND_BY_KEY = new Map<string, MetricKind>(METRIC_DEFINITIONS.map((d) => [d.key, d.kind]));

/** Numeric value of one metric key inside a sample's JSON (`values` is a column of alias s/m). */
function metricValue(alias: 's' | 'm', key: MetricKey): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}."values" ->> ${key}::text)::float8`;
}

interface MetricRangeRow {
  n: bigint;
  min_tick: number | null;
  max_tick: number | null;
}

interface MetricRow {
  tick: number;
  v: (number | null)[];
}

/**
 * Metric series for charts, downsampled to at most `maxPoints` rows.
 *
 * When the range holds more than `maxPoints` samples, ticks are grouped into
 * fixed-width buckets of `bucketTicks = ceil((lastTick − firstTick + 1) / maxPoints)`
 * ticks, starting at the first sample in range, and each bucket becomes one row whose
 * tick is the last sample tick in the bucket. Each metric is aggregated according to
 * its kind (METRIC_DEFINITIONS), so the downsampled value keeps its meaning:
 *  - stock, index, cumulative → the value of the last sample in the bucket (a level
 *    at a point in time cannot be summed, and a mean would invent a level that never
 *    existed at the row's tick);
 *  - rate → the arithmetic mean of the bucket's samples;
 *  - flow → the sum of the bucket's samples (the amount over the whole bucket).
 * Aggregation runs in PostgreSQL; only the output rows are transferred.
 */
export async function metricSeries(
  prisma: PrismaClient,
  civilizationId: string,
  keys: readonly MetricKey[],
  range: { fromTick?: number; toTick?: number },
  maxPoints: number,
): Promise<MetricSeriesResponse> {
  const from = range.fromTick ?? 0;
  const to = range.toTick ?? 2_147_483_647;
  const [stats] = await prisma.$queryRaw<MetricRangeRow[]>`
    SELECT count(*) AS n, min("tick") AS min_tick, max("tick") AS max_tick
    FROM "metric_sample"
    WHERE "civilization_id" = ${civilizationId}::uuid AND "tick" BETWEEN ${from}::int AND ${to}::int`;
  const count = stats ? Number(stats.n) : 0;
  const firstTick = stats?.min_tick ?? null;
  const lastTick = stats?.max_tick ?? null;
  const response = (rows: number[][], bucketTicks: number): MetricSeriesResponse => ({
    keys: [...keys],
    rows,
    bucketTicks,
    fromTick: range.fromTick ?? firstTick ?? 0,
    toTick: range.toTick ?? lastTick ?? range.fromTick ?? 0,
  });
  if (count === 0 || firstTick === null || lastTick === null || keys.length === 0) {
    return response([], 1);
  }

  const toRows = (rows: MetricRow[]) => rows.map((r) => [r.tick, ...(r.v as number[])]);
  if (count <= maxPoints) {
    const rows = await prisma.$queryRaw<MetricRow[]>`
      SELECT m."tick", ARRAY[${Prisma.join(keys.map((k) => metricValue('m', k)))}]::float8[] AS v
      FROM "metric_sample" m
      WHERE m."civilization_id" = ${civilizationId}::uuid
        AND m."tick" BETWEEN ${firstTick}::int AND ${lastTick}::int
      ORDER BY m."tick"`;
    return response(toRows(rows), 1);
  }

  const bucketTicks = Math.ceil((lastTick - firstTick + 1) / maxPoints);
  const aggregated = keys.map((key, i) => {
    const column = Prisma.raw(`a${i}`);
    switch (KIND_BY_KEY.get(key)) {
      case 'rate':
        return { select: Prisma.sql`avg(${metricValue('s', key)}) AS ${column}`, column };
      case 'flow':
        return { select: Prisma.sql`sum(${metricValue('s', key)}) AS ${column}`, column };
      default:
        return null;
    }
  });
  const bucketSelects = aggregated.flatMap((a) => (a ? [a.select] : []));
  const outputs = keys.map((key, i) => {
    const agg = aggregated[i];
    return agg ? Prisma.sql`b.${agg.column}` : metricValue('m', key);
  });
  const rows = await prisma.$queryRaw<MetricRow[]>`
    WITH buckets AS (
      SELECT (s."tick" - ${firstTick}::int) / ${bucketTicks}::int AS bucket,
             max(s."tick") AS last_tick
             ${bucketSelects.length > 0 ? Prisma.sql`, ${Prisma.join(bucketSelects)}` : Prisma.empty}
      FROM "metric_sample" s
      WHERE s."civilization_id" = ${civilizationId}::uuid
        AND s."tick" BETWEEN ${firstTick}::int AND ${lastTick}::int
      GROUP BY bucket
    )
    SELECT b.last_tick AS "tick", ARRAY[${Prisma.join(outputs)}]::float8[] AS v
    FROM buckets b
    JOIN "metric_sample" m
      ON m."civilization_id" = ${civilizationId}::uuid AND m."tick" = b.last_tick
    ORDER BY b.bucket`;
  return response(toRows(rows), bucketTicks);
}

/** Rows per page when streaming raw metric samples for export. */
export const METRIC_EXPORT_PAGE = 5000;

/**
 * Raw samples in ascending tick order, page by page (up to `throughTick`, inclusive);
 * `paging.verify` detects rewinds, as for iterateEvents.
 */
export async function* iterateMetricSamples(
  prisma: PrismaClient,
  civilizationId: string,
  keys: readonly MetricKey[],
  range: { fromTick: number; throughTick: number },
  paging: ExportPaging = {},
): AsyncGenerator<number[][]> {
  const pageSize = paging.pageSize ?? METRIC_EXPORT_PAGE;
  let from = range.fromTick;
  for (;;) {
    const rows = await prisma.$queryRaw<MetricRow[]>`
      SELECT m."tick", ARRAY[${Prisma.join(keys.map((k) => metricValue('m', k)))}]::float8[] AS v
      FROM "metric_sample" m
      WHERE m."civilization_id" = ${civilizationId}::uuid
        AND m."tick" >= ${from}::int AND m."tick" <= ${range.throughTick}::int
      ORDER BY m."tick"
      LIMIT ${pageSize}::int`;
    await paging.verify?.();
    if (rows.length === 0) return;
    yield rows.map((r) => [r.tick, ...(r.v as number[])]);
    const last = rows[rows.length - 1];
    if (!last || rows.length < pageSize) return;
    from = last.tick + 1;
  }
}

// ---------------------------------------------------------------------------
// Snapshots and audit

/** Upper bound for the (unpaginated) snapshot list. */
export const MAX_LISTED_SNAPSHOTS = 500;

export function toSnapshotDto(s: Omit<Snapshot, 'state'>): SnapshotDto {
  return {
    id: s.id,
    name: s.name,
    note: s.note,
    tick: s.tick,
    stateHash: s.stateHash,
    sizeBytes: s.sizeBytes,
    createdAt: s.createdAt.toISOString(),
    detachedAt: s.detachedAt ? s.detachedAt.toISOString() : null,
  };
}

/** Newest first. */
export async function listSnapshots(
  prisma: PrismaClient,
  civilizationId: string,
): Promise<SnapshotDto[]> {
  const rows = await prisma.snapshot.findMany({
    where: { civilizationId },
    omit: { state: true },
    orderBy: [{ createdAt: 'desc' }, { tick: 'desc' }],
    take: MAX_LISTED_SNAPSHOTS,
  });
  return rows.map(toSnapshotDto);
}

/** Audit entries newest first, keyset-paginated by id. */
export async function listAudit(
  prisma: PrismaClient,
  civilizationId: string,
  before: number | undefined,
  limit: number,
): Promise<AuditPage> {
  const rows = await prisma.auditLog.findMany({
    where: { civilizationId, ...(before !== undefined ? { id: { lt: BigInt(before) } } : {}) },
    orderBy: { id: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items: AuditEntryDto[] = rows.slice(0, limit).map((r) => ({
    id: toNumber(r.id),
    action: r.action,
    actor: r.actor,
    tick: r.tick,
    details: r.details,
    createdAt: r.createdAt.toISOString(),
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}
