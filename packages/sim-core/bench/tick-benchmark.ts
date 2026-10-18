/**
 * Engine tick benchmark (no database, no network).
 *
 *   pnpm --filter @civ/sim-core benchmark [populations...]
 *
 * Reports world generation time, mean milliseconds per tick with and without
 * invariant checks, and serialised state size. Results depend on hardware; record
 * the environment alongside any numbers you publish.
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Simulation, type InvariantMode } from '../src/index.js';

const populations = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => n > 0);
const sizes = populations.length > 0 ? populations : [100, 1000, 5000];
const TICKS = 24 * 7;

function measure(population: number, invariants: InvariantMode) {
  const t0 = performance.now();
  const { simulation } = Simulation.create('benchmark', { population }, { invariants });
  const genesisMs = performance.now() - t0;
  // Warm up the JIT.
  simulation.run(24);
  const t1 = performance.now();
  simulation.run(TICKS);
  const perTickMs = (performance.now() - t1) / TICKS;
  const t2 = performance.now();
  const json = simulation.serialize();
  const serializeMs = performance.now() - t2;
  return { genesisMs, perTickMs, stateKiB: json.length / 1024, serializeMs };
}

console.log(
  `Node ${process.version} · ${os.cpus()[0]?.model ?? 'unknown CPU'} · ${os.cpus().length} cores`,
);
console.log(`Ticks measured per run: ${TICKS} (after 24 warm-up ticks)\n`);
console.log(
  'population | genesis ms | ms/tick (invariants) | ms/tick (no invariants) | state KiB | serialize ms',
);
console.log(
  '---------- | ---------- | -------------------- | ----------------------- | --------- | ------------',
);
for (const population of sizes) {
  const checked = measure(population, 'every-tick');
  const unchecked = measure(population, 'off');
  console.log(
    [
      String(population).padStart(10),
      checked.genesisMs.toFixed(1).padStart(10),
      checked.perTickMs.toFixed(3).padStart(20),
      unchecked.perTickMs.toFixed(3).padStart(23),
      checked.stateKiB.toFixed(0).padStart(9),
      checked.serializeMs.toFixed(1).padStart(12),
    ].join(' | '),
  );
}
