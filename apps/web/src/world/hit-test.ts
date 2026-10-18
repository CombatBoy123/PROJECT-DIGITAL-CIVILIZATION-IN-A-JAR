import type { Building } from '@civ/sim-core';
import type { Selection } from './types';
import { buildingRect, rectContains } from './geometry';

/*
 * Picking (pure; no PixiJS). All coordinates are world pixels; the tolerance is
 * given in screen pixels and converted with the current zoom, so targets stay easy
 * to hit at every zoom level. Citizens win over buildings because they are drawn
 * on top of them, but inside a building's footprint only a direct hit on a dot
 * counts: occupants' dots (plus slack) would otherwise cover most of a busy
 * building at overview zoom and make the building itself impossible to pick.
 */

/** A citizen's rendered position. `visible: false` entries are ignored. */
export interface CitizenPoint {
  id: number;
  x: number;
  y: number;
  visible: boolean;
}

export interface HitTestOptions {
  /** Current zoom (screen px per world px). */
  zoom: number;
  /** Rendered citizen radius in screen pixels. */
  citizenRadiusPx: number;
  /** Extra screen-pixel slack around targets. */
  tolerancePx: number;
}

/**
 * Nearest visible citizen within (radius + tolerance) of the point, or null. Ties
 * go to the lower id so the result is stable.
 */
export function hitTestCitizens(
  citizens: Iterable<CitizenPoint>,
  wx: number,
  wy: number,
  options: HitTestOptions,
): number | null {
  const reach = (options.citizenRadiusPx + options.tolerancePx) / options.zoom;
  const reach2 = reach * reach;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const c of citizens) {
    if (!c.visible) continue;
    const dx = c.x - wx;
    const dy = c.y - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach2) continue;
    if (d2 < bestDistance || (d2 === bestDistance && best !== null && c.id < best)) {
      best = c.id;
      bestDistance = d2;
    }
  }
  return best;
}

/**
 * Building whose footprint contains the point. Footprints do not overlap, so an
 * exact hit is unique; otherwise the nearest footprint within the tolerance wins.
 */
export function hitTestBuildings(
  buildings: readonly Pick<Building, 'id' | 'x' | 'y' | 'width' | 'height'>[],
  wx: number,
  wy: number,
  options: Pick<HitTestOptions, 'zoom' | 'tolerancePx'>,
): number | null {
  const tolerance = options.tolerancePx / options.zoom;
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const b of buildings) {
    const r = buildingRect(b);
    if (!rectContains(r, wx, wy, tolerance)) continue;
    const dx = Math.max(r.x - wx, 0, wx - (r.x + r.width));
    const dy = Math.max(r.y - wy, 0, wy - (r.y + r.height));
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      best = b.id;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Citizen first, then building; null for empty ground. Inside a footprint a citizen
 * needs a direct hit (no tolerance); elsewhere (roads, open ground) the tolerance applies.
 */
export function hitTest(
  citizens: Iterable<CitizenPoint>,
  buildings: readonly Pick<Building, 'id' | 'x' | 'y' | 'width' | 'height'>[],
  wx: number,
  wy: number,
  options: HitTestOptions,
): Selection | null {
  const inside = hitTestBuildings(buildings, wx, wy, { zoom: options.zoom, tolerancePx: 0 });
  const citizen = hitTestCitizens(
    citizens,
    wx,
    wy,
    inside !== null ? { ...options, tolerancePx: 0 } : options,
  );
  if (citizen !== null) return { kind: 'citizen', id: citizen };
  const building = inside ?? hitTestBuildings(buildings, wx, wy, options);
  return building !== null ? { kind: 'building', id: building } : null;
}
