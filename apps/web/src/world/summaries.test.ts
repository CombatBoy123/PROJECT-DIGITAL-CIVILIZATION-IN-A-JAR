import type { CitizenFrameTuple } from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import { countActivities, describeHover, presentIn } from './summaries';

const layout = {
  buildings: [
    {
      id: 1,
      kind: 'house',
      name: '4 Elm Street',
      blockId: 1,
      x: 1,
      y: 1,
      width: 3,
      height: 3,
      capacity: 4,
      door: { x: 2, y: 0 },
    },
    {
      id: 2,
      kind: 'house',
      name: '7 Elm Street',
      blockId: 1,
      x: 4,
      y: 1,
      width: 3,
      height: 3,
      capacity: 3,
      door: { x: 5, y: 0 },
    },
    {
      id: 3,
      kind: 'plaza',
      name: 'Central Plaza',
      blockId: 2,
      x: 8,
      y: 1,
      width: 6,
      height: 6,
      capacity: 40,
      door: { x: 11, y: 0 },
    },
  ],
  households: [{ id: 1, homeId: 1, surname: 'Okafor' }],
} as const;

// [id, activityCode, locationId, fromId, toId, departTick, arriveTick]
const tuples: CitizenFrameTuple[] = [
  [1, 0, 1, 0, 0, 0, 0], // sleeping at home
  [2, 1, 1, 0, 0, 0, 0], // at home
  [3, 2, 3, 0, 0, 0, 0], // leisure at the plaza
  [4, 3, 0, 1, 3, 10, 12], // travelling home → plaza
];
const citizens = new Map(tuples.map((t) => [t[0], t]));
const mutable = { buildings: [...layout.buildings], households: [...layout.households] };

describe('countActivities / presentIn', () => {
  it('counts citizens per activity and per building', () => {
    expect(countActivities(tuples)).toEqual({ sleeping: 1, at_home: 1, leisure: 1, traveling: 1 });
    expect(presentIn(tuples, 1)).toBe(2);
    expect(presentIn(tuples, 2)).toBe(0);
  });
});

describe('describeHover', () => {
  it('describes buildings with kind, capacity, occupancy and household', () => {
    expect(describeHover({ kind: 'building', id: 1 }, mutable, citizens)).toEqual({
      title: '4 Elm Street',
      lines: ['House · capacity 4', '2 people here now', 'Okafor household'],
    });
    expect(describeHover({ kind: 'building', id: 2 }, mutable, citizens)?.lines).toContain(
      'Vacant',
    );
    expect(describeHover({ kind: 'building', id: 3 }, mutable, null)).toEqual({
      title: 'Central Plaza',
      lines: ['Plaza · capacity 40'],
    });
    expect(describeHover({ kind: 'building', id: 99 }, mutable, citizens)).toBeNull();
  });

  it('describes citizens with their label, activity and place or destination', () => {
    const label = (id: number) => (id === 3 ? 'Ada Okafor' : undefined);
    expect(describeHover({ kind: 'citizen', id: 3 }, mutable, citizens, label)).toEqual({
      title: 'Ada Okafor',
      lines: ['Leisure', 'at Central Plaza'],
    });
    expect(describeHover({ kind: 'citizen', id: 4 }, mutable, citizens, label)).toEqual({
      title: 'Citizen #4',
      lines: ['Traveling', 'to Central Plaza'],
    });
    expect(describeHover({ kind: 'citizen', id: 50 }, mutable, citizens)).toEqual({
      title: 'Citizen #50',
      lines: [],
    });
  });
});
