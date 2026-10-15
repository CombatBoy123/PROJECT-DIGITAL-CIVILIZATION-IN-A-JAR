import {
  isRoad,
  pointAlongRoute,
  roadRoute,
  routeLength,
  Simulation,
  type Building,
} from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import {
  TILE_PX,
  buildingCentre,
  buildingRect,
  buildingSlots,
  gridSlots,
  groupByLocation,
  mapBounds,
  plazaKeepClearRadius,
  rectContains,
  tileCentreToWorld,
  travellerPosition,
  tripProgress,
  tripRoute,
} from './geometry';

const { simulation: sim } = Simulation.create('geometry-test', { population: 80 });
const { map, buildings } = sim.state;
const houses = buildings.filter((b) => b.kind === 'house') as Building[];
const venues = buildings.filter((b) => b.kind !== 'house') as Building[];

describe('tile → world mapping', () => {
  it('scales tiles to world pixels', () => {
    expect(mapBounds(map)).toEqual({
      x: 0,
      y: 0,
      width: map.width * TILE_PX,
      height: map.height * TILE_PX,
    });
    expect(tileCentreToWorld(0)).toBe(TILE_PX / 2);
    expect(tileCentreToWorld(2.5)).toBe(3 * TILE_PX);
  });

  it('gives building footprints and centres', () => {
    const b = { x: 2, y: 3, width: 3, height: 3 };
    expect(buildingRect(b)).toEqual({ x: 32, y: 48, width: 48, height: 48 });
    expect(buildingCentre(b)).toEqual({ x: 56, y: 72 });
  });
});

describe('citizen slots', () => {
  it('arranges slots in a grid inside the rectangle, last row centred', () => {
    const slots = gridSlots({ x: 0, y: 0, width: 30, height: 20 }, 5);
    expect(slots).toHaveLength(5);
    for (const s of slots)
      expect(rectContains({ x: 0, y: 0, width: 30, height: 20 }, s.x, s.y)).toBe(true);
    // 3 columns × 2 rows: the second row (2 slots) is centred.
    expect(slots[0]).toEqual({ x: 5, y: 5 });
    expect(slots[3]).toEqual({ x: 10, y: 15 });
    expect(slots[4]).toEqual({ x: 20, y: 15 });
    expect(gridSlots({ x: 0, y: 0, width: 10, height: 10 }, 0)).toEqual([]);
  });

  it('places every present citizen inside the footprint, at distinct positions', () => {
    for (const b of [...houses.slice(0, 5), ...venues]) {
      const present = b.capacity + 2; // also when (unexpectedly) over capacity
      const slots = buildingSlots(b, present);
      expect(slots).toHaveLength(present);
      const r = buildingRect(b);
      for (const s of slots) expect(rectContains(r, s.x, s.y)).toBe(true);
      expect(new Set(slots.map((s) => `${s.x},${s.y}`)).size).toBe(present);
    }
  });

  it('is stable: slot i does not move when fewer citizens are present (up to capacity)', () => {
    const b = venues[0] as Building;
    const full = buildingSlots(b, b.capacity);
    const some = buildingSlots(b, 3);
    expect(some).toEqual(full.slice(0, 3));
  });

  it('keeps plaza visitors off the fountain', () => {
    for (const b of venues.filter((v) => v.kind === 'plaza')) {
      const c = buildingCentre(b);
      const slots = buildingSlots(b, b.capacity + 5);
      expect(slots).toHaveLength(b.capacity + 5);
      for (const s of slots) {
        expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeGreaterThan(plazaKeepClearRadius(b));
      }
    }
  });

  it('groups located citizens by building in ascending id order, skipping travellers', () => {
    const groups = groupByLocation([
      [9, 4],
      [2, 4],
      [5, 0],
      [7, 1],
      [3, 4],
    ]);
    expect([...groups.entries()]).toEqual([
      [4, [2, 3, 9]],
      [1, [7]],
    ]);
  });
});

describe('travelling citizens', () => {
  const from = houses[0] as Building;
  const to = venues[0] as Building;
  const route = tripRoute(map, from, to);

  it('uses the engine road route door to door', () => {
    expect(route).toEqual(roadRoute(map, from.door, to.door));
    for (const p of route) expect(isRoad(map, p.x, p.y)).toBe(true);
  });

  it('computes clamped trip progress', () => {
    expect(tripProgress(10, 10, 14)).toBe(0);
    expect(tripProgress(12, 10, 14)).toBe(0.5);
    expect(tripProgress(20, 10, 14)).toBe(1);
    expect(tripProgress(5, 10, 14)).toBe(0);
    expect(tripProgress(10, 10, 10)).toBe(1);
  });

  it('starts at the origin door, ends at the destination door, and follows the road', () => {
    const start = travellerPosition(route, 100, 100, 104);
    expect(start).toEqual({ x: tileCentreToWorld(from.door.x), y: tileCentreToWorld(from.door.y) });
    const end = travellerPosition(route, 104.5, 100, 104);
    expect(end).toEqual({ x: tileCentreToWorld(to.door.x), y: tileCentreToWorld(to.door.y) });
    for (let t = 100; t <= 104; t += 0.25) {
      const p = travellerPosition(route, t, 100, 104);
      const expected = pointAlongRoute(route, (t - 100) / 4);
      expect(p.x).toBeCloseTo(tileCentreToWorld(expected.x));
      expect(p.y).toBeCloseTo(tileCentreToWorld(expected.y));
      // Interpolated points lie on a road row or column.
      const tx = p.x / TILE_PX - 0.5;
      const ty = p.y / TILE_PX - 0.5;
      const onRoad =
        (Number.isInteger(tx) && tx % map.roadPitch === 0) ||
        (Number.isInteger(ty) && ty % map.roadPitch === 0);
      expect(onRoad).toBe(true);
    }
    expect(routeLength(route)).toBeGreaterThan(0);
  });
});
