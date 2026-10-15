import type { SimEvent } from '../events/types.js';
import { ageInYears, lifeStageForAge } from '../systems/demography.js';
import type { WorldState } from '../state/schema.js';
import { isRoad } from '../world/roads.js';

/*
 * Invariants: properties that must hold after every tick. A violation means the
 * state is impossible (a bug or corrupted input), so the engine refuses to
 * continue rather than producing results from it. See ARCHITECTURE.md §8.
 */

export type InvariantCode =
  | 'CLOCK'
  | 'IDENTITY'
  | 'NEGATIVE_BALANCE'
  | 'MONEY_CONSERVATION'
  | 'HOUSING'
  | 'LOCATION'
  | 'VENUE_CAPACITY'
  | 'NEEDS_BOUNDS'
  | 'LIFE_STAGE'
  | 'MAP'
  | 'EVENT_SEQUENCE';

export interface InvariantViolation {
  code: InvariantCode;
  message: string;
  entity?: { kind: 'citizen' | 'building' | 'household'; id: number };
}

export class InvariantViolationError extends Error {
  constructor(
    readonly tick: number,
    readonly violations: readonly InvariantViolation[],
  ) {
    super(
      `Invariant violation at tick ${tick}: ${violations
        .slice(0, 5)
        .map((v) => `[${v.code}] ${v.message}`)
        .join('; ')}${violations.length > 5 ? ` (+${violations.length - 5} more)` : ''}`,
    );
    this.name = 'InvariantViolationError';
  }
}

/** Maximum violations reported per check, to keep reports readable. */
const MAX_VIOLATIONS = 50;

function checkSortedUnique(
  list: readonly { id: number }[],
  nextId: number,
  kind: 'citizen' | 'building' | 'household' | 'block',
  out: InvariantViolation[],
): void {
  let previous = 0;
  for (const item of list) {
    if (!Number.isInteger(item.id) || item.id <= previous) {
      out.push({
        code: 'IDENTITY',
        message: `${kind} ids must be unique and ascending (saw ${item.id} after ${previous})`,
      });
      return;
    }
    previous = item.id;
  }
  if (previous >= nextId) {
    out.push({
      code: 'IDENTITY',
      message: `${kind} id ${previous} is not below next id ${nextId}`,
    });
  }
}

export function checkInvariants(state: WorldState): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const push = (v: InvariantViolation): void => {
    if (out.length < MAX_VIOLATIONS) out.push(v);
  };

  // Clock
  if (!Number.isInteger(state.tick) || state.tick < 0)
    push({ code: 'CLOCK', message: `Invalid tick ${state.tick}` });

  // Identity
  checkSortedUnique(state.citizens, state.nextIds.citizen, 'citizen', out);
  checkSortedUnique(state.buildings, state.nextIds.building, 'building', out);
  checkSortedUnique(state.households, state.nextIds.household, 'household', out);
  checkSortedUnique(state.map.blocks, state.nextIds.block, 'block', out);

  // Map: buildings inside the map and inside their block; doors on roads.
  const blocks = new Map(state.map.blocks.map((b) => [b.id, b]));
  const buildings = new Map(state.buildings.map((b) => [b.id, b]));
  for (const b of state.buildings) {
    const block = blocks.get(b.blockId);
    const inside =
      block !== undefined &&
      b.x >= block.x &&
      b.y >= block.y &&
      b.x + b.width <= block.x + state.map.blockSize &&
      b.y + b.height <= block.y + state.map.blockSize;
    if (!inside)
      push({
        code: 'MAP',
        message: `Building ${b.id} lies outside its block`,
        entity: { kind: 'building', id: b.id },
      });
    const doorOk =
      b.door.x < state.map.width &&
      b.door.y < state.map.height &&
      isRoad(state.map, b.door.x, b.door.y);
    if (!doorOk)
      push({
        code: 'MAP',
        message: `Building ${b.id} door is not on a road`,
        entity: { kind: 'building', id: b.id },
      });
  }

  // Households
  const households = new Map(state.households.map((h) => [h.id, h]));
  for (const h of state.households) {
    const home = buildings.get(h.homeId);
    if (!home || home.kind !== 'house') {
      push({
        code: 'HOUSING',
        message: `Household ${h.id} home ${h.homeId} is not a house`,
        entity: { kind: 'household', id: h.id },
      });
    }
  }

  // Citizens
  let balanceTotal = 0;
  const residents = new Map<number, number>();
  const venueLoad = new Map<number, number>();
  for (const c of state.citizens) {
    const entity = { kind: 'citizen' as const, id: c.id };

    if (!Number.isSafeInteger(c.balanceCents)) {
      push({
        code: 'NEGATIVE_BALANCE',
        message: `Citizen ${c.id} balance is not an integer number of cents`,
        entity,
      });
    } else if (c.balanceCents < 0) {
      push({
        code: 'NEGATIVE_BALANCE',
        message: `Citizen ${c.id} has negative balance ${c.balanceCents}`,
        entity,
      });
    }
    balanceTotal += c.balanceCents;

    const home = buildings.get(c.homeId);
    const household = households.get(c.householdId);
    if (!home || home.kind !== 'house') {
      push({ code: 'HOUSING', message: `Citizen ${c.id} home ${c.homeId} is not a house`, entity });
    } else {
      residents.set(home.id, (residents.get(home.id) ?? 0) + 1);
    }
    if (!household || household.homeId !== c.homeId) {
      push({
        code: 'HOUSING',
        message: `Citizen ${c.id} does not live in its household's home`,
        entity,
      });
    }

    if (c.travel) {
      const t = c.travel;
      if (c.locationId !== null || c.activity !== 'traveling') {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} is travelling but also located/active elsewhere`,
          entity,
        });
      }
      if (!buildings.has(t.fromId) || !buildings.has(t.toId)) {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} travels between unknown buildings`,
          entity,
        });
      }
      if (!(
        t.departTick < t.arriveTick &&
        t.departTick <= state.tick &&
        state.tick < t.arriveTick
      )) {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} trip window [${t.departTick}, ${t.arriveTick}) does not contain tick ${state.tick}`,
          entity,
        });
      }
      if (t.toId !== c.homeId) venueLoad.set(t.toId, (venueLoad.get(t.toId) ?? 0) + 1);
    } else {
      const here = c.locationId === null ? undefined : buildings.get(c.locationId);
      if (!here) {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} is nowhere (location ${c.locationId})`,
          entity,
        });
      } else if (c.activity === 'traveling') {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} is marked travelling without a trip`,
          entity,
        });
      } else if ((c.activity === 'sleeping' || c.activity === 'at_home') && here.id !== c.homeId) {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} is ${c.activity} outside its home`,
          entity,
        });
      } else if (c.activity === 'leisure' && here.kind !== 'plaza' && here.kind !== 'park') {
        push({
          code: 'LOCATION',
          message: `Citizen ${c.id} is at leisure in a non-venue building`,
          entity,
        });
      }
      if (here && here.id !== c.homeId) venueLoad.set(here.id, (venueLoad.get(here.id) ?? 0) + 1);
    }
    if (c.activitySince > state.tick) {
      push({ code: 'CLOCK', message: `Citizen ${c.id} activity starts in the future`, entity });
    }

    if (!Number.isFinite(c.needs.energy) || c.needs.energy < 0 || c.needs.energy > 100) {
      push({
        code: 'NEEDS_BOUNDS',
        message: `Citizen ${c.id} energy ${c.needs.energy} outside [0, 100]`,
        entity,
      });
    }

    const expectedStage = lifeStageForAge(ageInYears(c, state.tick, state.config), state.config);
    if (c.lifeStage !== expectedStage) {
      push({
        code: 'LIFE_STAGE',
        message: `Citizen ${c.id} is ${c.lifeStage} but age implies ${expectedStage}`,
        entity,
      });
    }
  }

  for (const [houseId, count] of residents) {
    const house = buildings.get(houseId);
    if (house && count > house.capacity) {
      push({
        code: 'HOUSING',
        message: `House ${houseId} has ${count} residents but capacity ${house.capacity}`,
        entity: { kind: 'building', id: houseId },
      });
    }
  }
  for (const [venueId, count] of venueLoad) {
    const venue = buildings.get(venueId);
    if (venue && count > venue.capacity) {
      push({
        code: 'VENUE_CAPACITY',
        message: `Venue ${venueId} has ${count} visitors but capacity ${venue.capacity}`,
        entity: { kind: 'building', id: venueId },
      });
    }
  }

  // Money conservation
  if (state.ledger.destroyedCents > state.ledger.issuedCents) {
    push({ code: 'MONEY_CONSERVATION', message: 'More money destroyed than issued' });
  }
  const expectedSupply = state.ledger.issuedCents - state.ledger.destroyedCents;
  if (balanceTotal !== expectedSupply) {
    push({
      code: 'MONEY_CONSERVATION',
      message: `Money supply ${balanceTotal} ≠ issued − destroyed ${expectedSupply}`,
    });
  }

  return out;
}

/** Events of one step: contiguous, increasing sequence numbers, all stamped with the step's tick. */
export function checkEventSequence(
  events: readonly SimEvent[],
  firstSeq: number,
  tick: number,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  let expected = firstSeq;
  for (const e of events) {
    if (e.seq !== expected) {
      out.push({
        code: 'EVENT_SEQUENCE',
        message: `Event seq ${e.seq} where ${expected} was expected`,
      });
      break;
    }
    if (e.tick !== tick) {
      out.push({
        code: 'EVENT_SEQUENCE',
        message: `Event ${e.seq} stamped tick ${e.tick} during tick ${tick}`,
      });
      break;
    }
    expected++;
  }
  return out;
}
