import type { SimulationConfig } from '@civ/sim-core';
import { createContext, useContext } from 'react';
import type { Selection } from '../../world/types';

/*
 * Shared state of one observatory page: which civilization, its calendar config (to
 * turn event ticks into calendar time) and the selection/focus actions used by every
 * panel that links to an entity.
 */

export interface ObservatoryContextValue {
  civilizationId: string;
  civilizationName: string;
  config: SimulationConfig | null;
  selection: Selection | null;
  /** Select an entity (null clears). `focus` also centres the map on it. */
  select: (selection: Selection | null, options?: { focus?: boolean }) => void;
}

export const ObservatoryContext = createContext<ObservatoryContextValue | null>(null);

export function useObservatory(): ObservatoryContextValue {
  const ctx = useContext(ObservatoryContext);
  if (!ctx) throw new Error('useObservatory must be used inside the observatory page');
  return ctx;
}
