import type { Block, Building, WorldMap } from '@civ/sim-core';
import { Graphics } from 'pixi.js';
import type { Rect } from './camera';
import {
  FOUNTAIN_RADIUS_FRACTION,
  PLAZA_PAVING_INSET,
  TILE_PX,
  buildingCentre,
  buildingRect,
  mapBounds,
} from './geometry';
import {
  PALETTE,
  VENUE_COLORS,
  ZONE_COLORS,
  ZONE_DETAIL,
  hashId,
  houseStyle,
  shade,
  unitHash,
} from './palette';

/*
 * Static map layers, drawn in world pixels and rebuilt only when the layout changes.
 *
 *   ground     roads (the map base), zoned blocks with their land detail: furrowed
 *              fields on farmland, dashed vacant lots on commercial land, yards on
 *              residential blocks;
 *   lanes      dashed road centre lines, shown only when zoomed in;
 *   buildings  houses (procedural gabled roofs with per-building variation),
 *              plazas (paving and a fountain) and parks (paths and trees).
 *
 * Variation comes from hashes of entity ids, so the same world always looks the same.
 */

/** Tiles per lot side (residential blocks hold 2 × 2 lots of 3 × 3 tiles; see worldgen). */
const LOT_TILES = 3;

function blockRect(block: Pick<Block, 'x' | 'y'>, map: Pick<WorldMap, 'blockSize'>): Rect {
  return {
    x: block.x * TILE_PX,
    y: block.y * TILE_PX,
    width: map.blockSize * TILE_PX,
    height: map.blockSize * TILE_PX,
  };
}

function inset(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, width: r.width - 2 * by, height: r.height - 2 * by };
}

/** Lots of a block (row-major), matching the world generator's lot grid. */
function blockLots(block: Pick<Block, 'x' | 'y'>, map: Pick<WorldMap, 'blockSize'>): Rect[] {
  const perSide = Math.max(1, Math.floor(map.blockSize / LOT_TILES));
  const size = LOT_TILES * TILE_PX;
  const lots: Rect[] = [];
  for (let row = 0; row < perSide; row++) {
    for (let col = 0; col < perSide; col++) {
      lots.push({
        x: block.x * TILE_PX + col * size,
        y: block.y * TILE_PX + row * size,
        width: size,
        height: size,
      });
    }
  }
  return lots;
}

/** Dashed rectangle outline drawn as small filled rects (Graphics has no dash style). */
function dashedRect(
  g: Graphics,
  r: Rect,
  dash: number,
  gap: number,
  width: number,
  color: number,
): void {
  const step = dash + gap;
  for (let x = r.x; x < r.x + r.width; x += step) {
    const len = Math.min(dash, r.x + r.width - x);
    g.rect(x, r.y, len, width);
    g.rect(x, r.y + r.height - width, len, width);
  }
  for (let y = r.y; y < r.y + r.height; y += step) {
    const len = Math.min(dash, r.y + r.height - y);
    g.rect(r.x, y, width, len);
    g.rect(r.x + r.width - width, y, width, len);
  }
  g.fill(color);
}

/** Farmland: one or two fields per block with furrows running in a per-block direction. */
function drawFarmland(g: Graphics, block: Block, r: Rect): void {
  const split = hashId(block.id, 21) % 3; // 0: one field, 1: split vertically, 2: horizontally
  const margin = 3;
  const area = inset(r, margin);
  const fields: Rect[] =
    split === 0
      ? [area]
      : split === 1
        ? [
            { ...area, width: area.width / 2 - margin / 2 },
            {
              ...area,
              x: area.x + area.width / 2 + margin / 2,
              width: area.width / 2 - margin / 2,
            },
          ]
        : [
            { ...area, height: area.height / 2 - margin / 2 },
            {
              ...area,
              y: area.y + area.height / 2 + margin / 2,
              height: area.height / 2 - margin / 2,
            },
          ];
  fields.forEach((field, i) => {
    const gold = hashId(block.id, 22 + i) % 2 === 0;
    g.rect(field.x, field.y, field.width, field.height).fill(
      gold ? ZONE_DETAIL.cropGold : ZONE_DETAIL.cropGreen,
    );
    const horizontal = hashId(block.id, 30 + i) % 2 === 0;
    const spacing = 5;
    if (horizontal) {
      for (let y = field.y + spacing - 1; y < field.y + field.height - 1; y += spacing) {
        g.rect(field.x, y, field.width, 1.5);
      }
    } else {
      for (let x = field.x + spacing - 1; x < field.x + field.width - 1; x += spacing) {
        g.rect(x, field.y, 1.5, field.height);
      }
    }
    g.fill({ color: ZONE_DETAIL.furrowDark, alpha: 0.85 });
  });
}

/** Commercial land is vacant in Phase 1: surveyed lots with dashed outlines and corner stakes. */
function drawCommercialLots(g: Graphics, block: Block, map: WorldMap): void {
  for (const lot of blockLots(block, map)) {
    const r = inset(lot, 5);
    dashedRect(g, r, 5, 4, 1, ZONE_DETAIL.commercialLot);
    for (const [x, y] of [
      [r.x, r.y],
      [r.x + r.width, r.y],
      [r.x, r.y + r.height],
      [r.x + r.width, r.y + r.height],
    ] as const) {
      g.rect(x - 1.5, y - 1.5, 3, 3);
    }
    g.fill(ZONE_DETAIL.commercialMarker);
  }
}

function drawYards(g: Graphics, block: Block, map: WorldMap): void {
  for (const lot of blockLots(block, map)) {
    const r = inset(lot, 2);
    g.roundRect(r.x, r.y, r.width, r.height, 3);
  }
  g.fill(ZONE_DETAIL.yard);
}

/** Roads (map base), curbs, zoned land. */
export function drawGround(map: WorldMap): Graphics {
  const g = new Graphics();
  const bounds = mapBounds(map);
  g.rect(bounds.x, bounds.y, bounds.width, bounds.height).fill(PALETTE.road);
  for (const block of map.blocks) {
    const r = blockRect(block, map);
    g.rect(r.x, r.y, r.width, r.height).fill(ZONE_COLORS[block.zone]);
    // Curb as an outside stroke rather than a larger rect underneath: less overdraw.
    g.rect(r.x, r.y, r.width, r.height).stroke({ width: 1.5, color: PALETTE.curb, alignment: 0 });
    if (block.zone === 'farmland') drawFarmland(g, block, r);
    else if (block.zone === 'commercial') drawCommercialLots(g, block, map);
    else if (block.zone === 'residential') drawYards(g, block, map);
  }
  return g;
}

/** Dashed centre lines on every road segment between intersections. */
export function drawLaneMarkings(map: WorldMap): Graphics {
  const g = new Graphics();
  const pitch = map.roadPitch;
  const dash = 5;
  const gap = 5;
  const w = 1;
  const segment = (from: number, to: number, fixed: number, vertical: boolean): void => {
    for (let p = from + gap / 2; p + dash <= to; p += dash + gap) {
      if (vertical) g.rect(fixed - w / 2, p, w, dash);
      else g.rect(p, fixed - w / 2, dash, w);
    }
  };
  for (let col = 0; col <= map.cols; col++) {
    const x = (col * pitch + 0.5) * TILE_PX;
    for (let row = 0; row < map.rows; row++) {
      segment((row * pitch + 1) * TILE_PX, (row * pitch + pitch) * TILE_PX, x, true);
    }
  }
  for (let row = 0; row <= map.rows; row++) {
    const y = (row * pitch + 0.5) * TILE_PX;
    for (let col = 0; col < map.cols; col++) {
      segment((col * pitch + 1) * TILE_PX, (col * pitch + pitch) * TILE_PX, y, false);
    }
  }
  g.fill({ color: PALETTE.laneMarking, alpha: 0.7 });
  return g;
}

/** A house: drop shadow, two-tone gabled roof with a ridge, optional chimney, door step. */
function drawHouse(g: Graphics, b: Building): void {
  const lot = buildingRect(b);
  const style = houseStyle(b.id);
  const body = {
    x: lot.x + style.insetX,
    y: lot.y + style.insetY,
    width: lot.width - 2 * style.insetX,
    height: lot.height - 2 * style.insetY,
  };
  g.rect(body.x + 2.5, body.y + 3, body.width, body.height).fill({
    color: PALETTE.shadow,
    alpha: 0.55,
  });
  const light = shade(style.roof, 0.14);
  const dark = shade(style.roof, -0.18);
  if (style.ridgeVertical) {
    const half = body.width / 2;
    g.rect(body.x, body.y, half, body.height).fill(light);
    g.rect(body.x + half, body.y, body.width - half, body.height).fill(dark);
    g.rect(body.x + half - 0.75, body.y, 1.5, body.height).fill(shade(style.roof, 0.32));
  } else {
    const half = body.height / 2;
    g.rect(body.x, body.y, body.width, half).fill(light);
    g.rect(body.x, body.y + half, body.width, body.height - half).fill(dark);
    g.rect(body.x, body.y + half - 0.75, body.width, 1.5).fill(shade(style.roof, 0.32));
  }
  g.rect(body.x, body.y, body.width, body.height).stroke({
    width: 1,
    color: shade(style.roof, -0.45),
    alpha: 0.9,
  });
  if (style.chimney) {
    const cx = hashId(b.id, 6) % 2 === 0 ? body.x + 4 : body.x + body.width - 8;
    const cy = hashId(b.id, 7) % 2 === 0 ? body.y + 3 : body.y + body.height - 7;
    g.rect(cx, cy, 4, 4).fill(0x2e2a30);
  }
  // Door step on the side facing the road the door opens onto.
  const doorX = (b.door.x + 0.5) * TILE_PX;
  const facesUp = b.door.y < b.y;
  const stepY = facesUp ? body.y - 3 : body.y + body.height;
  g.rect(doorX - 3, stepY, 6, 3).fill(0x9a7a58);
}

/** A plaza: paving with joints, a fountain at the centre and four benches. */
function drawPlaza(g: Graphics, b: Building): void {
  const r = inset(buildingRect(b), PLAZA_PAVING_INSET);
  g.rect(r.x, r.y, r.width, r.height).fill(VENUE_COLORS.paving);
  const joint = 12;
  for (let x = r.x + joint; x < r.x + r.width; x += joint) g.rect(x, r.y, 1, r.height);
  for (let y = r.y + joint; y < r.y + r.height; y += joint) g.rect(r.x, y, r.width, 1);
  g.fill({ color: VENUE_COLORS.pavingJoint, alpha: 0.8 });
  g.rect(r.x, r.y, r.width, r.height).stroke({ width: 2, color: VENUE_COLORS.plazaEdge });
  const c = buildingCentre(b);
  const radius = Math.min(r.width, r.height) * FOUNTAIN_RADIUS_FRACTION;
  g.circle(c.x + 1.5, c.y + 2, radius + 1).fill({ color: PALETTE.shadow, alpha: 0.45 });
  g.circle(c.x, c.y, radius + 1).fill(VENUE_COLORS.fountainStone);
  g.circle(c.x, c.y, radius - 3).fill(VENUE_COLORS.water);
  g.circle(c.x, c.y, radius * 0.3).fill({ color: VENUE_COLORS.waterLight, alpha: 0.85 });
  const d = radius + 12;
  g.rect(c.x - 7, c.y - d - 2, 14, 4);
  g.rect(c.x - 7, c.y + d - 2, 14, 4);
  g.rect(c.x - d - 2, c.y - 7, 4, 14);
  g.rect(c.x + d - 2, c.y - 7, 4, 14);
  g.fill(VENUE_COLORS.bench);
}

/** A park: lawn, a looping path joined to the entrance, and trees placed off the paths. */
function drawPark(g: Graphics, b: Building): void {
  const r = inset(buildingRect(b), 2);
  g.roundRect(r.x, r.y, r.width, r.height, 6).fill(VENUE_COLORS.grass);
  for (let i = 0; i < 5; i++) {
    const x = r.x + 10 + unitHash(b.id, 40 + i) * (r.width - 20);
    const y = r.y + 10 + unitHash(b.id, 50 + i) * (r.height - 20);
    g.circle(x, y, 8 + unitHash(b.id, 60 + i) * 8);
  }
  g.fill({ color: VENUE_COLORS.grassLight, alpha: 0.7 });

  const c = buildingCentre(b);
  const loop = Math.min(r.width, r.height) * 0.27;
  const doorX = (b.door.x + 0.5) * TILE_PX;
  const entranceY = b.door.y < b.y ? r.y : r.y + r.height;
  g.moveTo(doorX, entranceY).lineTo(doorX, c.y + (b.door.y < b.y ? -loop : loop));
  g.stroke({ width: 5, color: VENUE_COLORS.path });
  g.circle(c.x, c.y, loop).stroke({ width: 5, color: VENUE_COLORS.path });

  // Trees: deterministic candidates, kept if clear of the paths and of earlier trees.
  const trees: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 60 && trees.length < 14; i++) {
    const tr = 5 + unitHash(b.id, 100 + i) * 4;
    const x = r.x + tr + 1 + unitHash(b.id, 200 + i) * (r.width - 2 * tr - 2);
    const y = r.y + tr + 1 + unitHash(b.id, 300 + i) * (r.height - 2 * tr - 2);
    const fromCentre = Math.hypot(x - c.x, y - c.y);
    if (Math.abs(fromCentre - loop) < tr + 4) continue;
    if (Math.abs(x - doorX) < tr + 4 && (b.door.y < b.y ? y < c.y : y > c.y)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.y - y) < t.r + tr + 1)) continue;
    trees.push({ x, y, r: tr });
  }
  for (const t of trees) g.circle(t.x + 1.5, t.y + 2, t.r);
  g.fill({ color: PALETTE.shadow, alpha: 0.5 });
  for (const t of trees) g.circle(t.x, t.y, t.r);
  g.fill(VENUE_COLORS.treeDark);
  for (const t of trees) g.circle(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.62);
  g.fill(VENUE_COLORS.treeLight);
  for (const t of trees) g.circle(t.x - t.r * 0.4, t.y - t.r * 0.4, t.r * 0.25);
  g.fill({ color: VENUE_COLORS.treeHighlight, alpha: 0.8 });
}

export function drawBuildings(buildings: readonly Building[]): Graphics {
  const g = new Graphics();
  for (const b of buildings) {
    if (b.kind === 'house') drawHouse(g, b);
    else if (b.kind === 'plaza') drawPlaza(g, b);
    else drawPark(g, b);
  }
  return g;
}
