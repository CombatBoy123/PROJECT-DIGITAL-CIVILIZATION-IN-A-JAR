import type { EventLog } from '../events/log.js';
import { rngFor, type Rng } from '../rng/rng.js';
import type { Building, Citizen, Household, WorldState } from '../state/schema.js';
import type { Calendar } from '../time/clock.js';

/**
 * Derived lookup structures. Never serialised; rebuilt from state whenever a
 * simulation is created or restored, and kept in sync when entities are added.
 */
export class WorldIndex {
  readonly buildings = new Map<number, Building>();
  readonly citizens = new Map<number, Citizen>();
  readonly households = new Map<number, Household>();
  /** Public venues (plazas and parks) in ascending id order. */
  readonly venues: Building[] = [];

  constructor(state: WorldState) {
    for (const b of state.buildings) {
      this.buildings.set(b.id, b);
      if (b.kind === 'plaza' || b.kind === 'park') this.venues.push(b);
    }
    for (const c of state.citizens) this.citizens.set(c.id, c);
    for (const h of state.households) this.households.set(h.id, h);
  }

  building(id: number): Building {
    const b = this.buildings.get(id);
    if (!b) throw new Error(`Unknown building ${id}`);
    return b;
  }
}

/** Everything a system may use while processing one tick. */
export interface TickContext {
  readonly state: WorldState;
  readonly index: WorldIndex;
  /** The tick being produced by this step. */
  readonly tick: number;
  readonly calendar: Calendar;
  readonly events: EventLog;
  /** Keyed random stream for this tick: hash(seed, stream, tick, ...keys). */
  rng(stream: string, ...keys: ReadonlyArray<string | number>): Rng;
}

export function createTickContext(
  state: WorldState,
  index: WorldIndex,
  tick: number,
  calendar: Calendar,
  events: EventLog,
): TickContext {
  return {
    state,
    index,
    tick,
    calendar,
    events,
    rng: (stream, ...keys) => rngFor(state.seed, stream, tick, ...keys),
  };
}

/** A pipeline stage. Systems mutate state in place and emit events. */
export interface SimSystem {
  /** Stable identifier, used in docs and diagnostics. */
  readonly name: string;
  /** Position in the documented update order (see ARCHITECTURE.md §5.2). */
  readonly stage: number;
  run(ctx: TickContext): void;
}
