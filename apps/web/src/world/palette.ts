import type { Activity, BuildingKind, Zone } from '@civ/sim-core';

/*
 * Colour tokens of the world renderer (pure; no PixiJS).
 *
 * Dark theme: charcoal ground, muted zone tints, restrained purple (interface accent)
 * and cyan (water, data) highlights, matching src/styles/tokens.css. Colours are
 * 0xRRGGBB numbers as PixiJS expects; `cssColor` converts them for HTML overlays.
 *
 * Activity colours are chosen to stay distinguishable from each other and to keep
 * at least 3:1 contrast against the ground, road and roof colours they are drawn on
 * (checked in palette.test.ts).
 */

export const PALETTE = {
  /** Canvas background outside the map. */
  void: 0x0c0d10,
  /** Map ground (roads are drawn over the whole map, blocks on top). */
  road: 0x25262d,
  curb: 0x30323b,
  laneMarking: 0x55586a,
  /** Thin outline around every block. */
  blockEdge: 0x2c2e36,
  selection: 0xf2f0ff,
  selectionAccent: 0xa597f5,
  hover: 0xbdbcc8,
  nightTint: 0x060a1f,
  stormTint: 0x0b0e18,
  rain: 0xb9c6e4,
  shadow: 0x050608,
} as const;

/** Base colour of each zone's land. */
export const ZONE_COLORS: Readonly<Record<Zone, number>> = {
  residential: 0x1c1b22,
  commercial: 0x15232a,
  farmland: 0x1a2018,
  civic: 0x1f1b2a,
};

/** Zone colours brightened for the minimap, where blocks are only a few pixels wide. */
export const MINIMAP_ZONE_COLORS: Readonly<Record<Zone, number>> = {
  residential: 0x3a3646,
  commercial: 0x1f5662,
  farmland: 0x34422d,
  civic: 0x55467e,
};

export const ZONE_DETAIL = {
  /** Dashed outlines of vacant commercial lots. */
  commercialLot: 0x2d5a66,
  commercialMarker: 0x3d8494,
  /** Alternating crop rows on farmland. */
  furrowDark: 0x161b14,
  cropGreen: 0x243020,
  cropGold: 0x2e2c1b,
  /** Yards around houses. */
  yard: 0x201f27,
} as const;

export const VENUE_COLORS = {
  paving: 0x2a2a32,
  pavingJoint: 0x33333c,
  plazaEdge: 0x3b3d48,
  fountainStone: 0x4a4c5e,
  water: 0x1f9fb0,
  waterLight: 0x8fe3ec,
  bench: 0x4a4048,
  grass: 0x1a2a20,
  grassLight: 0x1f3326,
  path: 0x2d302b,
  treeDark: 0x2a5038,
  treeLight: 0x3b6b4a,
  treeHighlight: 0x4f8560,
} as const;

/** Muted roof colours; each house picks one deterministically from its id. */
export const ROOF_COLORS: readonly number[] = [
  0x4c4662, 0x584b5e, 0x3f4c5e, 0x4b5160, 0x5c4f4a, 0x465349, 0x534a6a, 0x4f4a55,
];

export const ACTIVITY_COLORS: Readonly<Record<Activity, number>> = {
  sleeping: 0x969ed8,
  at_home: 0xf2c66d,
  leisure: 0x5fd4e0,
  traveling: 0xc9bcff,
};

/** Display order and labels of activities in the legend. */
export const ACTIVITY_LEGEND: readonly { activity: Activity; label: string }[] = [
  { activity: 'at_home', label: 'At home' },
  { activity: 'leisure', label: 'Leisure' },
  { activity: 'traveling', label: 'Traveling' },
  { activity: 'sleeping', label: 'Sleeping' },
];

export const ACTIVITY_LABELS: Readonly<Record<Activity, string>> = {
  sleeping: 'Sleeping',
  at_home: 'At home',
  leisure: 'Leisure',
  traveling: 'Traveling',
};

export const BUILDING_KIND_LABELS: Readonly<Record<BuildingKind, string>> = {
  house: 'House',
  plaza: 'Plaza',
  park: 'Park',
};

/** Alpha of citizen dots: sleeping citizens are drawn dimmer. */
export const CITIZEN_ALPHA = {
  awake: 1,
  sleeping: 0.55,
  /** Multiplier for citizens outside the current highlight set. */
  dimmed: 0.16,
} as const;

/** Alpha of a citizen dot given its activity and whether it is de-emphasised. */
export function citizenAlpha(activity: Activity | undefined, dimmed: boolean): number {
  const base = activity === 'sleeping' ? CITIZEN_ALPHA.sleeping : CITIZEN_ALPHA.awake;
  return dimmed ? base * CITIZEN_ALPHA.dimmed : base;
}

/** "#rrggbb" for a 0xRRGGBB colour. */
export function cssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Linear mix of two colours: t = 0 → a, t = 1 → b. */
export function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(((a >> 16) & 0xff) * (1 - k) + ((b >> 16) & 0xff) * k);
  const g = Math.round(((a >> 8) & 0xff) * (1 - k) + ((b >> 8) & 0xff) * k);
  const bl = Math.round((a & 0xff) * (1 - k) + (b & 0xff) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Brighten (amount > 0, towards white) or darken (amount < 0, towards black) a colour. */
export function shade(color: number, amount: number): number {
  return amount >= 0 ? mixColor(color, 0xffffff, amount) : mixColor(color, 0x000000, -amount);
}

/** WCAG relative luminance of a 0xRRGGBB colour. */
export function relativeLuminance(color: number): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((color >> 16) & 0xff) +
    0.7152 * channel((color >> 8) & 0xff) +
    0.0722 * channel(color & 0xff)
  );
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Small integer hash (murmur3 finaliser) of an id and a salt, as an unsigned 32-bit
 * number. Used for deterministic visual variation; it never feeds the simulation.
 */
export function hashId(id: number, salt = 0): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic value in [0, 1) from an id and a salt. */
export function unitHash(id: number, salt = 0): number {
  return hashId(id, salt) / 4294967296;
}

/** Visual variation of one house, derived only from its id. */
export interface HouseStyle {
  roof: number;
  /** Ridge runs vertically (north–south) instead of horizontally. */
  ridgeVertical: boolean;
  /** Inset of the house body from its lot edge, in world pixels. */
  insetX: number;
  insetY: number;
  chimney: boolean;
}

export function houseStyle(buildingId: number): HouseStyle {
  const roof =
    ROOF_COLORS[hashId(buildingId, 1) % ROOF_COLORS.length] ?? ROOF_COLORS[0] ?? 0x4c4662;
  return {
    roof,
    ridgeVertical: hashId(buildingId, 2) % 2 === 1,
    insetX: 6 + (hashId(buildingId, 3) % 4),
    insetY: 6 + (hashId(buildingId, 4) % 4),
    chimney: hashId(buildingId, 5) % 3 !== 0,
  };
}
