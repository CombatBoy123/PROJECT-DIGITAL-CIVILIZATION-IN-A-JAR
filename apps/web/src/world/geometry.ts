import {
  pointAlongRoute,
  roadRoute,
  type Building,
  type Point,
  type WorldMap,
} from '@civ/sim-core';
import type { Rect, Vec2 } from './camera';

/*
 * Mapping from engine tile coordinates to renderer world pixels (pure; no PixiJS).
 *
 * A tile (x, y) covers the world-pixel square [x·TILE_PX, (x+1)·TILE_PX) ×
 * [y·TILE_PX, (y+1)·TILE_PX). Buildings cover their whole footprint; road positions
 * (doors, route waypoints) refer to the centre of their road tile.
 *
 * Everything here is presentation: positions inside a building and along a road are
 * derived from the frame data and never fed back into the simulation.
 */

/** World pixels per tile. */
export const TILE_PX = 16;

export function tileToWorld(t: number): number {
  return t * TILE_PX;
}

/** World coordinate of the centre of tile coordinate t (works for fractional t). */
export function tileCentreToWorld(t: number): number {
  return (t + 0.5) * TILE_PX;
}

export function worldToTile(w: number): number {
  return Math.floor(w / TILE_PX);
}

/** The whole map in world pixels. */
export function mapBounds(map: Pick<WorldMap, 'width' | 'height'>): Rect {
  return { x: 0, y: 0, width: map.width * TILE_PX, height: map.height * TILE_PX };
}

export function buildingRect(b: Pick<Building, 'x' | 'y' | 'width' | 'height'>): Rect {
  return {
    x: b.x * TILE_PX,
    y: b.y * TILE_PX,
    width: b.width * TILE_PX,
    height: b.height * TILE_PX,
  };
}

export function buildingCentre(b: Pick<Building, 'x' | 'y' | 'width' | 'height'>): Vec2 {
  return { x: (b.x + b.width / 2) * TILE_PX, y: (b.y + b.height / 2) * TILE_PX };
}

export function rectContains(r: Rect, x: number, y: number, tolerance = 0): boolean {
  return (
    x >= r.x - tolerance &&
    x <= r.x + r.width + tolerance &&
    y >= r.y - tolerance &&
    y <= r.y + r.height + tolerance
  );
}

/** Inner margin (world px) between a building's footprint and its citizen slots. */
export const SLOT_INSET: Readonly<Record<Building['kind'], number>> = {
  house: 12,
  plaza: 10,
  park: 10,
};

/**
 * Centres of `count` slots arranged in a grid inside `rect` (row-major, left to
 * right, top to bottom). The grid's aspect follows the rectangle, so slots are
 * spread evenly; an incomplete last row is centred. Deterministic for equal inputs.
 */
export function gridSlots(rect: Rect, count: number): Vec2[] {
  if (count <= 0) return [];
  const aspect = rect.width / Math.max(1e-9, rect.height);
  const cols = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * aspect))));
  const rows = Math.ceil(count / cols);
  const cellW = rect.width / cols;
  const cellH = rect.height / rows;
  const slots: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const rowOffset = ((cols - inRow) * cellW) / 2;
    slots.push({
      x: rect.x + rowOffset + (col + 0.5) * cellW,
      y: rect.y + (row + 0.5) * cellH,
    });
  }
  return slots;
}

/** Fountain radius as a fraction of a plaza's paved side (drawn in static-layers.ts). */
export const FOUNTAIN_RADIUS_FRACTION = 0.17;
/** Plaza paving inset from the footprint edge, in world px. */
export const PLAZA_PAVING_INSET = 2;

/** Radius (world px) around a plaza's centre kept free of citizens: fountain plus a margin. */
export function plazaKeepClearRadius(b: Pick<Building, 'width' | 'height'>): number {
  const side = Math.min(b.width, b.height) * TILE_PX - 2 * PLAZA_PAVING_INSET;
  return side * FOUNTAIN_RADIUS_FRACTION + 6;
}

/**
 * Slot positions for citizens present in a building. The grid is sized for
 * max(capacity, present) so the arrangement does not reshuffle as people come and
 * go; citizen i (in ascending id order) takes slot i. On plazas the cells over the
 * fountain are skipped (the grid is refined until enough cells remain).
 */
export function buildingSlots(
  b: Pick<Building, 'kind' | 'x' | 'y' | 'width' | 'height' | 'capacity'>,
  present: number,
): Vec2[] {
  const r = buildingRect(b);
  const inset = Math.min(SLOT_INSET[b.kind], r.width / 4, r.height / 4);
  const inner = {
    x: r.x + inset,
    y: r.y + inset,
    width: r.width - 2 * inset,
    height: r.height - 2 * inset,
  };
  const needed = Math.max(b.capacity, present);
  if (b.kind !== 'plaza') return gridSlots(inner, needed).slice(0, present);
  const centre = buildingCentre(b);
  const clear = plazaKeepClearRadius(b);
  const outside = (p: Vec2): boolean => Math.hypot(p.x - centre.x, p.y - centre.y) > clear;
  for (let cells = needed; ; cells++) {
    const slots = gridSlots(inner, cells).filter(outside);
    if (slots.length >= needed) return slots.slice(0, present);
  }
}

/**
 * Group located citizens by building, each group sorted by citizen id, from
 * (citizenId, locationId) pairs. Citizens with locationId 0 (travelling) are skipped.
 */
export function groupByLocation(
  entries: Iterable<readonly [citizenId: number, locationId: number]>,
): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (const [citizenId, locationId] of entries) {
    if (locationId === 0) continue;
    const group = groups.get(locationId);
    if (group) group.push(citizenId);
    else groups.set(locationId, [citizenId]);
  }
  for (const group of groups.values()) group.sort((a, b) => a - b);
  return groups;
}

/**
 * Road route (tile coordinates) the engine timed for a trip between two buildings:
 * the same `roadRoute` call the routine system uses, from door to door.
 */
export function tripRoute(
  map: Pick<WorldMap, 'roadPitch' | 'cols'>,
  from: Pick<Building, 'door'>,
  to: Pick<Building, 'door'>,
): Point[] {
  return roadRoute(map, from.door, to.door);
}

/** Fraction of a trip completed at `renderTick`, clamped to [0, 1]. */
export function tripProgress(renderTick: number, departTick: number, arriveTick: number): number {
  if (arriveTick <= departTick) return 1;
  const t = (renderTick - departTick) / (arriveTick - departTick);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * World-pixel position of a travelling citizen at a (fractional) render tick: the
 * engine route sampled with `pointAlongRoute` at the trip's progress, placed at the
 * centre of the road tile. Presentation only — the engine moves citizens in whole
 * ticks; this interpolates between them.
 */
export function travellerPosition(
  route: readonly Point[],
  renderTick: number,
  departTick: number,
  arriveTick: number,
): Vec2 {
  const p = pointAlongRoute(route, tripProgress(renderTick, departTick, arriveTick));
  return { x: tileCentreToWorld(p.x), y: tileCentreToWorld(p.y) };
}
