import type { Point, WorldMap } from '../state/schema.js';

/*
 * Road network. Roads form a regular grid: every tile with x % pitch = 0 or
 * y % pitch = 0 is road. Every building door lies on a horizontal road
 * (y % pitch = 0), which makes shortest road routes easy to construct:
 * along the door's road to a vertical road, along that vertical road to the
 * destination's row, then along the destination's road to its door.
 *
 * The same function is used by the engine (to compute travel time) and by the
 * renderer (to animate citizens), so what the user sees is the route the engine
 * timed.
 */

export function isRoad(map: Pick<WorldMap, 'roadPitch'>, x: number, y: number): boolean {
  return x % map.roadPitch === 0 || y % map.roadPitch === 0;
}

/** Waypoints of the road route between two doors (inclusive of both ends). */
export function roadRoute(
  map: Pick<WorldMap, 'roadPitch' | 'cols'>,
  from: Point,
  to: Point,
): Point[] {
  if (from.x === to.x && from.y === to.y) return [from];
  if (from.y === to.y) return [from, to];
  const pitch = map.roadPitch;
  const maxX = map.cols * pitch;
  // Choose the vertical road that minimises |from.x − v| + |v − to.x|.
  // Any road between the two x positions is optimal; otherwise the nearest one.
  const lo = Math.min(from.x, to.x);
  const hi = Math.max(from.x, to.x);
  let v = Math.ceil(lo / pitch) * pitch;
  if (v > hi) {
    const below = Math.floor(lo / pitch) * pitch;
    const above = Math.min(maxX, Math.ceil(hi / pitch) * pitch);
    v = lo - below <= above - hi ? below : above;
  }
  const points: Point[] = [from];
  if (v !== from.x) points.push({ x: v, y: from.y });
  points.push({ x: v, y: to.y });
  if (v !== to.x) points.push(to);
  return points;
}

/** Manhattan length of a route in tiles. */
export function routeLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  return length;
}

/** Position at fraction t ∈ [0, 1] along a route (used for rendering only). */
export function pointAlongRoute(points: readonly Point[], t: number): { x: number; y: number } {
  const first = points[0];
  if (!first) throw new RangeError('pointAlongRoute: empty route');
  const total = routeLength(points);
  if (total === 0 || t <= 0) return { x: first.x, y: first.y };
  let remaining = Math.min(1, t) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const segment = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (remaining <= segment) {
      const f = segment === 0 ? 0 : remaining / segment;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= segment;
  }
  const last = points[points.length - 1] as Point;
  return { x: last.x, y: last.y };
}
