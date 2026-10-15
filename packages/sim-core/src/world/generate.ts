import type { SimulationConfig } from '../config.js';
import { EventLog } from '../events/log.js';
import type { SimEvent } from '../events/types.js';
import { rngFor, type Rng } from '../rng/rng.js';
import type {
  Block,
  Building,
  Citizen,
  Education,
  Household,
  LifeStage,
  Personality,
  SkillId,
  Skills,
  WorldMap,
  WorldState,
  Zone,
} from '../state/schema.js';
import { SKILLS } from '../state/schema.js';
import { initialEnvironment } from '../systems/environment.js';
import { lifeStageForAge } from '../systems/demography.js';
import { ticksPerYear } from '../time/clock.js';
import { STATE_SCHEMA_VERSION } from '../version.js';
import {
  FIRST_NAMES,
  PARK_WORDS,
  SQUARE_WORDS,
  STREET_SUFFIXES,
  STREET_WORDS,
  SURNAMES,
} from './names.js';

/*
 * Procedural world generation. Everything is derived from the seed through keyed
 * random streams, so the same seed and configuration always yield the same world.
 *
 * Layout: a square-ish grid of blocks separated by one-tile roads. Blocks are
 * zoned by (jittered) distance from the centre: civic venues in the middle, then
 * commercial, residential and, on the outskirts, farmland. In Phase 1 commercial
 * and farmland blocks are vacant zoned land; businesses arrive in Phase 2.
 */

export const BLOCK_SIZE = 6;
/** Lots per residential block (2 × 2 lots of 3 × 3 tiles). */
const LOT_SIZE = 3;
const LOTS_PER_BLOCK = (BLOCK_SIZE / LOT_SIZE) * (BLOCK_SIZE / LOT_SIZE);
/** Fraction of extra houses built beyond the number of households (vacant homes). */
const VACANCY_RATE = 0.1;
const PLAZA_CAPACITY = 40;
const PARK_CAPACITY = 30;
/** Peak fraction of the population expected at public venues, used to size venue supply. */
const PEAK_LEISURE_SHARE = 0.35;
const MAX_HOUSEHOLD_SIZE = 6;
/** Household size weights for sizes 1–5. */
const HOUSEHOLD_SIZE_WEIGHTS = [28, 32, 18, 15, 7];
const ADULT_EDUCATION_WEIGHTS: Record<Education, number> = {
  none: 5,
  primary: 20,
  secondary: 50,
  tertiary: 25,
};
const ELDER_EDUCATION_WEIGHTS: Record<Education, number> = {
  none: 10,
  primary: 35,
  secondary: 40,
  tertiary: 15,
};
const EDUCATION_SKILL_BASE: Record<Education, number> = {
  none: 10,
  primary: 18,
  secondary: 25,
  tertiary: 32,
};
const EDUCATION_ORDER: readonly Education[] = ['none', 'primary', 'secondary', 'tertiary'];

interface MemberPlan {
  ageYears: number;
  firstName: string;
  lastName: string;
}

interface HouseholdPlan {
  surname: string;
  members: MemberPlan[];
}

export interface GenesisResult {
  state: WorldState;
  events: SimEvent[];
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function round(x: number, decimals: number): number {
  const f = decimals === 1 ? 10 : decimals === 2 ? 100 : 1000;
  return Math.round(x * f) / f;
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}

/** Plan household compositions until the population target is met exactly. */
function planHouseholds(config: SimulationConfig, rng: Rng): HouseholdPlan[] {
  const { adultAge } = config.lifeStages;
  const plans: HouseholdPlan[] = [];
  let remaining = config.population;
  while (remaining > 0) {
    const drawn = rng.weightedIndex(HOUSEHOLD_SIZE_WEIGHTS) + 1;
    const size = Math.min(drawn, remaining);
    const surname = rng.pick(SURNAMES);
    const headAge = Math.round(clamp(rng.normal(46, 16), adultAge, 92));
    const members: MemberPlan[] = [
      { ageYears: headAge, firstName: rng.pick(FIRST_NAMES), lastName: surname },
    ];
    const hasPartner = size >= 2 && rng.chance(size === 2 ? 0.75 : 0.8);
    if (hasPartner) {
      const partnerAge = clamp(headAge + rng.int(-6, 6), adultAge, 95);
      const keepsOwnName = rng.chance(0.3);
      members.push({
        ageYears: partnerAge,
        firstName: rng.pick(FIRST_NAMES),
        lastName: keepsOwnName ? rng.pick(SURNAMES) : surname,
      });
    }
    // Remaining members are children when the parents are old enough, otherwise adult relatives.
    const youngestParentAge = hasPartner
      ? Math.min(headAge, (members[1] as MemberPlan).ageYears)
      : headAge;
    const maxChildAge = Math.min(adultAge - 1, youngestParentAge - 16);
    while (members.length < size) {
      if (maxChildAge >= 0) {
        members.push({
          ageYears: rng.int(0, maxChildAge),
          firstName: rng.pick(FIRST_NAMES),
          lastName: surname,
        });
      } else {
        members.push({
          ageYears: clamp(headAge + rng.int(-8, 8), adultAge, 95),
          firstName: rng.pick(FIRST_NAMES),
          lastName: surname,
        });
      }
    }
    plans.push({ surname, members });
    remaining -= size;
  }
  return plans;
}

/** Build the block grid and assign zones by jittered distance from the centre. */
function planMap(
  zoneCounts: Record<Exclude<Zone, 'farmland'>, number> & { farmland: number },
  rng: Rng,
): WorldMap {
  const total =
    zoneCounts.civic + zoneCounts.commercial + zoneCounts.residential + zoneCounts.farmland;
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const pitch = BLOCK_SIZE + 1;

  const cells: { col: number; row: number; key: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Squared distance from the centre in half-block units (integers), plus jitter so that
      // zone boundaries are irregular and differ between seeds.
      const dx = 2 * col + 1 - cols;
      const dy = 2 * row + 1 - rows;
      cells.push({ col, row, key: dx * dx + dy * dy + rng.uniform(0, 2 * cols) });
    }
  }
  const byDistance = [...cells].sort((a, b) => a.key - b.key || a.row - b.row || a.col - b.col);
  const zoneOf = new Map<string, Zone>();
  let cursor = 0;
  const assign = (zone: Zone, count: number): void => {
    for (let i = 0; i < count && cursor < byDistance.length; i++, cursor++) {
      const cell = byDistance[cursor] as { col: number; row: number };
      zoneOf.set(`${cell.col},${cell.row}`, zone);
    }
  };
  assign('civic', zoneCounts.civic);
  assign('commercial', zoneCounts.commercial);
  assign('residential', zoneCounts.residential);
  assign('farmland', byDistance.length - cursor);

  const blocks: Block[] = [];
  let blockId = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      blocks.push({
        id: blockId++,
        col,
        row,
        x: col * pitch + 1,
        y: row * pitch + 1,
        zone: zoneOf.get(`${col},${row}`) ?? 'farmland',
      });
    }
  }
  return {
    width: cols * pitch + 1,
    height: rows * pitch + 1,
    cols,
    rows,
    blockSize: BLOCK_SIZE,
    roadPitch: pitch,
    blocks,
  };
}

/**
 * Blocks ordered from the map centre outwards: squared distance of the block centre from
 * the map centre (in half-block units, so integers), ties broken by row then column.
 */
function byCentrality(map: WorldMap, blocks: Block[]): Block[] {
  const distance = (b: Block): number => {
    const dx = 2 * b.col + 1 - map.cols;
    const dy = 2 * b.row + 1 - map.rows;
    return dx * dx + dy * dy;
  };
  return [...blocks].sort((a, b) => distance(a) - distance(b) || a.row - b.row || a.col - b.col);
}

function streetName(roadRow: number): string {
  const word = STREET_WORDS[roadRow % STREET_WORDS.length] as string;
  const suffix =
    STREET_SUFFIXES[Math.floor(roadRow / STREET_WORDS.length) % STREET_SUFFIXES.length];
  return `${word} ${suffix}`;
}

function drawPersonality(rng: Rng): Personality {
  const trait = (): number => round(clamp(rng.normal(0.5, 0.15), 0, 1), 3);
  return {
    openness: trait(),
    conscientiousness: trait(),
    extraversion: trait(),
    agreeableness: trait(),
    neuroticism: trait(),
  };
}

function drawEducation(ageYears: number, stage: LifeStage, rng: Rng): Education {
  if (stage === 'child') return ageYears < 6 ? 'none' : ageYears < 12 ? 'primary' : 'secondary';
  const weights = stage === 'elder' ? ELDER_EDUCATION_WEIGHTS : ADULT_EDUCATION_WEIGHTS;
  const index = rng.weightedIndex(EDUCATION_ORDER.map((e) => weights[e]));
  return EDUCATION_ORDER[index] as Education;
}

function drawSkills(
  ageYears: number,
  stage: LifeStage,
  education: Education,
  adultAge: number,
  rng: Rng,
): Skills {
  const skills = {} as Skills;
  if (stage === 'child') {
    for (const s of SKILLS) skills[s] = round(rng.uniform(0, 10), 1);
    return skills;
  }
  const experience = Math.min(ageYears - adultAge, 30);
  const specialty: SkillId = rng.pick(SKILLS);
  for (const s of SKILLS) {
    let value = EDUCATION_SKILL_BASE[education] + experience * 0.3 + rng.uniform(0, 20);
    if (s === specialty) value += 25 + experience;
    skills[s] = round(clamp(value, 0, 100), 1);
  }
  return skills;
}

function drawEndowment(stage: LifeStage, config: SimulationConfig, rng: Rng): number {
  if (stage === 'child') return 0;
  const { meanCents, spread } = config.initialWealth;
  let factor = 1;
  for (let i = 0; i < 4; i++) factor *= rng.uniform(1 - spread, 1 + spread);
  if (stage === 'elder') factor *= 1.3;
  return Math.round(meanCents * factor);
}

/** Generate the genesis world state (tick 0) and its genesis events. */
export function generateWorld(seed: string, config: SimulationConfig): GenesisResult {
  const tpy = ticksPerYear(config);
  const households = planHouseholds(config, rngFor(seed, 'worldgen', 'households'));

  const houseCount = Math.ceil(households.length * (1 + VACANCY_RATE));
  const venueCount = Math.max(
    2,
    Math.ceil((config.population * PEAK_LEISURE_SHARE) / ((PLAZA_CAPACITY + PARK_CAPACITY) / 2)),
  );
  const map = planMap(
    {
      civic: venueCount,
      commercial: Math.max(2, Math.ceil(config.population / 50)),
      residential: Math.ceil(houseCount / LOTS_PER_BLOCK),
      farmland: Math.max(4, Math.ceil(config.population / 25)),
    },
    rngFor(seed, 'worldgen', 'map'),
  );

  const naming = rngFor(seed, 'worldgen', 'names');
  const buildings: Building[] = [];
  let nextBuildingId = 1;

  // Public venues: one per civic block, alternating plaza / park starting from the most central.
  const civicBlocks = byCentrality(
    map,
    map.blocks.filter((b) => b.zone === 'civic'),
  );
  const usedVenueNames = new Set<string>();
  const uniqueName = (base: string): string => {
    let name = base;
    for (let n = 2; usedVenueNames.has(name); n++) name = `${base} ${n}`;
    usedVenueNames.add(name);
    return name;
  };
  civicBlocks.forEach((block, i) => {
    const isPlaza = i % 2 === 0;
    const name = isPlaza
      ? uniqueName(i === 0 ? 'Central Plaza' : `${naming.pick(SQUARE_WORDS)} Square`)
      : uniqueName(`${naming.pick(PARK_WORDS)} Park`);
    buildings.push({
      id: nextBuildingId++,
      kind: isPlaza ? 'plaza' : 'park',
      name,
      blockId: block.id,
      x: block.x,
      y: block.y,
      width: BLOCK_SIZE,
      height: BLOCK_SIZE,
      capacity: isPlaza ? PLAZA_CAPACITY : PARK_CAPACITY,
      door: { x: block.x + BLOCK_SIZE / 2, y: block.y - 1 },
    });
  });

  // Houses: fill residential lots, closest-to-centre blocks first, in a fixed lot order.
  const residentialBlocks = byCentrality(
    map,
    map.blocks.filter((b) => b.zone === 'residential'),
  );
  const lotOffsets = [
    [0, 0],
    [LOT_SIZE, 0],
    [0, LOT_SIZE],
    [LOT_SIZE, LOT_SIZE],
  ] as const;
  const houses: Building[] = [];
  for (const block of residentialBlocks) {
    for (const [lx, ly] of lotOffsets) {
      if (houses.length >= houseCount) break;
      const x = block.x + lx;
      const y = block.y + ly;
      const doorY = ly === 0 ? block.y - 1 : block.y + BLOCK_SIZE;
      const doorX = x + 1;
      const house: Building = {
        id: nextBuildingId++,
        kind: 'house',
        name: `${doorX} ${streetName(doorY / map.roadPitch)}`,
        blockId: block.id,
        x,
        y,
        width: LOT_SIZE,
        height: LOT_SIZE,
        capacity: 1, // set below once the household assignment is known
        door: { x: doorX, y: doorY },
      };
      houses.push(house);
      buildings.push(house);
    }
  }

  // Assign each household to a random house; leftover houses stay vacant.
  const housing = rngFor(seed, 'worldgen', 'housing');
  const shuffledHouses = shuffle([...houses], housing);
  const householdRecords: Household[] = [];
  const citizens: Citizen[] = [];
  const people = rngFor(seed, 'worldgen', 'citizens');
  let nextCitizenId = 1;

  households.forEach((plan, i) => {
    const house = shuffledHouses[i];
    if (!house) throw new Error('World generation: not enough houses for households');
    const householdId = i + 1;
    house.capacity = Math.min(MAX_HOUSEHOLD_SIZE, Math.max(plan.members.length, housing.int(2, 5)));
    householdRecords.push({ id: householdId, homeId: house.id, surname: plan.surname });
    for (const member of plan.members) {
      const stage = lifeStageForAge(member.ageYears, config);
      const education = drawEducation(member.ageYears, stage, people);
      citizens.push({
        id: nextCitizenId++,
        firstName: member.firstName,
        lastName: member.lastName,
        householdId,
        homeId: house.id,
        birthTick: -(member.ageYears * tpy + people.int(0, tpy - 1)),
        lifeStage: stage,
        education,
        personality: drawPersonality(people),
        skills: drawSkills(member.ageYears, stage, education, config.lifeStages.adultAge, people),
        balanceCents: drawEndowment(stage, config, people),
        needs: { energy: round(people.uniform(60, 95), 1) },
        activity: 'sleeping',
        activitySince: 0,
        locationId: house.id,
        travel: null,
      });
    }
  });
  for (const house of shuffledHouses.slice(households.length)) {
    house.capacity = housing.int(2, 5);
  }

  const state: WorldState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    seed,
    config,
    tick: 0,
    nextEventSeq: 1,
    nextIds: {
      citizen: nextCitizenId,
      building: nextBuildingId,
      household: householdRecords.length + 1,
      block: map.blocks.length + 1,
    },
    map,
    buildings,
    households: householdRecords,
    citizens,
    environment: initialEnvironment(config.stochastic.weather, rngFor(seed, 'weather', 0)),
    ledger: { issuedCents: 0, destroyedCents: 0 },
  };

  const log = new EventLog(state, 0);
  log.emit('CivilizationFounded', {
    seed,
    population: citizens.length,
    households: householdRecords.length,
    buildings: buildings.length,
    mapWidth: map.width,
    mapHeight: map.height,
  });
  for (const c of citizens) {
    const created = log.emit(
      'CitizenCreated',
      {
        firstName: c.firstName,
        lastName: c.lastName,
        ageYears: Math.floor(-c.birthTick / tpy),
        lifeStage: c.lifeStage,
        householdId: c.householdId,
        homeId: c.homeId,
      },
      [
        { kind: 'citizen', id: c.id, role: 'subject' },
        { kind: 'household', id: c.householdId, role: 'household' },
        { kind: 'building', id: c.homeId, role: 'home' },
      ],
    );
    if (c.balanceCents > 0) {
      log.emit(
        'MoneyIssued',
        { amountCents: c.balanceCents, reason: 'initial_endowment' },
        [{ kind: 'citizen', id: c.id, role: 'recipient' }],
        created,
      );
      state.ledger.issuedCents += c.balanceCents;
    }
  }

  return { state, events: [...log.list] };
}
