import { SKILLS, type WorldState } from '@civ/sim-core';
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

/** Row content without the civilization id and the updated tick (used for change detection). */
type Content = unknown[];

interface Entry {
  key: string;
  content: Content;
}

function buildingEntries(state: Readonly<WorldState>): Entry[] {
  return state.buildings.map((b) => ({
    key: `b:${b.id}`,
    content: [b.id, toDbEnum(b.kind), b.name, b.x, b.y, b.width, b.height, b.capacity],
  }));
}

function householdEntries(state: Readonly<WorldState>): Entry[] {
  return state.households.map((h) => ({ key: `h:${h.id}`, content: [h.id, h.homeId] }));
}

function citizenEntries(state: Readonly<WorldState>): Entry[] {
  return state.citizens.map((c) => ({
    key: `c:${c.id}`,
    content: [
      c.id,
      c.firstName,
      c.lastName,
      c.householdId,
      c.birthTick,
      toDbEnum(c.lifeStage),
      toDbEnum(c.education),
      c.homeId,
      c.personality.openness,
      c.personality.conscientiousness,
      c.personality.extraversion,
      c.personality.agreeableness,
      c.personality.neuroticism,
      c.balanceCents,
      c.needs.energy,
      toDbEnum(c.activity),
      c.locationId,
      c.travel ? c.travel.toId : null,
    ],
  }));
}

function skillEntries(state: Readonly<WorldState>): Entry[] {
  const out: Entry[] = [];
  for (const c of state.citizens) {
    for (const skill of SKILLS) {
      out.push({ key: `s:${c.id}:${skill}`, content: [c.id, toDbEnum(skill), c.skills[skill]] });
    }
  }
  return out;
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

/**
 * Tracks what was last written so that each checkpoint only rewrites changed rows.
 * The tracker is updated optimistically when a delta is computed; if the write
 * fails, call reset() so the next delta rewrites every row.
 */
export class ProjectionTracker {
  private written = new Map<string, string>();
  private primed = false;

  reset(): void {
    this.written.clear();
    this.primed = false;
  }

  /** Compute the rows to write. `full` forces a complete rebuild. */
  delta(state: Readonly<WorldState>, full = false): ProjectionDelta {
    if (full) this.reset();
    const isFull = full;
    const seen = new Set<string>();
    const changed = (entries: Entry[]): Content[] => {
      const rows: Content[] = [];
      for (const e of entries) {
        seen.add(e.key);
        const signature = JSON.stringify(e.content);
        if (this.written.get(e.key) !== signature) {
          this.written.set(e.key, signature);
          rows.push(e.content);
        }
      }
      return rows;
    };
    const delta: ProjectionDelta = {
      full: isFull,
      buildings: changed(buildingEntries(state)),
      households: changed(householdEntries(state)),
      citizens: changed(citizenEntries(state)),
      skills: changed(skillEntries(state)),
      removed: { buildings: [], households: [], citizens: [] },
    };
    if (this.primed && !isFull) {
      for (const key of [...this.written.keys()]) {
        if (seen.has(key)) continue;
        this.written.delete(key);
        const [kind, id] = key.split(':');
        if (kind === 'b') delta.removed.buildings.push(Number(id));
        else if (kind === 'h') delta.removed.households.push(Number(id));
        else if (kind === 'c') delta.removed.citizens.push(Number(id));
        // Skill rows disappear with their citizen (ON DELETE CASCADE).
      }
    }
    this.primed = true;
    return delta;
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
