import type { SimulationConfig } from '../config.js';
import type { SimSystem, TickContext } from '../engine/context.js';
import type { Citizen, LifeStage } from '../state/schema.js';
import { ticksPerYear } from '../time/clock.js';

/*
 * Stage 2a — demography (Phase 1: ageing only).
 *
 * Age is derived from `birthTick`; a LifeStageChanged event is emitted on the tick a
 * citizen crosses the adult or elder threshold. Births, deaths and migration are not
 * simulated yet (see ROADMAP.md), so the population is constant.
 */

export function lifeStageForAge(
  ageYears: number,
  config: Pick<SimulationConfig, 'lifeStages'>,
): LifeStage {
  if (ageYears < config.lifeStages.adultAge) return 'child';
  if (ageYears < config.lifeStages.elderAge) return 'adult';
  return 'elder';
}

export function ageInYears(
  citizen: Pick<Citizen, 'birthTick'>,
  tick: number,
  config: Pick<SimulationConfig, 'daysPerSeason'>,
): number {
  return Math.floor((tick - citizen.birthTick) / ticksPerYear(config));
}

export const demographySystem: SimSystem = {
  name: 'demography',
  stage: 2,
  run(ctx: TickContext): void {
    const { state, tick, events } = ctx;
    for (const citizen of state.citizens) {
      const age = ageInYears(citizen, tick, state.config);
      const stage = lifeStageForAge(age, state.config);
      if (stage !== citizen.lifeStage) {
        const from = citizen.lifeStage;
        citizen.lifeStage = stage;
        events.emit('LifeStageChanged', { from, to: stage, ageYears: age }, [
          { kind: 'citizen', id: citizen.id, role: 'subject' },
        ]);
      }
    }
  },
};
