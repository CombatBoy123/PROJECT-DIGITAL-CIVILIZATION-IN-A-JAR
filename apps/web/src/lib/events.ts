import {
  EVENT_CATALOG,
  type EntityRef,
  type EventCategory,
  type EventType,
  type EventTypeInfo,
} from '@civ/sim-core';
import type { EventDto } from '@civ/shared';
import { formatCents, formatDecimal, formatInteger, humanize } from './format';

/*
 * Pure helpers for presenting the event log: readable payload summaries, merging the
 * live stream with paginated history, and category filtering. Payloads come from the
 * server as untrusted JSON, so every field is read defensively.
 */

export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'genesis',
  'environment',
  'demography',
  'economy',
];

/** Catalogue entry for a type, or a generic fallback for types this client does not know. */
export function eventInfo(type: string): EventTypeInfo {
  return (
    (EVENT_CATALOG as Record<string, EventTypeInfo | undefined>)[type] ?? {
      category: 'genesis',
      label: humanize(type),
      description: 'Event type not described by this client version.',
    }
  );
}

/** Event types belonging to a category, for the API `types` filter. */
export function typesInCategory(category: EventCategory): EventType[] {
  return (Object.keys(EVENT_CATALOG) as EventType[]).filter(
    (t) => EVENT_CATALOG[t].category === category,
  );
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Generic "key: value" rendering for payloads without a dedicated summary. */
function genericSummary(payload: Record<string, unknown>): string {
  const parts = Object.entries(payload)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${humanize(k).toLowerCase()}: ${String(v)}`);
  return parts.join(' · ');
}

/** One-line, human-readable summary of an event's payload. */
export function summarizeEvent(event: Pick<EventDto, 'type' | 'payload'>): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'CivilizationFounded': {
      const population = num(p.population);
      const households = num(p.households);
      const buildings = num(p.buildings);
      const w = num(p.mapWidth);
      const h = num(p.mapHeight);
      if (population === undefined || households === undefined || buildings === undefined) break;
      const map = w !== undefined && h !== undefined ? ` on a ${w}×${h} map` : '';
      const seed = str(p.seed) ? `Seed "${str(p.seed)}": ` : '';
      return `${seed}${formatInteger(population)} citizens in ${formatInteger(households)} households, ${formatInteger(buildings)} buildings${map}`;
    }
    case 'CitizenCreated': {
      const first = str(p.firstName);
      const last = str(p.lastName);
      const age = num(p.ageYears);
      const stage = str(p.lifeStage);
      if (!first || !last || age === undefined) break;
      const household = num(p.householdId);
      return `${first} ${last}, age ${age}${stage ? ` (${stage})` : ''}${household !== undefined ? `, household #${household}` : ''}`;
    }
    case 'MoneyIssued': {
      const amount = num(p.amountCents);
      if (amount === undefined) break;
      const reason = str(p.reason);
      return `${formatCents(amount)} issued${reason ? ` (${humanize(reason).toLowerCase()})` : ''}`;
    }
    case 'SeasonStarted': {
      const season = str(p.season);
      const year = num(p.year);
      if (!season || year === undefined) break;
      return `${humanize(season)} of year ${year} began`;
    }
    case 'WeatherChanged': {
      const from = str(p.from);
      const to = str(p.to);
      const temp = num(p.dailyMeanTempC);
      if (!from || !to) break;
      return `${from} → ${to}${temp !== undefined ? `, daily mean ${formatDecimal(temp, 1)} °C` : ''}`;
    }
    case 'LifeStageChanged': {
      const from = str(p.from);
      const to = str(p.to);
      const age = num(p.ageYears);
      if (!from || !to) break;
      return `${from} → ${to}${age !== undefined ? ` at age ${age}` : ''}`;
    }
  }
  return genericSummary(p);
}

/** "citizen #12" — role is shown separately where space allows. */
export function refLabel(ref: Pick<EntityRef, 'kind' | 'id'>): string {
  return `${ref.kind} #${ref.id}`;
}

/** Only citizens and buildings have inspectors; households are shown as plain text. */
export function isSelectableRef(
  ref: Pick<EntityRef, 'kind'>,
): ref is Pick<EntityRef, 'id' | 'role'> & { kind: 'citizen' | 'building' } {
  return ref.kind === 'citizen' || ref.kind === 'building';
}

/**
 * Merge event lists (e.g. live stream + history pages) into one list, newest first,
 * with each `seq` appearing once. When duplicates disagree, the first list wins.
 */
export function mergeEvents(...lists: readonly (readonly EventDto[])[]): EventDto[] {
  const bySeq = new Map<number, EventDto>();
  for (const list of lists) {
    for (const event of list) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/** Keep the newest `max` events of a list that is already sorted newest first. */
export function capEvents(events: readonly EventDto[], max: number): EventDto[] {
  return events.length > max ? events.slice(0, max) : [...events];
}

/** Whether an event passes the feed's category filter (null = all categories). */
export function matchesCategory(event: EventDto, category: EventCategory | null): boolean {
  return category === null || eventInfo(event.type).category === category;
}
