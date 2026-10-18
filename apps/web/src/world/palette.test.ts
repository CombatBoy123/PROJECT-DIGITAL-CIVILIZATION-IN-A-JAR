import { ACTIVITIES, ZONES } from '@civ/sim-core';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_COLORS,
  ACTIVITY_LABELS,
  ACTIVITY_LEGEND,
  PALETTE,
  ROOF_COLORS,
  ZONE_COLORS,
  citizenAlpha,
  contrastRatio,
  cssColor,
  hashId,
  houseStyle,
  mixColor,
  shade,
  unitHash,
} from './palette';

describe('colour utilities', () => {
  it('formats and mixes colours', () => {
    expect(cssColor(0x0a0b0c)).toBe('#0a0b0c');
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(shade(0x808080, 1)).toBe(0xffffff);
    expect(shade(0x808080, -1)).toBe(0x000000);
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio(0x000000, 0xffffff)).toBeCloseTo(21);
    expect(contrastRatio(0x777777, 0x777777)).toBeCloseTo(1);
  });
});

describe('activity colours', () => {
  it('covers every activity, with a legend entry and label', () => {
    for (const a of ACTIVITIES) {
      expect(ACTIVITY_COLORS[a]).toBeTypeOf('number');
      expect(ACTIVITY_LABELS[a]).toBeTruthy();
    }
    expect(ACTIVITY_LEGEND.map((e) => e.activity).sort()).toEqual([...ACTIVITIES].sort());
  });

  it('has at least 3:1 contrast against the ground, roads and roofs', () => {
    const backgrounds = [PALETTE.road, ...ZONES.map((z) => ZONE_COLORS[z]), ...ROOF_COLORS];
    for (const a of ACTIVITIES) {
      for (const bg of backgrounds) {
        expect(
          contrastRatio(ACTIVITY_COLORS[a], bg),
          `${a} on ${cssColor(bg)}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps activity colours distinct from each other', () => {
    const colours = ACTIVITIES.map((a) => ACTIVITY_COLORS[a]);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('dims sleeping and non-highlighted citizens', () => {
    expect(citizenAlpha('leisure', false)).toBe(1);
    expect(citizenAlpha('sleeping', false)).toBeLessThan(1);
    expect(citizenAlpha('leisure', true)).toBeLessThan(citizenAlpha('sleeping', false));
  });
});

describe('deterministic variation', () => {
  it('hashes ids deterministically into the unit interval', () => {
    expect(hashId(42, 1)).toBe(hashId(42, 1));
    expect(hashId(42, 1)).not.toBe(hashId(43, 1));
    expect(hashId(42, 1)).not.toBe(hashId(42, 2));
    for (let i = 0; i < 200; i++) {
      const u = unitHash(i, 7);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('derives a house style from the id only, with variety across houses', () => {
    expect(houseStyle(17)).toEqual(houseStyle(17));
    const roofs = new Set(Array.from({ length: 60 }, (_, i) => houseStyle(i + 1).roof));
    expect(roofs.size).toBeGreaterThan(4);
    for (let id = 1; id < 100; id++) expect(ROOF_COLORS).toContain(houseStyle(id).roof);
  });
});
