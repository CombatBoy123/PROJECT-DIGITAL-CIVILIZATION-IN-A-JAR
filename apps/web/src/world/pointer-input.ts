import type { Vec2 } from './camera';
import { dragThreshold, exceedsThreshold, pinchStep, wheelZoomFactor } from './gestures';

/*
 * Pointer and wheel input for the map surface (DOM only; no PixiJS).
 *
 *  - one pointer: press–move beyond a small threshold pans; press–release without
 *    moving is a click (select);
 *  - two touch pointers: pinch zoom about the finger midpoint, plus pan;
 *  - wheel: zoom about the cursor;
 *  - mouse movement without buttons: hover.
 *
 * All coordinates passed to the handler are CSS pixels relative to the element.
 */

export interface PointerInputHandler {
  panBy(dx: number, dy: number): void;
  zoomAt(sx: number, sy: number, factor: number): void;
  click(sx: number, sy: number): void;
  hover(point: Vec2 | null): void;
  /** A drag or pinch started (cancels camera animations, hides hover). */
  gestureStart(): void;
  setDragging(dragging: boolean): void;
}

interface TrackedPointer {
  type: string;
  start: Vec2;
  last: Vec2;
}

export class PointerInput {
  private readonly pointers = new Map<number, TrackedPointer>();
  /** True once the current press has moved beyond the click threshold (or became a pinch). */
  private dragging = false;
  private readonly listeners: [string, EventListener, AddEventListenerOptions | undefined][] = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly handler: PointerInputHandler,
  ) {
    this.listen('pointerdown', this.onPointerDown as EventListener);
    this.listen('pointermove', this.onPointerMove as EventListener);
    this.listen('pointerup', this.onPointerUp as EventListener);
    this.listen('pointercancel', this.onPointerCancel as EventListener);
    this.listen('pointerleave', this.onPointerLeave as EventListener);
    // Not passive: the page must not scroll while zooming the map.
    this.listen('wheel', this.onWheel as EventListener, { passive: false });
    // Touch gestures are handled here, not by the browser (see also `touch-action: none` in CSS).
    this.listen('contextmenu', this.onContextMenu as EventListener);
  }

  destroy(): void {
    for (const [type, listener, options] of this.listeners) {
      this.element.removeEventListener(type, listener, options);
    }
    this.listeners.length = 0;
    this.pointers.clear();
  }

  private listen(type: string, listener: EventListener, options?: AddEventListenerOptions): void {
    this.element.addEventListener(type, listener, options);
    this.listeners.push([type, listener, options]);
  }

  private local(event: { clientX: number; clientY: number }): Vec2 {
    const r = this.element.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, { type: event.pointerType, start: p, last: p });
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // Capture can fail for synthetic events; dragging still works while over the element.
    }
    if (this.pointers.size === 2) this.beginDrag();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const p = this.local(event);
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) {
      if (this.pointers.size === 0 && event.pointerType === 'mouse') this.handler.hover(p);
      return;
    }
    if (this.pointers.size >= 2) {
      this.pinch(event.pointerId, p);
      return;
    }
    if (!this.dragging) {
      const dx = p.x - tracked.start.x;
      const dy = p.y - tracked.start.y;
      if (!exceedsThreshold(dx, dy, dragThreshold(tracked.type))) return;
      this.beginDrag();
      // Apply the movement accumulated below the threshold so the map does not lag the cursor.
      this.handler.panBy(dx, dy);
    } else {
      this.handler.panBy(p.x - tracked.last.x, p.y - tracked.last.y);
    }
    tracked.last = p;
  };

  private pinch(movedId: number, p: Vec2): void {
    const entries = [...this.pointers.entries()];
    const first = entries[0];
    const second = entries[1];
    if (!first || !second) return;
    const [idA, a] = first;
    const [idB, b] = second;
    // Only the first two fingers drive the pinch; a third is ignored.
    if (movedId !== idA && movedId !== idB) return;
    const a1 = movedId === idA ? p : a.last;
    const b1 = movedId === idB ? p : b.last;
    const step = pinchStep(a.last, b.last, a1, b1);
    this.handler.panBy(step.dx, step.dy);
    this.handler.zoomAt(step.mid.x, step.mid.y, step.factor);
    a.last = a1;
    b.last = b1;
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const tracked = this.pointers.get(event.pointerId);
    if (!tracked) return;
    this.pointers.delete(event.pointerId);
    if (!this.dragging && this.pointers.size === 0) {
      this.handler.click(tracked.start.x, tracked.start.y);
    }
    this.endIfIdle(event);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.endIfIdle(event);
  };

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) this.handler.hover(null);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const p = this.local(event);
    this.handler.gestureStart();
    this.handler.zoomAt(p.x, p.y, wheelZoomFactor(event.deltaY, event.deltaMode));
  };

  private readonly onContextMenu = (event: Event): void => {
    // A long press on touch screens would otherwise open the context menu mid-pinch.
    if (this.pointers.size > 0) event.preventDefault();
  };

  private beginDrag(): void {
    if (this.dragging) return;
    this.dragging = true;
    this.handler.gestureStart();
    this.handler.hover(null);
    this.handler.setDragging(true);
  }

  private endIfIdle(event: PointerEvent): void {
    if (this.pointers.size > 0) {
      // One finger of a pinch lifted: continue as a one-finger pan from here.
      for (const p of this.pointers.values()) p.last = p.start = p.last;
      return;
    }
    if (this.dragging) {
      this.dragging = false;
      this.handler.setDragging(false);
    }
    if (event.pointerType === 'mouse') this.handler.hover(this.local(event));
  }
}
