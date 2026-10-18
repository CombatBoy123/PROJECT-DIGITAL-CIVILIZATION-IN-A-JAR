import { SKILLS, type DeepReadonly, type WorldState } from '@civ/sim-core';
import { toDbEnum } from './mappers.js';
import { upsertRows, type TableSpec, type Tx } from './sql.js';

/*
 * Normalised projections of the world state (building, household, citizen,
 * citizen_skill). They are derived data: written in the same transaction as each
 * checkpoint so they always describe the checkpoint tick, and rebuilt entirely on
 * restore/reset. Only rows whose content changed are rewritten.
 */

const CIV = { name: 'civilization_id', cast: 'uuid' } as const;

const BUILDING: TableSpec = {
  table: 'building',
  key: ['civilization_id', 'id'],
  columns: [
    CIV,
    { name: 'id' },
    { name: 'kind', cast: '"BuildingKind"' },
    { name: 'name' },
    { name: 'x' },
    { name: 'y' },
    { name: 'width' },
    { name: 'height' },
    { name: 'capacity' },
    { name: 'updated_tick' },
  ],
};

const HOUSEHOLD: TableSpec = {
  table: 'household',
  key: ['civilization_id', 'id'],
  columns: [CIV, { name: 'id' }, { name: 'home_building_id' }, { name: 'updated_tick' }],
};

const CITIZEN: TableSpec = {
  table: 'citizen',
  key: ['civilization_id', 'id'],
  columns: [
    CIV,
    { name: 'id' },
    { name: 'first_name' },
    { name: 'last_name' },
    { name: 'household_id' },
    { name: 'birth_tick' },
    { name: 'life_stage', cast: '"LifeStage"' },
    { name: 'education', cast: '"Education"' },
    { name: 'home_building_id' },
    { name: 'openness' },
    { name: 'conscientiousness' },
    { name: 'extraversion' },
    { name: 'agreeableness' },
    { name: 'neuroticism' },
    { name: 'balance_cents', cast: 'bigint' },
    { name: 'energy' },
    { name: 'activity', cast: '"Activity"' },
    { name: 'location_building_id', cast: 'integer' },
    { name: 'destination_id', cast: 'integer' },
    { name: 'updated_tick' },
  ],
};

const CITIZEN_SKILL: TableSpec = {
  table: 'citizen_skill',
  key: ['civilization_id', 'citizen_id', 'skill'],
  columns: [CIV, { name: 'citizen_id' }, { name: 'skill', cast: '"Skill"' }, { name: 'level' }],
};

/** Read-only view of the engine state (what `Simulation.state` exposes). */
type View = DeepReadonly<WorldState>;

/** Row content without the civilization id and the updated tick (used for change detection). */
type Content = unknown[];

const DB_ENUM = new Map<string, string>();

/** toDbEnum, memoised (enum values are few; this runs several times per row per checkpoint). */
function dbEnum(value: string): string {
  let mapped = DB_ENUM.get(value);
  if (mapped === undefined) {
    mapped = toDbEnum(value);
    DB_ENUM.set(value, mapped);
  }
  return mapped;
}

function buildingRow(b: View['buildings'][number]): Content {
  return [b.id, dbEnum(b.kind), b.name, b.x, b.y, b.width, b.height, b.capacity];
}

function householdRow(h: View['households'][number]): Content {
  return [h.id, h.homeId];
}

function citizenRow(c: View['citizens'][number]): Content {
  return [
    c.id,
    c.firstName,
    c.lastName,
    c.householdId,
    c.birthTick,
    dbEnum(c.lifeStage),
    dbEnum(c.education),
    c.homeId,
    c.personality.openness,
    c.personality.conscientiousness,
    c.personality.extraversion,
    c.personality.agreeableness,
    c.personality.neuroticism,
    c.balanceCents,
    c.needs.energy,
    dbEnum(c.activity),
    c.locationId,
    c.travel ? c.travel.toId : null,
  ];
}

const SKILL_DB = SKILLS.map((skill) => toDbEnum(skill));

/** Row values are primitives (numbers, strings, null), so element identity is equality. */
function sameRow(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface ProjectionDelta {
  /** Rewrite everything (delete all rows of the civilization first). */
  full: boolean;
  buildings: Content[];
  households: Content[];
  citizens: Content[];
  skills: Content[];
  removed: { buildings: number[]; households: number[]; citizens: number[] };
}

/** Last written content per entity id, with the delta generation that last saw it. */
interface Written<T> {
  value: T;
  seen: number;
}

/**
 * Rows of one entity kind: returns the changed rows and records removed ids (entities
 * written before but absent now). Runs on the event loop during checkpoints, so it
 * compares values directly; no per-row serialisation or key strings.
 */
function diffRows<E extends { id: number }>(
  written: Map<number, Written<Content>>,
  entities: readonly E[],
  toRow: (entity: E) => Content,
  generation: number,
  removed: number[] | null,
): Content[] {
  const rows: Content[] = [];
  for (const entity of entities) {
    const row = toRow(entity);
    const before = written.get(entity.id);
    if (!before) {
      written.set(entity.id, { value: row, seen: generation });
      rows.push(row);
      continue;
    }
    before.seen = generation;
    if (!sameRow(before.value, row)) {
      before.value = row;
      rows.push(row);
    }
  }
  if (written.size !== entities.length) {
    for (const [id, entry] of written) {
      if (entry.seen === generation) continue;
      written.delete(id);
      removed?.push(id);
    }
  }
  return rows;
}

/**
 * Tracks what was last written so that each checkpoint only rewrites changed rows.
 * The tracker is updated optimistically when a delta is computed; if the write
 * fails, call invalidate() so the next delta rebuilds every row (and drops rows
 * of entities that no longer exist).
 */
export class ProjectionTracker {
  private buildings = new Map<number, Written<Content>>();
  private households = new Map<number, Written<Content>>();
  private citizens = new Map<number, Written<Content>>();
  /** Skill levels per citizen, in SKILLS order. */
  private skills = new Map<number, Written<number[]>>();
  private generation = 0;
  private primed = false;

  /** Forget what was written: the next delta is a full rebuild. */
  invalidate(): void {
    this.clear();
    this.primed = false;
  }

  /** Record `state` as already written (the database matches it), without producing rows. */
  prime(state: View): void {
    this.delta(state, true);
  }

  /** Compute the rows to write. `full` forces a complete rebuild. */
  delta(state: View, full = false): ProjectionDelta {
    // An unprimed tracker does not know which rows exist, so it must rebuild everything.
    const isFull = full || !this.primed;
    if (isFull) this.clear();
    const generation = ++this.generation;
    const removed: ProjectionDelta['removed'] = { buildings: [], households: [], citizens: [] };
    const delta: ProjectionDelta = {
      full: isFull,
      buildings: diffRows(
        this.buildings,
        state.buildings,
        buildingRow,
        generation,
        removed.buildings,
      ),
      households: diffRows(
        this.households,
        state.households,
        householdRow,
        generation,
        removed.households,
      ),
      citizens: diffRows(this.citizens, state.citizens, citizenRow, generation, removed.citizens),
      skills: this.diffSkills(state, generation),
      removed,
    };
    if (isFull) delta.removed = { buildings: [], households: [], citizens: [] };
    this.primed = true;
    return delta;
  }

  /** Changed skill rows; skill rows of removed citizens disappear with them (ON DELETE CASCADE). */
  private diffSkills(state: View, generation: number): Content[] {
    const rows: Content[] = [];
    for (const c of state.citizens) {
      const levels = SKILLS.map((skill) => c.skills[skill]);
      const before = this.skills.get(c.id);
      if (before) before.seen = generation;
      else this.skills.set(c.id, { value: levels, seen: generation });
      for (let i = 0; i < levels.length; i++) {
        if (before && before.value[i] === levels[i]) continue;
        rows.push([c.id, SKILL_DB[i], levels[i]]);
      }
      if (before) before.value = levels;
    }
    if (this.skills.size !== state.citizens.length) {
      for (const [id, entry] of this.skills) if (entry.seen !== generation) this.skills.delete(id);
    }
    return rows;
  }

  private clear(): void {
    this.buildings.clear();
    this.households.clear();
    this.citizens.clear();
    this.skills.clear();
  }
}

/** Apply a projection delta inside the checkpoint transaction. */
export async function writeProjection(
  tx: Tx,
  civilizationId: string,
  tick: number,
  delta: ProjectionDelta,
): Promise<void> {
  if (delta.full) {
    await tx.citizenSkill.deleteMany({ where: { civilizationId } });
    await tx.citizen.deleteMany({ where: { civilizationId } });
    await tx.household.deleteMany({ where: { civilizationId } });
    await tx.building.deleteMany({ where: { civilizationId } });
  } else {
    const { citizens, households, buildings } = delta.removed;
    if (citizens.length)
      await tx.citizen.deleteMany({ where: { civilizationId, id: { in: citizens } } });
    if (households.length)
      await tx.household.deleteMany({ where: { civilizationId, id: { in: households } } });
    if (buildings.length)
      await tx.building.deleteMany({ where: { civilizationId, id: { in: buildings } } });
  }
  const withTick = (rows: Content[]) => rows.map((r) => [civilizationId, ...r, tick]);
  await upsertRows(tx, BUILDING, withTick(delta.buildings));
  await upsertRows(tx, HOUSEHOLD, withTick(delta.households));
  await upsertRows(tx, CITIZEN, withTick(delta.citizens));
  await upsertRows(
    tx,
    CITIZEN_SKILL,
    delta.skills.map((r) => [civilizationId, ...r]),
  );
}
