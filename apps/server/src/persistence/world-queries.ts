import { SKILLS, ticksPerYear, type SimulationConfig, type Skills } from '@civ/sim-core';
import type {
  BuildingDetail,
  BuildingListQuerySchema,
  CitizenListQuerySchema,
  BuildingListItem,
  CitizenDetail,
  CitizenListItem,
  Page,
} from '@civ/shared';
import {
  Prisma,
  type Activity,
  type Building,
  type BuildingKind,
  type Citizen,
  type Education,
  type LifeStage,
  type PrismaClient,
} from '@prisma/client';
import type { z } from 'zod';
import { notFound } from '../http/errors.js';
import { readConfig } from './civilization-queries.js';
import { fromDbEnum, toDbEnum, toNumber } from './mappers.js';

/*
 * Reads of the current world from the projection tables. Each read runs in one
 * REPEATABLE READ transaction together with `civilization.current_tick`, which is
 * written in the same transaction as the projection, so `asOfTick` always labels
 * exactly the rows returned (the durable tick, never a mix of two checkpoints).
 */

type CitizenListQuery = z.output<typeof CitizenListQuerySchema>;
type BuildingListQuery = z.output<typeof BuildingListQuerySchema>;

const SNAPSHOT_READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };

/** Bound on related rows returned with a building (venues are capacity-limited anyway). */
const MAX_RELATED_CITIZENS = 500;
/** Bound on search terms in a citizen name search. */
const MAX_SEARCH_TERMS = 4;

interface Clock {
  asOfTick: number;
  config: SimulationConfig;
}

async function readClock(tx: Prisma.TransactionClient, civilizationId: string): Promise<Clock> {
  const civ = await tx.civilization.findUnique({
    where: { id: civilizationId },
    select: { currentTick: true, config: { select: { params: true } } },
  });
  if (!civ?.config) throw notFound('Civilization');
  return { asOfTick: civ.currentTick, config: readConfig(civ.config.params, civilizationId) };
}

function ageYears(birthTick: number, clock: Clock): number {
  return Math.floor((clock.asOfTick - birthTick) / ticksPerYear(clock.config));
}

function toCitizenListItem(c: Citizen, clock: Clock): CitizenListItem {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    ageYears: ageYears(c.birthTick, clock),
    lifeStage: fromDbEnum(c.lifeStage),
    education: fromDbEnum(c.education),
    activity: fromDbEnum(c.activity),
    energy: c.energy,
    balanceCents: toNumber(c.balanceCents),
    householdId: c.householdId,
    homeBuildingId: c.homeBuildingId,
    locationBuildingId: c.locationBuildingId,
  };
}

function toBuildingListItem(b: Building): BuildingListItem {
  return {
    id: b.id,
    kind: fromDbEnum(b.kind),
    name: b.name,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    capacity: b.capacity,
  };
}

/**
 * Name search: every whitespace-separated term must match the first or last name
 * (case-insensitive substring). A purely numeric search matches the citizen id exactly.
 */
function citizenSearch(search: string | undefined): Prisma.CitizenWhereInput {
  if (!search) return {};
  if (/^\d{1,9}$/.test(search)) return { id: Number(search) };
  const terms = search.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
  return {
    AND: terms.map((term) => ({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' as const } },
        { lastName: { contains: term, mode: 'insensitive' as const } },
      ],
    })),
  };
}

/**
 * Sort order with a unique tie-breaker (id) so offset pages are stable. Age sorts by
 * birth tick in the opposite direction: ascending age means latest birth first.
 */
function citizenOrder(
  sort: CitizenListQuery['sort'],
  order: 'asc' | 'desc',
): Prisma.CitizenOrderByWithRelationInput[] {
  const reverse = order === 'asc' ? 'desc' : 'asc';
  switch (sort) {
    case 'name':
      return [{ lastName: order }, { firstName: order }, { id: order }];
    case 'balance':
      return [{ balanceCents: order }, { id: order }];
    case 'energy':
      return [{ energy: order }, { id: order }];
    case 'age':
      return [{ birthTick: reverse }, { id: order }];
    case 'id':
      return [{ id: order }];
  }
}

export async function listCitizens(
  prisma: PrismaClient,
  civilizationId: string,
  query: CitizenListQuery,
): Promise<Page<CitizenListItem>> {
  const where: Prisma.CitizenWhereInput = {
    civilizationId,
    ...citizenSearch(query.search),
    ...(query.lifeStage ? { lifeStage: toDbEnum<LifeStage>(query.lifeStage) } : {}),
    ...(query.activity ? { activity: toDbEnum<Activity>(query.activity) } : {}),
    ...(query.education ? { education: toDbEnum<Education>(query.education) } : {}),
    ...(query.householdId !== undefined ? { householdId: query.householdId } : {}),
  };
  return prisma.$transaction(async (tx) => {
    const clock = await readClock(tx, civilizationId);
    const total = await tx.citizen.count({ where });
    const rows = await tx.citizen.findMany({
      where,
      orderBy: citizenOrder(query.sort, query.order),
      take: query.limit,
      skip: query.offset,
    });
    return {
      items: rows.map((c) => toCitizenListItem(c, clock)),
      total,
      limit: query.limit,
      offset: query.offset,
      asOfTick: clock.asOfTick,
    };
  }, SNAPSHOT_READ);
}

export async function getCitizen(
  prisma: PrismaClient,
  civilizationId: string,
  citizenId: number,
): Promise<CitizenDetail> {
  return prisma.$transaction(async (tx) => {
    const clock = await readClock(tx, civilizationId);
    const c = await tx.citizen.findUnique({
      where: { civilizationId_id: { civilizationId, id: citizenId } },
      include: {
        skills: true,
        home: { select: { id: true, name: true } },
        location: { select: { id: true, name: true, kind: true } },
      },
    });
    if (!c) throw notFound('Citizen');
    const members = await tx.citizen.findMany({
      where: { civilizationId, householdId: c.householdId, id: { not: c.id } },
      select: { id: true, firstName: true, lastName: true, birthTick: true },
      orderBy: { id: 'asc' },
      take: MAX_RELATED_CITIZENS,
    });
    const skills = Object.fromEntries(SKILLS.map((s) => [s, 0])) as Skills;
    for (const row of c.skills) skills[fromDbEnum<keyof Skills>(row.skill)] = row.level;
    return {
      ...toCitizenListItem(c, clock),
      birthTick: c.birthTick,
      personality: {
        openness: c.openness,
        conscientiousness: c.conscientiousness,
        extraversion: c.extraversion,
        agreeableness: c.agreeableness,
        neuroticism: c.neuroticism,
      },
      skills,
      destinationBuildingId: c.destinationId,
      home: c.home,
      location: c.location
        ? { id: c.location.id, name: c.location.name, kind: fromDbEnum(c.location.kind) }
        : null,
      householdMembers: members.map((m) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        ageYears: ageYears(m.birthTick, clock),
      })),
      asOfTick: clock.asOfTick,
    };
  }, SNAPSHOT_READ);
}

export async function listBuildings(
  prisma: PrismaClient,
  civilizationId: string,
  query: BuildingListQuery,
): Promise<Page<BuildingListItem>> {
  const where: Prisma.BuildingWhereInput = {
    civilizationId,
    ...(query.kind ? { kind: toDbEnum<BuildingKind>(query.kind) } : {}),
    ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
  };
  return prisma.$transaction(async (tx) => {
    const clock = await readClock(tx, civilizationId);
    const total = await tx.building.count({ where });
    const rows = await tx.building.findMany({
      where,
      orderBy: { id: 'asc' },
      take: query.limit,
      skip: query.offset,
    });
    return {
      items: rows.map(toBuildingListItem),
      total,
      limit: query.limit,
      offset: query.offset,
      asOfTick: clock.asOfTick,
    };
  }, SNAPSHOT_READ);
}

export async function getBuilding(
  prisma: PrismaClient,
  civilizationId: string,
  buildingId: number,
): Promise<BuildingDetail> {
  return prisma.$transaction(async (tx) => {
    const clock = await readClock(tx, civilizationId);
    const b = await tx.building.findUnique({
      where: { civilizationId_id: { civilizationId, id: buildingId } },
    });
    if (!b) throw notFound('Building');
    const person = { id: true, firstName: true, lastName: true, activity: true } as const;
    const residents = await tx.citizen.findMany({
      where: { civilizationId, homeBuildingId: buildingId },
      select: person,
      orderBy: { id: 'asc' },
      take: MAX_RELATED_CITIZENS,
    });
    const occupants = await tx.citizen.findMany({
      where: { civilizationId, locationBuildingId: buildingId },
      select: person,
      orderBy: { id: 'asc' },
      take: MAX_RELATED_CITIZENS,
    });
    const toPerson = (p: (typeof residents)[number]) => ({
      ...p,
      activity: fromDbEnum<CitizenListItem['activity']>(p.activity),
    });
    return {
      ...toBuildingListItem(b),
      residents: residents.map(toPerson),
      occupants: occupants.map(toPerson),
      asOfTick: clock.asOfTick,
    };
  }, SNAPSHOT_READ);
}
