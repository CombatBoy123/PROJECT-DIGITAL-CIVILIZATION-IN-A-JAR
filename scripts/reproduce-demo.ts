/**
 * Reproducibility walkthrough (engine only: no database, no server).
 *
 *   pnpm --filter @civ/sim-core exec tsx ../../scripts/reproduce-demo.ts [seed] [population]
 *
 * Prints the values quoted in docs/EXPERIMENTS.md: state hashes after 0, 24 and 240
 * ticks for one seed and configuration, selected metrics, event counts, and three
 * checks that anyone can repeat:
 *   1. two independent runs with the same seed and configuration hash identically;
 *   2. a run restored from a serialised mid-run state continues to the same hash;
 *   3. the same seed with a different configuration (stochastic weather off) diverges.
 *
 * Exit code 1 if check 1 or 2 fails.
 */
import {
  calendarAt,
  formatCalendar,
  Simulation,
  type EventType,
  type MetricKey,
  type SimulationConfigInput,
  type StepResult,
} from '../packages/sim-core/src/index.js';

const seed = process.argv[2] ?? 'demo-1';
const population = Number(process.argv[3] ?? 100);
const CHECKPOINTS = [0, 24, 240] as const;
/** Metric columns: the hash ticks (all midnight, everyone asleep) plus two noons. */
const METRIC_TICKS = [0, 12, 24, 228, 240] as const;
const RESTORE_AT = 24;
const SHOWN_METRICS: readonly MetricKey[] = [
  'population.total',
  'population.children',
  'population.adults',
  'population.elders',
  'activity.sleeping',
  'activity.atHome',
  'activity.leisure',
  'activity.traveling',
  'needs.energyMean',
  'money.supply',
  'wealth.medianAdult',
  'wealth.giniAdult',
  'environment.temperatureC',
];

interface RunRecord {
  hashes: Map<number, string>;
  results: StepResult[];
  simulation: Simulation;
}

/** Create a world and record its hash at every tick listed in CHECKPOINTS. */
function record(config: SimulationConfigInput): RunRecord {
  const { simulation, genesis } = Simulation.create(seed, config);
  const hashes = new Map<number, string>([[0, simulation.hash()]]);
  const results: StepResult[] = [genesis];
  const last = CHECKPOINTS[CHECKPOINTS.length - 1] ?? 0;
  while (simulation.tick < last) {
    results.push(simulation.step());
    if ((CHECKPOINTS as readonly number[]).includes(simulation.tick)) {
      hashes.set(simulation.tick, simulation.hash());
    }
  }
  return { hashes, results, simulation };
}

function countEvents(results: readonly StepResult[]): Map<EventType, number> {
  const counts = new Map<EventType, number>();
  for (const r of results)
    for (const e of r.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return counts;
}

const config: SimulationConfigInput = { population };
const a = record(config);
const b = record(config);

console.log(`Seed "${seed}", population ${population}, all other parameters at their defaults`);
console.log(`Node ${process.version}\n`);

// World at genesis.
const genesisState = Simulation.create(seed, config).simulation.state;
const kinds = new Map<string, number>();
for (const building of genesisState.buildings) {
  kinds.set(building.kind, (kinds.get(building.kind) ?? 0) + 1);
}
const zones = new Map<string, number>();
for (const block of genesisState.map.blocks)
  zones.set(block.zone, (zones.get(block.zone) ?? 0) + 1);
const occupied = new Set(genesisState.households.map((h) => h.homeId));
console.log('World at genesis:');
console.log(
  `  map ${genesisState.map.width}×${genesisState.map.height} tiles, ${genesisState.map.cols}×${genesisState.map.rows} blocks (${[...zones].map(([z, n]) => `${z} ${n}`).join(', ')})`,
);
console.log(
  `  buildings ${genesisState.buildings.length} (${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}), vacant houses ${(kinds.get('house') ?? 0) - occupied.size}`,
);
console.log(
  `  households ${genesisState.households.length}, citizens ${genesisState.citizens.length}, money issued ${genesisState.ledger.issuedCents} cents\n`,
);

console.log('tick | calendar              | state hash');
console.log('---- | --------------------- | --------------------------------');
for (const tick of CHECKPOINTS) {
  const calendar = formatCalendar(calendarAt(tick, a.simulation.state.config));
  console.log(`${String(tick).padStart(4)} | ${calendar.padEnd(21)} | ${a.hashes.get(tick)}`);
}

console.log('\nMetrics (metric sample of each tick; ticks 12 and 228 are noon):\n');
console.log(
  `${'metric'.padEnd(26)} | ${METRIC_TICKS.map((t) => `tick ${t}`.padStart(10)).join(' | ')}`,
);
console.log(`${'-'.repeat(26)} | ${METRIC_TICKS.map(() => '-'.repeat(10)).join(' | ')}`);
for (const key of SHOWN_METRICS) {
  const cells = METRIC_TICKS.map((tick) => {
    const value = a.results[tick]?.metrics?.values[key];
    return String(value ?? 'n/a').padStart(10);
  });
  console.log(`${key.padEnd(26)} | ${cells.join(' | ')}`);
}

console.log(`\nEvents emitted from genesis through tick ${a.simulation.tick}:`);
for (const [type, n] of [...countEvents(a.results)].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(`  ${type.padEnd(20)} ${n}`);
}
console.log(`  next event seq       ${a.simulation.state.nextEventSeq}`);
console.log(`  weather at tick ${a.simulation.tick}    ${a.simulation.state.environment.weather}`);

// Check 1: independent runs agree.
const runsAgree = CHECKPOINTS.every((t) => a.hashes.get(t) === b.hashes.get(t));
console.log(
  `\n[1] Second independent run, identical hashes at ${CHECKPOINTS.join('/')}: ${runsAgree}`,
);

// Check 2: serialise mid-run, restore, continue.
const { simulation: forRestore } = Simulation.create(seed, config);
forRestore.run(RESTORE_AT);
const restored = Simulation.deserialize(forRestore.serialize(), forRestore.hash());
restored.run((CHECKPOINTS[CHECKPOINTS.length - 1] ?? 0) - RESTORE_AT);
const restoreAgrees = restored.hash() === a.hashes.get(restored.tick);
console.log(
  `[2] Restored from tick ${RESTORE_AT}, continued to tick ${restored.tick}: hash ${restored.hash()} (matches: ${restoreAgrees})`,
);

// Check 3: same seed, different configuration.
const calm = record({ population, stochastic: { weather: false } });
console.log('[3] Same seed, stochastic weather off:');
for (const tick of CHECKPOINTS) {
  const same = calm.hashes.get(tick) === a.hashes.get(tick);
  console.log(
    `    tick ${String(tick).padStart(3)}: ${calm.hashes.get(tick)} (same as default: ${same})`,
  );
}
const citizensJson = (r: RunRecord | Simulation) =>
  JSON.stringify((r instanceof Simulation ? r : r.simulation).state.citizens);
const calmGenesis = Simulation.create(seed, { population, stochastic: { weather: false } });
console.log(
  `    citizens identical at genesis: ${citizensJson(calmGenesis.simulation) === JSON.stringify(genesisState.citizens)}`,
);
const differing = a.simulation.state.citizens.filter(
  (c, i) => JSON.stringify(c) !== JSON.stringify(calm.simulation.state.citizens[i]),
).length;
console.log(
  `    citizens whose state differs at tick ${a.simulation.tick}: ${differing} of ${a.simulation.state.citizens.length}`,
);
const leisure = (r: RunRecord) =>
  r.results.reduce((sum, s) => sum + (s.metrics?.values['activity.leisure'] ?? 0), 0);
console.log(
  `    citizen-hours at venues over ticks 0–${CHECKPOINTS[CHECKPOINTS.length - 1]}: default ${leisure(a)}, weather off ${leisure(calm)}`,
);

if (!runsAgree || !restoreAgrees) process.exitCode = 1;
