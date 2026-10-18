import {
  buildFrame,
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  Simulation,
  ticksPerYear,
  type MetricKey,
} from '@civ/sim-core';
import type {
  AuditPage,
  BuildingDetail,
  BuildingListItem,
  CitizenDetail,
  CitizenListItem,
  ConfigExport,
  EventDto,
  EventPage,
  FrameResponse,
  LayoutResponse,
  MetricSeriesResponse,
  Page,
} from '@civ/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkpointOf,
  control,
  createCivilization,
  createTestPrisma,
  json,
  SMALL_CONFIG,
  startApp,
  truncateAll,
} from './helpers.js';

const SEED = 'test-seed';
const TICKS = 400;

let prisma: PrismaClient;
let app: FastifyInstance;
let id: string;
let base: string;
/** The pure engine at the same tick, for cross-checking read models. */
let reference: Simulation;

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return json<T>(res);
}

beforeAll(async () => {
  prisma = createTestPrisma();
  await truncateAll(prisma);
  app = await startApp(prisma);
  const civ = await createCivilization(app);
  id = civ.id;
  base = `/api/civilizations/${id}`;
  await control(app, id, { action: 'step', steps: TICKS });
  reference = Simulation.create(SEED, SMALL_CONFIG).simulation;
  for (let i = 0; i < TICKS; i++) reference.step();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('current world', () => {
  it('layout and frame come from the loaded simulation', async () => {
    const layout = await get<LayoutResponse>(`${base}/layout`);
    expect(layout.asOfTick).toBe(TICKS);
    expect(layout.buildings).toEqual(reference.state.buildings);
    expect(layout.map.width).toBe(reference.state.map.width);
    const frame = await get<FrameResponse>(`${base}/frame`);
    expect(frame).toEqual(JSON.parse(JSON.stringify(buildFrame(reference.state))));
  });

  it('lists citizens from the projection with ages at the durable tick', async () => {
    const page = await get<Page<CitizenListItem>>(`${base}/citizens?limit=200`);
    expect(page.total).toBe(20);
    expect(page.asOfTick).toBe(TICKS);
    const perYear = ticksPerYear(reference.state.config);
    for (const item of page.items) {
      const c = reference.state.citizens.find((x) => x.id === item.id)!;
      expect(item).toMatchObject({
        firstName: c.firstName,
        lastName: c.lastName,
        ageYears: Math.floor((TICKS - c.birthTick) / perYear),
        lifeStage: c.lifeStage,
        activity: c.activity,
        energy: c.needs.energy,
        balanceCents: c.balanceCents,
        locationBuildingId: c.locationId,
      });
    }
  });

  it('filters, searches, sorts and paginates citizens', async () => {
    const all = reference.state.citizens;
    const target = all[3]!;
    const byName = await get<Page<CitizenListItem>>(
      `${base}/citizens?search=${encodeURIComponent(target.firstName.toUpperCase())}`,
    );
    expect(byName.items.map((c) => c.id)).toContain(target.id);
    const full = await get<Page<CitizenListItem>>(
      `${base}/citizens?search=${encodeURIComponent(`${target.firstName} ${target.lastName}`)}`,
    );
    expect(full.items.every((c) => c.firstName === target.firstName)).toBe(true);
    const byId = await get<Page<CitizenListItem>>(`${base}/citizens?search=${target.id}`);
    expect(byId.items.map((c) => c.id)).toEqual([target.id]);

    const adults = await get<Page<CitizenListItem>>(`${base}/citizens?lifeStage=adult&limit=200`);
    expect(adults.total).toBe(all.filter((c) => c.lifeStage === 'adult').length);
    expect(adults.items.every((c) => c.lifeStage === 'adult')).toBe(true);

    const household = all[0]!.householdId;
    const members = await get<Page<CitizenListItem>>(`${base}/citizens?householdId=${household}`);
    expect(members.items.map((c) => c.id)).toEqual(
      all.filter((c) => c.householdId === household).map((c) => c.id),
    );

    const richest = await get<Page<CitizenListItem>>(
      `${base}/citizens?sort=balance&order=desc&limit=200`,
    );
    const balances = richest.items.map((c) => c.balanceCents);
    expect(balances).toEqual([...balances].sort((a, b) => b - a));

    const youngest = await get<Page<CitizenListItem>>(`${base}/citizens?sort=age&limit=200`);
    const ages = youngest.items.map((c) => c.ageYears);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));

    const first = await get<Page<CitizenListItem>>(`${base}/citizens?limit=7&offset=0`);
    const second = await get<Page<CitizenListItem>>(`${base}/citizens?limit=7&offset=7`);
    expect(first.items).toHaveLength(7);
    expect(second.offset).toBe(7);
    expect(second.items[0]!.id).toBeGreaterThan(first.items[6]!.id);
  });

  it('name searches match LIKE wildcards literally', async () => {
    // Names never contain % or _, so these must match nothing (not everything).
    for (const term of ['%', '_', '__', '%25%', '\\', 'a_', '%a']) {
      const q = encodeURIComponent(term);
      const citizens = await get<Page<CitizenListItem>>(`${base}/citizens?search=${q}`);
      expect(citizens.total, `citizens ${term}`).toBe(0);
      const buildings = await get<Page<BuildingListItem>>(`${base}/buildings?search=${q}`);
      expect(buildings.total, `buildings ${term}`).toBe(0);
    }
    const target = reference.state.citizens[3]!;
    const prefix = target.lastName.slice(0, 2).toLowerCase();
    const byPrefix = await get<Page<CitizenListItem>>(`${base}/citizens?search=${prefix}`);
    expect(byPrefix.total).toBe(
      reference.state.citizens.filter(
        (c) =>
          c.firstName.toLowerCase().includes(prefix) || c.lastName.toLowerCase().includes(prefix),
      ).length,
    );
  });

  it('rejects blank or malformed numeric query parameters instead of reading them as 0', async () => {
    for (const url of [
      `${base}/metrics?toTick=`,
      `${base}/metrics?toTick=%20%20`,
      `${base}/metrics?fromTick=&toTick=5`,
      `${base}/metrics?maxPoints=`,
      `${base}/events?toTick=&limit=500`,
      `${base}/events?before=`,
      `${base}/events?limit=1.5`,
      `${base}/events?fromTick=0x10`,
      `${base}/citizens?offset=`,
      `${base}/citizens?householdId=-1`,
      `${base}/audit?limit=`,
      `${base}/export/metrics.csv?toTick=`,
    ]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code, url).toBe('VALIDATION_ERROR');
    }
    // Surrounding whitespace around digits is tolerated.
    const padded = await get<MetricSeriesResponse>(
      `${base}/metrics?keys=population.total&toTick=%205%20`,
    );
    expect(padded.toTick).toBe(5);
  });

  it('citizen detail includes skills, places and household members', async () => {
    const c = reference.state.citizens[0]!;
    const detail = await get<CitizenDetail>(`${base}/citizens/${c.id}`);
    expect(detail).toMatchObject({
      id: c.id,
      birthTick: c.birthTick,
      skills: c.skills,
      personality: c.personality,
      home: { id: c.homeId },
      asOfTick: TICKS,
    });
    expect(detail.householdMembers.map((m) => m.id)).toEqual(
      reference.state.citizens
        .filter((x) => x.householdId === c.householdId && x.id !== c.id)
        .map((x) => x.id),
    );
  });

  it('lists buildings and shows residents and occupants', async () => {
    const houses = await get<Page<BuildingListItem>>(`${base}/buildings?kind=house&limit=500`);
    expect(houses.total).toBe(reference.state.buildings.filter((b) => b.kind === 'house').length);
    const home = reference.state.citizens[0]!.homeId;
    const detail = await get<BuildingDetail>(`${base}/buildings/${home}`);
    expect(detail.residents.map((r) => r.id)).toEqual(
      reference.state.citizens.filter((c) => c.homeId === home).map((c) => c.id),
    );
    expect(detail.occupants.map((r) => r.id)).toEqual(
      reference.state.citizens.filter((c) => c.locationId === home).map((c) => c.id),
    );
    expect(detail.asOfTick).toBe(TICKS);
  });
});

describe('events', () => {
  async function allEvents(): Promise<EventDto[]> {
    const rows = await prisma.simulationEvent.count({ where: { civilizationId: id } });
    const page = await get<EventPage>(`${base}/events?after=0&limit=500`);
    expect(page.items).toHaveLength(rows);
    return page.items;
  }

  it('pages newest-first with before cursors and oldest-first with after cursors', async () => {
    const everything = await allEvents();
    const backwards: EventDto[] = [];
    let cursor: number | null = null;
    for (;;) {
      const page: EventPage = await get<EventPage>(
        `${base}/events?limit=7${cursor ? `&before=${cursor}` : ''}`,
      );
      backwards.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(backwards.map((e) => e.seq)).toEqual(everything.map((e) => e.seq).reverse());

    const forwards: EventDto[] = [];
    let after = 0;
    for (;;) {
      const page = await get<EventPage>(`${base}/events?limit=9&after=${after}`);
      forwards.push(...page.items);
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(forwards).toEqual(everything);
    // Refs are included.
    const created = everything.find((e) => e.type === 'CitizenCreated')!;
    expect(created.refs).toContainEqual({ kind: 'citizen', id: 1, role: 'subject' });
  });

  it('filters by type, entity and tick range', async () => {
    const everything = await allEvents();
    const seasons = await get<EventPage>(`${base}/events?types=SeasonStarted&limit=500`);
    expect(seasons.items.length).toBeGreaterThan(10);
    expect(seasons.items.every((e) => e.type === 'SeasonStarted')).toBe(true);

    const two = await get<EventPage>(
      `${base}/events?types=SeasonStarted,WeatherChanged&after=0&limit=500`,
    );
    expect(two.items).toEqual(
      everything.filter((e) => e.type === 'SeasonStarted' || e.type === 'WeatherChanged'),
    );

    const citizen = await get<EventPage>(`${base}/events?citizenId=1&after=0&limit=500`);
    expect(citizen.items).toEqual(
      everything.filter((e) => e.refs.some((r) => r.kind === 'citizen' && r.id === 1)),
    );
    expect(citizen.items.length).toBeGreaterThan(0);

    const householdId = reference.state.citizens[0]!.householdId;
    const household = await get<EventPage>(
      `${base}/events?householdId=${householdId}&after=0&limit=500`,
    );
    expect(household.items).toEqual(
      everything.filter((e) => e.refs.some((r) => r.kind === 'household' && r.id === householdId)),
    );

    const ranged = await get<EventPage>(`${base}/events?fromTick=100&toTick=200&after=0&limit=500`);
    expect(ranged.items).toEqual(everything.filter((e) => e.tick >= 100 && e.tick <= 200));
  });
});

describe('metrics', () => {
  it('returns raw samples when they fit', async () => {
    const series = await get<MetricSeriesResponse>(
      `${base}/metrics?keys=population.total,environment.temperatureC&maxPoints=5000`,
    );
    expect(series.bucketTicks).toBe(1);
    expect(series.rows).toHaveLength(TICKS + 1);
    expect(series.rows[0]).toEqual([0, 20, expect.any(Number)]);
    expect(series.fromTick).toBe(0);
    expect(series.toTick).toBe(TICKS);
  });

  it('downsamples by metric kind: last value for levels, mean for rates', async () => {
    const keys = METRIC_KEYS;
    const raw = await get<MetricSeriesResponse>(`${base}/metrics?maxPoints=5000`);
    const maxPoints = 37;
    const down = await get<MetricSeriesResponse>(`${base}/metrics?maxPoints=${maxPoints}`);
    expect(down.keys).toEqual(keys);
    const bucketTicks = Math.ceil((TICKS + 1) / maxPoints);
    expect(down.bucketTicks).toBe(bucketTicks);
    expect(down.rows.length).toBeLessThanOrEqual(maxPoints);

    const buckets = new Map<number, number[][]>();
    for (const row of raw.rows) {
      const b = Math.floor(row[0]! / bucketTicks);
      buckets.set(b, [...(buckets.get(b) ?? []), row]);
    }
    expect(down.rows).toHaveLength(buckets.size);
    const kinds = new Map<MetricKey, string>(METRIC_DEFINITIONS.map((d) => [d.key, d.kind]));
    [...buckets.values()].forEach((rows, i) => {
      const out = down.rows[i]!;
      const last = rows[rows.length - 1]!;
      expect(out[0]).toBe(last[0]);
      keys.forEach((key, k) => {
        const values = rows.map((r) => r[k + 1]!);
        const kind = kinds.get(key);
        const expected =
          kind === 'rate'
            ? values.reduce((a, b) => a + b, 0) / values.length
            : kind === 'flow'
              ? values.reduce((a, b) => a + b, 0)
              : values[values.length - 1]!;
        expect(out[k + 1], `${key} bucket ${i}`).toBeCloseTo(expected, 9);
      });
    });
  });

  it('respects tick ranges', async () => {
    const series = await get<MetricSeriesResponse>(
      `${base}/metrics?keys=population.total&fromTick=50&toTick=60`,
    );
    expect(series.rows.map((r) => r[0])).toEqual(Array.from({ length: 11 }, (_, i) => 50 + i));
    expect(series).toMatchObject({ fromTick: 50, toTick: 60, bucketTicks: 1 });
  });
});

describe('audit and exports', () => {
  it('pages the audit log by id, newest first', async () => {
    await control(app, id, { action: 'pause' }); // not running: no audit entry
    await app.inject({ method: 'PUT', url: `${base}/speed`, payload: { ticksPerSecond: 7 } });
    const first = await get<AuditPage>(`${base}/audit?limit=1`);
    expect(first.items[0]!.action).toBe('simulation.speed_changed');
    expect(first.nextCursor).toBe(first.items[0]!.id);
    const rest = await get<AuditPage>(`${base}/audit?before=${first.nextCursor}`);
    expect(rest.items.map((a) => a.action)).toEqual(['simulation.stepped', 'civilization.created']);
    expect(rest.nextCursor).toBeNull();
  });

  it('exports the configuration', async () => {
    const res = await app.inject({ url: `${base}/export/config` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Testville-config.json"');
    const body = res.json<ConfigExport>();
    expect(body).toMatchObject({
      format: 'civ-config',
      formatVersion: 1,
      name: 'Testville',
      seed: SEED,
      exportedAtTick: TICKS,
      stateHashAtExport: reference.hash(),
    });
    // The export recreates the same genesis.
    const again = Simulation.create(body.seed, body.config).simulation;
    expect(again.hash()).toBe(Simulation.create(SEED, SMALL_CONFIG).simulation.hash());
  });

  it('exports raw metric samples as CSV', async () => {
    const res = await app.inject({
      url: `${base}/export/metrics.csv?keys=population.total,money.supply`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('Testville-metrics.csv');
    const lines = res.body.trimEnd().split('\n');
    expect(lines[0]).toBe('tick,population.total,money.supply');
    expect(lines).toHaveLength(TICKS + 2);
    expect(lines[1]).toMatch(/^0,20,\d+$/);
    const ticks = lines.slice(1).map((l) => Number(l.split(',')[0]));
    expect(ticks).toEqual(Array.from({ length: TICKS + 1 }, (_, i) => i));
    const all = await app.inject({ url: `${base}/export/metrics.csv` });
    expect(all.body.split('\n')[0]).toBe(`tick,${METRIC_KEYS.join(',')}`);
  });

  it('exports events as NDJSON in ascending order', async () => {
    const res = await app.inject({ url: `${base}/export/events.ndjson` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const events = res.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as EventDto);
    const { nextEventSeq } = await checkpointOf(prisma, id);
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: nextEventSeq - 1 }, (_, i) => i + 1),
    );
    const filtered = await app.inject({
      url: `${base}/export/events.ndjson?types=SeasonStarted&fromTick=100`,
    });
    const seasons = filtered.body
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as EventDto);
    expect(seasons.every((e) => e.type === 'SeasonStarted' && e.tick >= 100)).toBe(true);
    expect(seasons.length).toBeGreaterThan(0);
  });
});
