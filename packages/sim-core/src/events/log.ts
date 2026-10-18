import type { WorldState } from '../state/schema.js';
import type { EntityRef, EventPayloads, EventType, SimEvent } from './types.js';

/**
 * Collects the events emitted during one step. Sequence numbers come from the world
 * state (`nextEventSeq`), so they continue seamlessly across snapshots and restores.
 */
export class EventLog {
  private readonly events: SimEvent[] = [];

  constructor(
    private readonly state: WorldState,
    private readonly tick: number,
  ) {}

  /** Record an event and return its sequence number (usable as `causeSeq` for effects). */
  emit<K extends EventType>(
    type: K,
    payload: EventPayloads[K],
    refs: EntityRef[] = [],
    causeSeq: number | null = null,
  ): number {
    const seq = this.state.nextEventSeq;
    this.state.nextEventSeq = seq + 1;
    this.events.push({ seq, tick: this.tick, type, payload, refs, causeSeq } as SimEvent);
    return seq;
  }

  get list(): readonly SimEvent[] {
    return this.events;
  }
}
