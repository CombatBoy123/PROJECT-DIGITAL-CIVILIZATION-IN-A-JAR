import { demographySystem } from '../systems/demography.js';
import { environmentSystem } from '../systems/environment.js';
import { needsSystem } from '../systems/needs.js';
import { routineSystem } from '../systems/routine.js';
import type { SimSystem } from './context.js';

/**
 * The tick pipeline, in execution order. See ARCHITECTURE.md §5.2 for the full
 * eight-stage order; stages without Phase 1 content are absent.
 *
 *   1  environment   — calendar, seasons, weather, temperature
 *   2  demography    — ageing, life stages
 *   2  needs         — energy from the activity held during the elapsed hour
 *   7  routine       — arrivals, sleeping/waking, outings, returning home
 */
export const PIPELINE: readonly SimSystem[] = [
  environmentSystem,
  demographySystem,
  needsSystem,
  routineSystem,
];

for (let i = 1; i < PIPELINE.length; i++) {
  if ((PIPELINE[i] as SimSystem).stage < (PIPELINE[i - 1] as SimSystem).stage) {
    throw new Error('PIPELINE must be ordered by stage');
  }
}
