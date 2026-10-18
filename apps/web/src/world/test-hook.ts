import type { Selection } from './types';

/**
 * Test hook installed on `window.__civWorldTestHook` while a WorldView is mounted,
 * so browser tests can click entities on the canvas. Read-only: it exposes screen
 * positions, never simulation controls.
 */
export interface CivWorldTestHook {
  /**
   * Client (viewport) coordinates of the entity's centre; null when the entity is
   * unknown, off-screen, or covered by an overlay control.
   */
  screenPointOf(selection: Selection): { x: number; y: number } | null;
  /** True once the map is drawn and the camera is placed. */
  readonly ready: boolean;
}
