import { describe, expect, it } from 'vitest';
import { hitTest, hitTestBuildings, hitTestCitizens, type CitizenPoint } from './hit-test';

const buildings = [
  { id: 1, x: 1, y: 1, width: 3, height: 3 }, // world px 16..64
  { id: 2, x: 5, y: 1, width: 3, height: 3 }, // world px 80..128
];
const citizens: CitizenPoint[] = [
  { id: 10, x: 30, y: 30, visible: true },
  { id: 11, x: 36, y: 30, visible: true },
  { id: 12, x: 100, y: 40, visible: false },
];
const options = { zoom: 2, citizenRadiusPx: 4, tolerancePx: 4 };

describe('hitTest', () => {
  it('prefers citizens over the building they stand in', () => {
    expect(hitTest(citizens, buildings, 31, 30, options)).toEqual({ kind: 'citizen', id: 10 });
  });

  it('picks the nearest citizen', () => {
    expect(hitTestCitizens(citizens, 34, 30, options)).toBe(11);
  });

  it('converts the screen tolerance with the zoom', () => {
    // Reach = (4 + 4) / 2 = 4 world px at zoom 2; 8 world px at zoom 1.
    expect(hitTestCitizens(citizens, 30, 36, options)).toBeNull();
    expect(hitTestCitizens(citizens, 30, 36, { ...options, zoom: 1 })).toBe(10);
  });

  it('ignores hidden citizens', () => {
    expect(hitTest(citizens, buildings, 100, 40, options)).toEqual({ kind: 'building', id: 2 });
  });

  it('falls back to buildings, then to empty ground', () => {
    expect(hitTest(citizens, buildings, 60, 60, options)).toEqual({ kind: 'building', id: 1 });
    expect(hitTest(citizens, buildings, 72, 40, options)).toBeNull();
    expect(hitTest(citizens, buildings, 300, 300, options)).toBeNull();
  });

  it('accepts near misses within the tolerance, choosing the nearest footprint', () => {
    expect(hitTestBuildings(buildings, 65, 40, { zoom: 2, tolerancePx: 4 })).toBe(1);
    expect(hitTestBuildings(buildings, 78.5, 40, { zoom: 2, tolerancePx: 4 })).toBe(2);
    expect(hitTestBuildings(buildings, 70, 40, { zoom: 2, tolerancePx: 4 })).toBeNull();
  });
});
