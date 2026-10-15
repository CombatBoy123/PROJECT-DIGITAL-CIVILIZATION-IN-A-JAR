import { describe, expect, it } from 'vitest';
import { dragThreshold, exceedsThreshold, pinchStep, wheelZoomFactor } from './gestures';

describe('drag threshold', () => {
  it('treats small movements as clicks', () => {
    expect(exceedsThreshold(3, 0, dragThreshold('mouse'))).toBe(false);
    expect(exceedsThreshold(3, 3, dragThreshold('mouse'))).toBe(true);
    expect(dragThreshold('touch')).toBeGreaterThan(dragThreshold('mouse'));
  });
});

describe('wheel zoom', () => {
  it('zooms in on scroll up and out on scroll down', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(0, 0)).toBe(1);
  });

  it('normalises line and page deltas and clamps each step', () => {
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0));
    expect(wheelZoomFactor(-10, 2)).toBe(2);
    expect(wheelZoomFactor(10, 2)).toBe(0.5);
  });
});

describe('pinch', () => {
  it('zooms by the ratio of finger distances about the midpoint', () => {
    const step = pinchStep({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: -50, y: 0 }, { x: 150, y: 0 });
    expect(step.factor).toBe(2);
    expect(step.mid).toEqual({ x: 50, y: 0 });
    expect(step.dx).toBe(0);
  });

  it('pans with the midpoint', () => {
    const step = pinchStep({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 15, y: 5 });
    expect(step.factor).toBe(1);
    expect(step).toMatchObject({ dx: 5, dy: 5 });
  });

  it('ignores degenerate (coincident) fingers', () => {
    expect(pinchStep({ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 5, y: 5 }).factor).toBe(
      1,
    );
  });
});
