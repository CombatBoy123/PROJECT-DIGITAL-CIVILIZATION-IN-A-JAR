import { Simulation, type WorldState } from '../src/index.js';

export function newSimulation(seed = 'test-seed', config: Record<string, unknown> = {}) {
  return Simulation.create(seed, { population: 60, ...config });
}

/** A mutable deep copy of a simulation's state. */
export function cloneState(simulation: Simulation): WorldState {
  return JSON.parse(simulation.serialize()) as WorldState;
}

/** Step until the simulation reaches the given tick. */
export function runUntil(simulation: Simulation, tick: number) {
  const results = [];
  while (simulation.tick < tick) results.push(simulation.step());
  return results;
}
