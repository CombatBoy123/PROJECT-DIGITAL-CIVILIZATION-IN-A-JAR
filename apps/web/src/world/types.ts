import type { LayoutResponse } from '@civ/shared';
import type { FrameStore } from './frame-store';

/*
 * Contract between the observatory shell (React panels, data fetching, stream
 * client) and the PixiJS world renderer. The renderer is a pure consumer: it draws
 * the layout and the positions in the FrameStore and reports user interaction. It
 * never decides anything about the simulation.
 */

export type Selection = { kind: 'citizen'; id: number } | { kind: 'building'; id: number };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);
}

export interface WorldViewProps {
  /** Static geography (map, buildings, households). Replaced after a reset/restore. */
  layout: LayoutResponse;
  /** Live citizen positions, fed by the stream client. */
  frames: FrameStore;
  /** Currently selected entity (drawn highlighted). */
  selection: Selection | null;
  /** Called when the user clicks an entity (or empty ground → null). */
  onSelect: (selection: Selection | null) => void;
  /**
   * Citizens to emphasise (e.g. the result of the current list filter). Other citizens
   * are dimmed. null/undefined = no emphasis.
   */
  highlight?: ReadonlySet<number> | null;
  /** Optional display name for hover labels; return undefined when unknown. */
  citizenLabel?: (id: number) => string | undefined;
  /**
   * Centre the camera on this entity whenever `focusNonce` changes (e.g. when the user
   * picks a citizen from the list). Travelling citizens are followed at their current
   * interpolated position at the moment of focusing.
   */
  focus?: Selection | null;
  focusNonce?: number;
}
