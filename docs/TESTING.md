# Testing

Three layers of automated tests, plus an engine benchmark. All of them run in CI
(`.github/workflows/ci.yml`).

Related documents: [DEVELOPMENT.md](DEVELOPMENT.md) (setup),
[SIMULATION_RULES.md](SIMULATION_RULES.md#invariants) (what the invariants mean).

## Layers

| Layer                    | Where                              | Runner                | Needs                                                                  | Command                            |
| ------------------------ | ---------------------------------- | --------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| Engine unit tests        | `packages/sim-core/test/*.test.ts` | Vitest                | nothing (pure TypeScript)                                              | `pnpm --filter @civ/sim-core test` |
| Web unit tests           | `apps/web/src/**/*.test.ts`        | Vitest                | nothing (pure logic: camera, geometry, formatting, stream handling, …) | `pnpm --filter @civ/web test`      |
| Server integration tests | `apps/server/test/*.test.ts`       | Vitest                | PostgreSQL database `civ_test`                                         | `pnpm --filter @civ/server test`   |
| Browser end-to-end tests | `apps/web/e2e/*.spec.ts`           | Playwright (Chromium) | PostgreSQL database `civ_e2e`                                          | `pnpm test:e2e`                    |

`pnpm test` runs the first three (`pnpm -r test`); `pnpm check` runs
`format:check`, `lint`, `typecheck` and `test`. `packages/shared` has no tests of its
own (it is exercised by the server and web tests).

### Databases

| Database   | Used by                  | Set up                                                                                                                                                                                                                                                           |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `civ_dev`  | `pnpm dev`               | `pnpm db:migrate`                                                                                                                                                                                                                                                |
| `civ_test` | server integration tests | URL from `TEST_DATABASE_URL` (default `postgresql://civ:civ@localhost:5432/civ_test`); the test setup (`apps/server/test/global-setup.ts`) applies migrations itself. **Tables are truncated by the tests.** Test files run one at a time because they share it. |
| `civ_e2e`  | Playwright's server      | fixed in `apps/web/playwright.config.ts`; migrate once with `DATABASE_URL=postgresql://civ:civ@localhost:5432/civ_e2e pnpm db:migrate`                                                                                                                           |

`docker compose up -d db` creates all three databases on first start (see
[DEVELOPMENT.md](DEVELOPMENT.md#database)). Never point `TEST_DATABASE_URL` at a
database whose data you want to keep.

## What the tests cover

### Engine (`packages/sim-core/test`, 83 tests)

| File                  | Tests | Covers                                                                                                                                                                                                 |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clock.test.ts`       | 7     | calendar arithmetic, seasons, years, night, formatting                                                                                                                                                 |
| `rng.test.ts`         | 10    | hash reference value and key-boundary separation, keyed stream independence, `int`/`chance`/`weightedIndex` edges, uniformity, normal mean and SD                                                      |
| `worldgen.test.ts`    | 13    | exact population, households, zoning, venues, houses and capacities, endowments = issued money, determinism                                                                                            |
| `systems.test.ts`     | 15    | environment (weather on/off, temperature), demography, energy bounds, routine rules, road routes                                                                                                       |
| `events.test.ts`      | 5     | contiguous increasing sequence numbers across ticks, event stamping, catalogue metadata for every type, payloads are plain JSON, frame tuples                                                          |
| `metrics.test.ts`     | 8     | median/mean/Gini on known inputs; every metric has a unique key and a definition; activity and stage counts sum to the population; money supply equals cumulative issuance; `metricsInterval` sampling |
| `invariants.test.ts`  | 14    | a valid run has no violation at any tick; each violation class is detected (below); restore refuses impossible states and the engine halts                                                             |
| `determinism.test.ts` | 11    | same seed ⇒ same hashes, events and metrics; different seeds/configs differ; weather off is repeatable; save/restore reproduces the hash and the continuation; tampered or invalid states are rejected |

**Invariant detection** (`invariants.test.ts`) corrupts a valid state on purpose and
asserts the expected violation code for: negative balances, money created without an
issuance record, money destroyed without a record, fractional cents, homes that are
not houses and overcrowded houses, citizens that are nowhere or in two places, trips
whose window does not contain the current tick, needs out of bounds, life stages
inconsistent with age, duplicate or unordered ids, venue overcrowding, and broken
event sequences. The last test proves that the engine refuses to restore an
impossible state and halts when a step produces one. This is acceptance criterion 8
of Phase 1 at the engine level; the server-level halt is covered by
`snapshots-halt.test.ts`.

### Server (`apps/server/test`, real PostgreSQL)

| File                     | Covers                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.test.ts`            | environment validation: defaults, `DATABASE_URL` required, `AUTH_MODE=disabled` rejected on non-loopback hosts, token rules                                                                                                                                                                                                                                      |
| `http.test.ts`           | the registered routes equal `API_ROUTES`; public, viewer and operator authorisation; CORS preflight; stream `?token=` accepted and redacted from logs; validation and error bodies; duplicate names; static web app with SPA fallback (never for `/api`)                                                                                                         |
| `lifecycle.test.ts`      | atomic genesis, generated seeds; step N via the API equals the pure engine after N ticks, also when running at max speed with intermediate checkpoints; a new server on the same database continues identically; final checkpoint on shutdown; interrupted runs paused (or resumed with `RESUME_RUNNING_ON_START`); reset and delete with confirmation and audit |
| `reads.test.ts`          | projections and `asOfTick`, citizen/building lists and details, event pagination and filters, metric downsampling, audit, exports                                                                                                                                                                                                                                |
| `runner.test.ts`         | a failed checkpoint keeps buffered history and commits it exactly once later; control operations are serialised; a congested stream client skips deltas and resynchronises with a keyframe; events per message are capped and counted as dropped                                                                                                                 |
| `snapshots-halt.test.ts` | save, step, restore reproduces the snapshot exactly and removes later history; unknown snapshot 404; snapshots survive a restart; an impossible state halts the civilization with the reason recorded (also when detected by the background loop) and reset clears it                                                                                            |
| `stream.test.ts`         | hello and keyframe, then deltas and events that reproduce the world; status while running with at most `FRAME_RATE` frames per second; late joiners get a keyframe; reset and deleted notices; unknown civilizations rejected before the upgrade                                                                                                                 |

### Browser (`apps/web/e2e`, Playwright)

The Playwright configuration starts the real server (on `civ_e2e`, auth disabled on
loopback, 500 ms checkpoints, port 3101) and the Vite dev server (port 5273) proxying to
it; tests run serially in Chromium. The specs cover: creating a civilization from the
UI, opening the observatory and deleting it with typed confirmation; stepping one day
(tick and calendar advance, events recorded); play then pause; selecting a citizen and
following the home link to the building; clicking a building on the map; saving a
snapshot, stepping and restoring with confirmation; reset with the exact name; and the
dashboard charting every metric with its definition. On failure, traces and
screenshots are kept in `apps/web/e2e/.artifacts/` (CI uploads them, plus an HTML
report, as the `playwright-report` artifact).

### Results at the time of writing

Run on 2026-10-15 while the server and web app were still being completed; re-run
`pnpm check` and `pnpm test:e2e` for the current state.

| Suite           | Result                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `@civ/sim-core` | 83 / 83 passed (one earlier run on a loaded machine had 1 failure, see below) |
| `@civ/web` unit | 95 / 95 passed (13 files)                                                     |
| `@civ/server`   | 56 / 56 passed (7 files)                                                      |
| Playwright e2e  | not run for this document                                                     |

Known flakiness: `rng.test.ts › next() is uniform on [0,1)` draws enough numbers to take
about 4 s, close to Vitest's default 5 s per-test timeout, and can time out on a busy
machine. It is a timing margin problem, not a determinism problem.

## Running the tests

```sh
docker compose up -d db                 # or any PostgreSQL 16 with civ/civ and the three databases
pnpm install
pnpm db:migrate                         # civ_dev
DATABASE_URL=postgresql://civ:civ@localhost:5432/civ_e2e pnpm db:migrate
pnpm check                              # format, lint, types, unit + integration tests
pnpm test:e2e                           # Playwright (Chromium must be installed once:
                                        #   pnpm --filter @civ/web exec playwright install chromium)
```

Useful variations:

```sh
pnpm --filter @civ/sim-core exec vitest run test/invariants.test.ts   # one file
pnpm --filter @civ/server test:watch                                # watch mode
TEST_DATABASE_URL=postgresql://civ:civ@localhost:5432/other_test pnpm --filter @civ/server test
```

When not on CI, Playwright reuses servers already listening on ports 3101 and 5273.

## Benchmark

`packages/sim-core/bench/tick-benchmark.ts` measures the **engine only**: world
generation time, mean milliseconds per tick with and without invariant checks (168
measured ticks after 24 warm-up ticks, seed `benchmark`), serialised state size and
serialisation time.

```sh
pnpm --filter @civ/sim-core benchmark 100 1000      # default sizes: 100 1000 5000
```

Results measured for this document (two consecutive runs of the command above):

- Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz, 4 cores (as reported by
  `os.cpus()`), 15 GiB RAM, Linux; a shared machine with other processes running.

| Population | Run | Genesis (ms) | ms/tick, invariants on | ms/tick, invariants off | State (KiB) | Serialize (ms) |
| ---------- | --- | ------------ | ---------------------- | ----------------------- | ----------- | -------------- |
| 100        | 1   | 15.6         | 0.424                  | 0.210                   | 56          | 1.9            |
| 100        | 2   | 20.9         | 0.442                  | 0.162                   | 56          | 7.4            |
| 1,000      | 1   | 17.8         | 1.683                  | 1.049                   | 553         | 9.6            |
| 1,000      | 2   | 15.3         | 2.232                  | 1.918                   | 553         | 14.4           |

How to read this:

- The run-to-run spread (up to ~80 % at 1,000 citizens without invariant checks) comes
  from the shared machine; compare runs on an idle machine before drawing conclusions.
- Invariant checks are a large share of the per-tick cost at these sizes. They stay on
  by default because experiments must not continue from impossible states.
- **This is engine-only.** It excludes checkpoints (serialisation, gzip, database
  transactions), projections, HTTP and the WebSocket stream. As one end-to-end
  observation, stepping 240 ticks through `POST …/control` (including the final
  checkpoint) took 0.19 s for 100 citizens and 0.75 s for 1,000 citizens with the
  production build against a local PostgreSQL on the same machine — a single sample,
  not a benchmark.
