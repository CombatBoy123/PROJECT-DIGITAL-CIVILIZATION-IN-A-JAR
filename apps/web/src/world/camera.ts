/*
 * 2D camera for the world view (pure; no PixiJS, no DOM).
 *
 * Coordinate systems used by the renderer:
 *  - tile space:   integer engine coordinates (map.width × map.height tiles);
 *  - world space:  tile space scaled by TILE_PX (see geometry.ts), in "world pixels";
 *  - screen space: CSS pixels relative to the top-left corner of the map surface.
 *
 * The camera stores the world point shown at the centre of the viewport and a zoom
 * factor (screen pixels per world pixel):
 *
 *   screen = (world − centre) × zoom + viewport / 2
 *
 * Keeping the centre (not the top-left corner) means resizing the viewport keeps the
 * same point in the middle of the screen.
 */

export interface Camera {
  /** World x shown at the horizontal centre of the viewport. */
  x: number;
  /** World y shown at the vertical centre of the viewport. */
  y: number;
  /** Screen pixels per world pixel. */
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZoomLimits {
  min: number;
  max: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Absolute zoom bounds; the effective minimum also depends on the map size (see zoomLimitsFor). */
export const MAX_ZOOM = 6;
const ABSOLUTE_MIN_ZOOM = 0.05;
/** How far beyond "fit whole map" the user may zoom out. */
const ZOOM_OUT_BEYOND_FIT = 0.6;
/** Screen pixels kept free around the map when fitting. */
export const FIT_PADDING = 24;

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function worldToScreen(camera: Camera, viewport: Viewport, wx: number, wy: number): Vec2 {
  return {
    x: (wx - camera.x) * camera.zoom + viewport.width / 2,
    y: (wy - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function screenToWorld(camera: Camera, viewport: Viewport, sx: number, sy: number): Vec2 {
  return {
    x: (sx - viewport.width / 2) / camera.zoom + camera.x,
    y: (sy - viewport.height / 2) / camera.zoom + camera.y,
  };
}

/** Zoom that shows the whole rectangle inside the viewport with `padding` screen pixels around it. */
export function fitZoom(bounds: Rect, viewport: Viewport, padding = FIT_PADDING): number {
  const w = Math.max(1, viewport.width - 2 * padding);
  const h = Math.max(1, viewport.height - 2 * padding);
  return Math.min(w / Math.max(1, bounds.width), h / Math.max(1, bounds.height));
}

/** Zoom range for a map: from somewhat beyond "whole map visible" up to MAX_ZOOM. */
export function zoomLimitsFor(bounds: Rect, viewport: Viewport): ZoomLimits {
  const fit = fitZoom(bounds, viewport);
  const min = clamp(fit * ZOOM_OUT_BEYOND_FIT, ABSOLUTE_MIN_ZOOM, MAX_ZOOM);
  return { min, max: Math.max(min, MAX_ZOOM) };
}

/** Camera that shows the whole rectangle, centred. */
export function fitBounds(
  bounds: Rect,
  viewport: Viewport,
  limits: ZoomLimits,
  padding = FIT_PADDING,
): Camera {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
    zoom: clamp(fitZoom(bounds, viewport, padding), limits.min, limits.max),
  };
}

/**
 * Multiply the zoom by `factor` while keeping the world point under the screen point
 * (sx, sy) fixed — the behaviour expected from wheel and pinch zoom.
 */
export function zoomAt(
  camera: Camera,
  viewport: Viewport,
  sx: number,
  sy: number,
  factor: number,
  limits: ZoomLimits,
): Camera {
  const zoom = clamp(camera.zoom * factor, limits.min, limits.max);
  const anchor = screenToWorld(camera, viewport, sx, sy);
  return {
    x: anchor.x - (sx - viewport.width / 2) / zoom,
    y: anchor.y - (sy - viewport.height / 2) / zoom,
    zoom,
  };
}

/** Move the view by a screen-space delta (dragging right moves the content right). */
export function pan(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    x: camera.x - dxScreen / camera.zoom,
    y: camera.y - dyScreen / camera.zoom,
    zoom: camera.zoom,
  };
}

/** Centre on a world point, zooming in to at least `minZoom` (never zooming out). */
export function focusOn(
  camera: Camera,
  wx: number,
  wy: number,
  minZoom: number,
  limits: ZoomLimits,
): Camera {
  return { x: wx, y: wy, zoom: clamp(Math.max(camera.zoom, minZoom), limits.min, limits.max) };
}

/**
 * Keep the camera centre inside the (slightly enlarged) map bounds so the map can
 * never be panned completely out of view.
 */
export function constrain(camera: Camera, bounds: Rect, limits: ZoomLimits): Camera {
  const zoom = clamp(camera.zoom, limits.min, limits.max);
  return {
    x: clamp(camera.x, bounds.x, bounds.x + bounds.width),
    y: clamp(camera.y, bounds.y, bounds.y + bounds.height),
    zoom,
  };
}

/** World-space rectangle currently visible in the viewport. */
export function visibleWorldRect(camera: Camera, viewport: Viewport): Rect {
  const width = viewport.width / camera.zoom;
  const height = viewport.height / camera.zoom;
  return { x: camera.x - width / 2, y: camera.y - height / 2, width, height };
}

export function sameCamera(a: Camera, b: Camera, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.zoom - b.zoom) < epsilon
  );
}

/** Ease-out cubic: fast start, gentle stop (used for focus and button animations). */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * Interpolate between two cameras. The centre moves linearly; zoom is interpolated
 * geometrically so each frame of a zoom animation changes the scale by the same ratio.
 */
export function lerpCamera(from: Camera, to: Camera, t: number): Camera {
  const k = clamp(t, 0, 1);
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    zoom: from.zoom * Math.pow(to.zoom / from.zoom, k),
  };
}

/** Keyboard commands for the focused map. */
export type CameraKeyAction =
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number }
  | { type: 'fit' }
  | { type: 'clearSelection' };

/** Screen pixels moved by one arrow/WASD key press. */
export const KEY_PAN_STEP = 80;
/** Zoom factor of one +/− key press or zoom button click. */
export const ZOOM_STEP = 1.25;

/**
 * Map a key to a camera command, or null when the key is not a map key (so it can
 * reach the global shortcuts). Modified keys are ignored to keep browser shortcuts.
 */
export function cameraKeyAction(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): CameraKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return { type: 'pan', dx: KEY_PAN_STEP, dy: 0 };
    case 'ArrowRight':
    case 'd':
    case 'D':
      return { type: 'pan', dx: -KEY_PAN_STEP, dy: 0 };
    case 'ArrowUp':
    case 'w':
    case 'W':
      return { type: 'pan', dx: 0, dy: KEY_PAN_STEP };
    case 'ArrowDown':
    case 's':
    case 'S':
      return { type: 'pan', dx: 0, dy: -KEY_PAN_STEP };
    case '+':
    case '=':
      return { type: 'zoom', factor: ZOOM_STEP };
    case '-':
    case '_':
      return { type: 'zoom', factor: 1 / ZOOM_STEP };
    case '0':
      return { type: 'fit' };
    case 'Escape':
      return { type: 'clearSelection' };
    default:
      return null;
  }
}
