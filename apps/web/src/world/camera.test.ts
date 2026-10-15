import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  cameraKeyAction,
  constrain,
  easeOutCubic,
  fitBounds,
  focusOn,
  lerpCamera,
  pan,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomLimitsFor,
  type Camera,
} from './camera';

const viewport = { width: 800, height: 600 };
const bounds = { x: 0, y: 0, width: 1000, height: 500 };
const limits = zoomLimitsFor(bounds, viewport);

describe('world ↔ screen transforms', () => {
  it('maps the camera centre to the viewport centre and round-trips', () => {
    const camera: Camera = { x: 120, y: 80, zoom: 2 };
    expect(worldToScreen(camera, viewport, 120, 80)).toEqual({ x: 400, y: 300 });
    expect(worldToScreen(camera, viewport, 130, 80)).toEqual({ x: 420, y: 300 });
    const w = screenToWorld(camera, viewport, 37, 512);
    const s = worldToScreen(camera, viewport, w.x, w.y);
    expect(s.x).toBeCloseTo(37);
    expect(s.y).toBeCloseTo(512);
  });

  it('reports the visible world rectangle', () => {
    expect(visibleWorldRect({ x: 100, y: 100, zoom: 2 }, viewport)).toEqual({
      x: -100,
      y: -50,
      width: 400,
      height: 300,
    });
  });
});

describe('zoom', () => {
  it('keeps the world point under the cursor fixed', () => {
    const camera: Camera = { x: 500, y: 250, zoom: 1 };
    const before = screenToWorld(camera, viewport, 650, 120);
    const zoomed = zoomAt(camera, viewport, 650, 120, 1.7, limits);
    const after = screenToWorld(zoomed, viewport, 650, 120);
    expect(zoomed.zoom).toBeCloseTo(1.7);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps to the zoom limits', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    expect(zoomAt(camera, viewport, 0, 0, 1000, limits).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(camera, viewport, 0, 0, 0.0001, limits).zoom).toBe(limits.min);
  });

  it('allows zooming out somewhat beyond the fit level, never to zero', () => {
    const fit = fitBounds(bounds, viewport, limits);
    expect(limits.min).toBeLessThan(fit.zoom);
    expect(limits.min).toBeGreaterThan(0);
  });
});

describe('fit, focus, pan', () => {
  it('fits the bounds inside the padded viewport, centred', () => {
    const cam = fitBounds(bounds, viewport, limits, 24);
    expect(cam.x).toBe(500);
    expect(cam.y).toBe(250);
    expect(cam.zoom).toBeCloseTo((800 - 48) / 1000);
    const topLeft = worldToScreen(cam, viewport, 0, 0);
    expect(topLeft.x).toBeCloseTo(24);
    expect(topLeft.y).toBeGreaterThanOrEqual(24);
  });

  it('focuses on a point, zooming in but never out', () => {
    const far: Camera = { x: 0, y: 0, zoom: 0.5 };
    expect(focusOn(far, 300, 200, 1.6, limits)).toEqual({ x: 300, y: 200, zoom: 1.6 });
    const near: Camera = { x: 0, y: 0, zoom: 3 };
    expect(focusOn(near, 300, 200, 1.6, limits).zoom).toBe(3);
  });

  it('pans content with the pointer', () => {
    const cam: Camera = { x: 100, y: 100, zoom: 2 };
    const moved = pan(cam, 40, -20);
    expect(moved).toEqual({ x: 80, y: 110, zoom: 2 });
    // The world point that was under (400, 300) is now under (440, 280).
    const s = worldToScreen(moved, viewport, 100, 100);
    expect(s).toEqual({ x: 440, y: 280 });
  });

  it('keeps the camera centre within the map', () => {
    expect(constrain({ x: -500, y: 9000, zoom: 100 }, bounds, limits)).toEqual({
      x: 0,
      y: 500,
      zoom: MAX_ZOOM,
    });
  });
});

describe('animation helpers', () => {
  it('eases from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(2)).toBe(1);
  });

  it('interpolates centre linearly and zoom geometrically', () => {
    const a: Camera = { x: 0, y: 0, zoom: 1 };
    const b: Camera = { x: 100, y: -50, zoom: 4 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    const mid = lerpCamera(a, b, 0.5);
    expect(mid.x).toBe(50);
    expect(mid.y).toBe(-25);
    expect(mid.zoom).toBeCloseTo(2);
    expect(lerpCamera(a, b, 1).zoom).toBeCloseTo(4);
  });
});

describe('keyboard', () => {
  it('maps arrows and WASD to pans, +/− to zoom, 0 to fit, Escape to clear', () => {
    expect(cameraKeyAction({ key: 'ArrowLeft' })).toMatchObject({ type: 'pan', dy: 0 });
    expect(cameraKeyAction({ key: 'd' })).toEqual(cameraKeyAction({ key: 'ArrowRight' }));
    expect(cameraKeyAction({ key: 'W' })).toEqual(cameraKeyAction({ key: 'ArrowUp' }));
    expect(cameraKeyAction({ key: 's' })).toEqual(cameraKeyAction({ key: 'ArrowDown' }));
    expect(cameraKeyAction({ key: '+' })).toMatchObject({ type: 'zoom' });
    expect(cameraKeyAction({ key: '=' })).toEqual(cameraKeyAction({ key: '+' }));
    const zoomOut = cameraKeyAction({ key: '-' });
    expect(zoomOut?.type === 'zoom' && zoomOut.factor < 1).toBe(true);
    expect(cameraKeyAction({ key: '0' })).toEqual({ type: 'fit' });
    expect(cameraKeyAction({ key: 'Escape' })).toEqual({ type: 'clearSelection' });
  });

  it('ignores other keys and modified keys (global shortcuts and browser keys)', () => {
    expect(cameraKeyAction({ key: '.' })).toBeNull();
    expect(cameraKeyAction({ key: ' ' })).toBeNull();
    expect(cameraKeyAction({ key: '+', ctrlKey: true })).toBeNull();
    expect(cameraKeyAction({ key: 'a', metaKey: true })).toBeNull();
  });
});
