import { WEATHER, type WorldState } from '../state/schema.js';
import { ROUTINE_RULES } from '../systems/routine.js';
import type { MetricValues } from './definitions.js';
import { gini, mean, median, sum } from './stats.js';

/** Round to 6 decimals so stored series are compact and stable. */
function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Compute every metric in METRIC_DEFINITIONS from the current state. Pure. */
export function computeMetrics(state: WorldState): MetricValues {
  const citizens = state.citizens;
  let children = 0;
  let adults = 0;
  let elders = 0;
  let sleeping = 0;
  let atHome = 0;
  let leisure = 0;
  let traveling = 0;
  let lowEnergy = 0;
  const energies: number[] = [];
  const balances: number[] = [];
  const adultWealth: number[] = [];

  for (const c of citizens) {
    if (c.lifeStage === 'child') children++;
    else if (c.lifeStage === 'adult') adults++;
    else elders++;
    if (c.activity === 'sleeping') sleeping++;
    else if (c.activity === 'at_home') atHome++;
    else if (c.activity === 'leisure') leisure++;
    else traveling++;
    if (c.needs.energy < ROUTINE_RULES.sleepEnergy) lowEnergy++;
    energies.push(c.needs.energy);
    balances.push(c.balanceCents);
    if (c.lifeStage !== 'child') adultWealth.push(c.balanceCents);
  }

  const population = citizens.length;
  return {
    'population.total': population,
    'population.children': children,
    'population.adults': adults,
    'population.elders': elders,
    'activity.sleeping': sleeping,
    'activity.atHome': atHome,
    'activity.leisure': leisure,
    'activity.traveling': traveling,
    'needs.energyMean': r6(mean(energies)),
    'needs.lowEnergyShare': population === 0 ? 0 : r6(lowEnergy / population),
    'money.supply': sum(balances),
    'money.issuedCumulative': state.ledger.issuedCents,
    'wealth.meanAdult': r6(mean(adultWealth)),
    'wealth.medianAdult': median(adultWealth),
    'wealth.giniAdult': r6(gini(adultWealth)),
    'environment.temperatureC': state.environment.temperatureC,
    'environment.weatherCode': WEATHER.indexOf(state.environment.weather),
  };
}
