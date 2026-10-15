import type { Vec2 } from './camera';

/*
 * Pointer gesture arithmetic (pure; no DOM): drag thresholds, wheel and pinch zoom.
 * The DOM wiring lives in pointer-input.ts.
 */

/** Movement (screen px) below which a press-and-release is a click, not a drag. */
export const DRAG_THRESHOLD_PX = { mouse: 4, touch: 10 } as const;

export function dragThreshold(pointerType: string): number {
  return pointerType === 'mouse' ? DRAG_THRESHOLD_PX.mouse : DRAG_THRESHOLD_PX.touch;
}

export function exceedsThreshold(dx: number, dy: number, threshold: number): boolean {
  return dx * dx + dy * dy > threshold * threshold;
}

/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_PX = 16;
const PAGE_PX = 400;
/** Zoom sensitivity: factor e^(−k·pixels). */
const WHEEL_SENSITIVITY = 0.0015;

/**
 * Zoom factor for one wheel event: scrolling up (negative deltaY) zooms in. Each
 * event is clamped so a coarse mouse wheel or a page-mode delta cannot jump wildly.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const px =
    deltaMode === DOM_DELTA_LINE
      ? deltaY * LINE_PX
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * PAGE_PX
        : deltaY;
  const factor = Math.exp(-px * WHEEL_SENSITIVITY);
  return Math.min(2, Math.max(0.5, factor));
}

export interface PinchStep {
  /** Zoom factor (ratio of finger distances). */
  factor: number;
  /** Midpoint of the fingers after the move (zoom anchor). */
  mid: Vec2;
  /** Movement of the midpoint (pan). */
  dx: number;
  dy: number;
}

/** Zoom and pan implied by two fingers moving from (a0, b0) to (a1, b1). */
export function pinchStep(a0: Vec2, b0: Vec2, a1: Vec2, b1: Vec2): PinchStep {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const mid = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  return {
    factor: d0 > 0 && d1 > 0 ? d1 / d0 : 1,
    mid,
    dx: mid.x - mid0.x,
    dy: mid.y - mid0.y,
  };
}
