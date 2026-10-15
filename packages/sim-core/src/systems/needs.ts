import type { SimSystem, TickContext } from '../engine/context.js';
import type { Activity } from '../state/schema.js';

/*
 * Stage 2b — needs (Phase 1: energy only).
 *
 * Energy changes according to the activity the citizen held during the hour that
 * just elapsed (the activity chosen in stage 7 of the previous tick). Hunger,
 * health, happiness and security arrive with the Phase 3 needs model.
 */

export const ENERGY_RULES = {
  /** Energy recovered per hour of sleep. */
  sleepGain: 9,
  /** Energy spent per hour, by activity. */
  drain: {
    sleeping: 0,
    at_home: 1.5,
    leisure: 2.5,
    traveling: 3,
  } satisfies Record<Activity, number>,
  /** Elders tire faster. */
  elderDrainMultiplier: 1.25,
} as const;

export function energyDelta(activity: Activity, isElder: boolean): number {
  if (activity === 'sleeping') return ENERGY_RULES.sleepGain;
  const drain = ENERGY_RULES.drain[activity];
  return -(isElder ? drain * ENERGY_RULES.elderDrainMultiplier : drain);
}

export const needsSystem: SimSystem = {
  name: 'needs',
  stage: 2,
  run(ctx: TickContext): void {
    for (const citizen of ctx.state.citizens) {
      const next =
        citizen.needs.energy + energyDelta(citizen.activity, citizen.lifeStage === 'elder');
      // Round to 1/1000 to keep serialised values short and stable; clamp to [0, 100].
      citizen.needs.energy = Math.round(Math.min(100, Math.max(0, next)) * 1000) / 1000;
    }
  },
};
