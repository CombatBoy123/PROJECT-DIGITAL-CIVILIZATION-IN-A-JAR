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

  it('inside a footprint, needs a direct hit on a dot; otherwise selects the building', () => {
    // Radius 4 screen px = 2 world px at zoom 2; the 4 px tolerance is not applied inside.
    expect(hitTest(citizens, buildings, 33, 30, options)).toEqual({ kind: 'building', id: 1 });
    expect(hitTest(citizens, buildings, 32, 30, options)).toEqual({ kind: 'citizen', id: 10 });
    // A crowded footprint at overview zoom: points between dots pick the building.
    const crowd: CitizenPoint[] = [];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++)
        crowd.push({ id: 100 + i * 6 + j, x: 20 + i * 8, y: 20 + j * 8, visible: true });
    const overview = { zoom: 0.5, citizenRadiusPx: 2, tolerancePx: 4 };
    expect(hitTest(crowd, buildings, 24, 24, overview)).toEqual({ kind: 'building', id: 1 });
    expect(hitTest(crowd, buildings, 20.5, 20, overview)).toEqual({ kind: 'citizen', id: 100 });
  });

  it('keeps the tolerance for citizens outside footprints (on roads)', () => {
    const walker: CitizenPoint[] = [{ id: 20, x: 72, y: 40, visible: true }];
    expect(hitTest(walker, buildings, 72, 43, options)).toEqual({ kind: 'citizen', id: 20 });
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
