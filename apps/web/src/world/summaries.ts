import { ACTIVITY_BY_CODE, type Activity, type CitizenFrameTuple } from '@civ/sim-core';
import type { LayoutResponse } from '@civ/shared';
import { T_ACTIVITY, T_LOCATION, T_TO } from './frame-store';
import { ACTIVITY_LABELS, BUILDING_KIND_LABELS } from './palette';
import type { Selection } from './types';

/*
 * Text shown in the map overlays (legend counts, hover tooltip), derived from the
 * layout and the latest frame (pure; no DOM).
 */

export type ActivityCounts = Record<Activity, number>;

export function countActivities(citizens: Iterable<CitizenFrameTuple>): ActivityCounts {
  const counts: ActivityCounts = { sleeping: 0, at_home: 0, leisure: 0, traveling: 0 };
  for (const t of citizens) {
    const activity = ACTIVITY_BY_CODE[t[T_ACTIVITY]];
    if (activity) counts[activity]++;
  }
  return counts;
}

/** Number of citizens currently inside a building. */
export function presentIn(citizens: Iterable<CitizenFrameTuple>, buildingId: number): number {
  let n = 0;
  for (const t of citizens) if (t[T_LOCATION] === buildingId) n++;
  return n;
}

export interface HoverText {
  title: string;
  lines: string[];
}

/**
 * Tooltip text for a hovered entity. `citizens` is the latest frame (null before the
 * first keyframe); unknown entities yield null.
 */
export function describeHover(
  target: Selection,
  layout: Pick<LayoutResponse, 'buildings' | 'households'>,
  citizens: ReadonlyMap<number, CitizenFrameTuple> | null,
  citizenLabel?: (id: number) => string | undefined,
): HoverText | null {
  const buildingName = (id: number): string | undefined =>
    layout.buildings.find((b) => b.id === id)?.name;

  if (target.kind === 'building') {
    const b = layout.buildings.find((x) => x.id === target.id);
    if (!b) return null;
    const lines = [`${BUILDING_KIND_LABELS[b.kind]} · capacity ${b.capacity}`];
    if (citizens) {
      const present = presentIn(citizens.values(), b.id);
      lines.push(`${present} ${present === 1 ? 'person' : 'people'} here now`);
    }
    if (b.kind === 'house') {
      const household = layout.households.find((h) => h.homeId === b.id);
      lines.push(household ? `${household.surname} household` : 'Vacant');
    }
    return { title: b.name, lines };
  }

  const tuple = citizens?.get(target.id);
  const title = citizenLabel?.(target.id) ?? `Citizen #${target.id}`;
  if (!tuple) return { title, lines: [] };
  const activity = ACTIVITY_BY_CODE[tuple[T_ACTIVITY]];
  const lines: string[] = [];
  if (activity) lines.push(ACTIVITY_LABELS[activity]);
  const location = tuple[T_LOCATION];
  if (location !== 0) {
    const here = buildingName(location);
    if (here) lines.push(`at ${here}`);
  } else {
    const destination = buildingName(tuple[T_TO]);
    if (destination) lines.push(`to ${destination}`);
  }
  return { title, lines };
}
