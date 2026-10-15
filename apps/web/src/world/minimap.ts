import type { Rect, Vec2 } from './camera';

/*
 * Minimap geometry (pure; no DOM). The minimap shows the whole map scaled to fit a
 * small box; its own coordinates are CSS pixels inside the minimap canvas.
 */

export interface MinimapLayout {
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Minimap pixels per world pixel. */
  scale: number;
}

/** Fit the map into a box of at most maxSize × maxSize CSS pixels, keeping its aspect. */
export function minimapLayout(bounds: Rect, maxSize: number): MinimapLayout {
  const scale = maxSize / Math.max(1, bounds.width, bounds.height);
  return {
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
    scale,
  };
}

export function minimapToWorld(layout: MinimapLayout, mx: number, my: number): Vec2 {
  return { x: mx / layout.scale, y: my / layout.scale };
}

/**
 * World rectangle in minimap pixels, clipped to the minimap so the viewport frame
 * stays visible when the view extends beyond the map.
 */
export function worldRectToMinimap(layout: MinimapLayout, r: Rect): Rect {
  const x0 = Math.max(0, r.x * layout.scale);
  const y0 = Math.max(0, r.y * layout.scale);
  const x1 = Math.min(layout.width, (r.x + r.width) * layout.scale);
  const y1 = Math.min(layout.height, (r.y + r.height) * layout.scale);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
