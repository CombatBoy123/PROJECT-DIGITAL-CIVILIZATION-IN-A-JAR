import { createContext, useContext } from 'react';
import type { Selection } from '../world/types';
import type { DemoEngine } from './engine';

/*
 * What every demo panel needs: the engine controller and a way to select an entity
 * (optionally centring the map on it).
 */

export interface DemoContextValue {
  engine: DemoEngine;
  select(selection: Selection | null, options?: { focus?: boolean }): void;
}

export const DemoContext = createContext<DemoContextValue | null>(null);

export function useDemo(): DemoContextValue {
  const value = useContext(DemoContext);
  if (!value) throw new Error('useDemo must be used inside DemoContext');
  return value;
}
