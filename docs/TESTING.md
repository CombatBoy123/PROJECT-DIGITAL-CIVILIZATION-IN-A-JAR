# Testing

Three layers of automated tests, all of which run in CI (`.github/workflows/ci.yml`),
plus an engine benchmark that is run by hand (CI does not run it).

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
own (it is exercised by the server and web tests). `pnpm test:e2e` first runs
`pnpm db:migrate:e2e` (migrations for `civ_e2e`, idempotent) and then Playwright.

### Databases

| Database   | Used by                  | Set up                                                                                                                                                                                                                                                           |
| ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `civ_dev`  | `pnpm dev`               | `pnpm db:migrate`                                                                                                                                                                                                                                                |
| `civ_test` | server integration tests | URL from `TEST_DATABASE_URL` (default `postgresql://civ:civ@localhost:5432/civ_test`); the test setup (`apps/server/test/global-setup.ts`) applies migrations itself. **Tables are truncated by the tests.** Test files run one at a time because they share it. |
| `civ_e2e`  | Playwright's server      | `E2E_DATABASE_URL` or the default in `apps/web/playwright.config.ts`; `pnpm test:e2e` migrates it (`pnpm db:migrate:e2e`, which uses `E2E_DATABASE_URL` when set)                                                                                                |

`docker compose up -d db` creates all three databases on first start (see
[DEVELOPMENT.md](DEVELOPMENT.md#database)). Never point `TEST_DATABASE_URL` at a
database whose data you want to keep.

## What the tests cover

### Engine (`packages/sim-core/test`, 94 tests)

| File                  | Tests | Covers                                                                                                                                                                                                                                                                                   |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clock.test.ts`       | 7     | calendar arithmetic, seasons, years, night, formatting                                                                                                                                                                                                                                   |
| `rng.test.ts`         | 10    | hash reference value and key-boundary separation, keyed stream independence, `int`/`chance`/`weightedIndex` edges, uniformity, normal mean and SD                                                                                                                                        |
| `worldgen.test.ts`    | 14    | exact population, households, zoning, venues, houses and capacities, unique building names (including houses facing each other across a road), endowments = issued money, determinism, 1,000 citizens                                                                                    |
| `systems.test.ts`     | 18    | environment (weather on/off, temperature), demography, energy bounds, routine rules, outings that must fit the day and the energy budget, nobody out at night at population 1,000 / walking speed 4 and population 5,000 / walking speed 24, storms, travel times and road routes        |
| `events.test.ts`      | 5     | contiguous increasing sequence numbers across ticks, event stamping, catalogue metadata for every type, payloads are plain JSON, frame tuples                                                                                                                                            |
| `metrics.test.ts`     | 8     | median/mean/Gini on known inputs; every metric has a unique key and a definition; activity and stage counts sum to the population; money supply equals cumulative issuance; `metricsInterval` sampling                                                                                   |
| `invariants.test.ts`  | 20    | a valid run has no violation at any tick; each violation class is detected (below); correctly timed trips are accepted; restore refuses impossible states (also with per-tick checks off) and the engine halts                                                                           |
| `determinism.test.ts` | 12    | same seed ⇒ same hashes, events and metrics; different seeds/configs differ; weather off is repeatable; save/restore reproduces the hash and the continuation; tampered or invalid states, unknown properties and seeds that creation would refuse are rejected; canonical serialisation |

**Invariant detection** (`invariants.test.ts`) corrupts a valid state on purpose and
asserts the expected violation code for: negative balances, money created without an
issuance record, money destroyed without a record, fractional cents
(`NEGATIVE_BALANCE`, `MONEY_CONSERVATION`); homes that are not houses and overcrowded
houses (`HOUSING`); citizens that are nowhere or in two places, trips whose window does
not contain the current tick, and trips to the wrong place, with the wrong purpose or
of the wrong length (`LOCATION`); overlapping buildings and buildings outside the map
(`MAP`); an environment that contradicts the weather settings (`ENVIRONMENT`); needs
out of bounds (`NEEDS_BOUNDS`); life stages inconsistent with age (`LIFE_STAGE`);
duplicate or unordered ids (`IDENTITY`); venue overcrowding (`VENUE_CAPACITY`); and
broken event sequences (`EVENT_SEQUENCE`). The last test proves that the engine refuses
to restore an impossible state and halts when a step produces one. The server-level
halt is covered by `snapshots-halt.test.ts`.

Every invariant code has a detection test, including `CLOCK` (a negative or non-integer
tick, an `activitySince` in the future), and a test proves that genesis and restored
states are validated even when per-tick checks are off.

### Server (`apps/server/test`, real PostgreSQL, 75 tests)

| File                     | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.test.ts`            | 6     | environment validation: defaults, `DATABASE_URL` required, `AUTH_MODE=disabled` rejected on non-loopback hosts, token rules, number/list/boolean parsing                                                                                                                                                                                                                                                                                    |
| `http.test.ts`           | 17    | the registered routes equal `API_ROUTES`; public, viewer and operator authorisation; access decided from the matched route (percent-encoded and absolute-form targets); unlisted `/api` routes fail closed; `?token=` only on stream upgrades and redacted from logs; CORS preflight; disabled mode serves only loopback `Host` headers and trusted origins; validation and error bodies; duplicate names; static web app with SPA fallback |
| `lifecycle.test.ts`      | 11    | atomic genesis, generated seeds; step N via the API equals the pure engine after N ticks, also when running at max speed with intermediate checkpoints; a new server on the same database continues identically; final checkpoint on shutdown; interrupted runs paused (or resumed with `RESUME_RUNNING_ON_START`); reset and delete with confirmation and audit                                                                            |
| `projections.test.ts`    | 3     | incremental projection deltas equal a full rebuild, also with a removal and an addition in the same interval; rebuild after `invalidate()`                                                                                                                                                                                                                                                                                                  |
| `reads.test.ts`          | 16    | projections and `asOfTick`, citizen/building lists and details, literal name search (`%`, `_`), blank or malformed integer query parameters rejected, event pagination and filters, metric downsampling, audit, exports                                                                                                                                                                                                                     |
| `recovery.test.ts`       | 4     | a pause with nothing uncommitted is stored and survives eviction and reload; client-safe failure messages with a log reference; an unloadable stored state is shown as halted and recovered by reset or restore; exports abort on a rewind instead of ending early or mixing timelines                                                                                                                                                      |
| `runner.test.ts`         | 8     | a failed checkpoint keeps buffered history and commits it exactly once later; a control action whose write fails changes nothing and can be retried; a pause is persisted with nothing uncommitted; a halt during a restore is recorded; control operations are serialised; a congested stream client skips deltas and resynchronises, and is disconnected after `STALLED_CLIENT_MS`; events per message are capped                         |
| `snapshots-halt.test.ts` | 4     | save, step, restore reproduces the snapshot exactly and removes later history; unknown snapshot 404; snapshots survive a restart; an impossible state halts the civilization with the reason recorded (also when detected by the background loop) and reset clears it                                                                                                                                                                       |
| `stream.test.ts`         | 6     | hello and keyframe, then deltas and events that reproduce the world; status while running with at most `FRAME_RATE` frames per second; late joiners get a keyframe; reset and deleted notices; connection caps in total and per address; unknown civilizations rejected before the upgrade                                                                                                                                                  |

### Web unit tests (`apps/web/src`, 120 tests in 15 files)

Pure logic only: access verdicts per token (`api/access.test.ts`), stream message
handling, chart axes (nice whole-number ticks, distinct labels, non-overlapping season
labels), the creation form's config mapping, event summaries, formatting, keyboard
shortcuts, camera, geometry, gestures, map hit-testing (a click inside a building picks
a citizen only on its dot), minimap, palette and contrast, hover summaries, selection in the
URL, throttling and API client helpers.

### Browser (`apps/web/e2e`, Playwright, 18 tests)

The Playwright configuration starts the real server (on `civ_e2e`, auth disabled on
loopback, 500 ms checkpoints, port 3101) and the Vite dev server (port 5273) proxying to
it; tests run serially in Chromium at 1440 × 900. The specs cover:

- `civilizations.spec.ts`: creating a civilization from the UI, opening the observatory
  and deleting it with typed confirmation; a failed submission focuses the first
  invalid field and links its error.
- `observatory.spec.ts`: stepping one day (tick and calendar advance, events recorded);
  play then pause; selecting a citizen and following the home link to the building;
  clicking a building on the map; saving a snapshot, stepping and restoring with
  confirmation; reset with the exact name; Space scrolls a focused panel instead of
  starting the simulation; the audit tab shows a speed change; a snapshot validation
  error replaces the previous server error.
- `dashboard.spec.ts`: every metric is charted with its definition; season labels never
  overlap and axis labels are distinct; an invalid custom range hides the previous
  range's charts.
- `access.spec.ts`: operator-only controls under token auth. Because the e2e server
  runs with auth disabled, the browser is served a token-mode `/api/meta` and, for the
  viewer case, `403` answers on operator routes (the server's real token handling is
  covered by `http.test.ts`): a viewer token disables the controls and says why; without
  a token the controls are disabled with a prompt; an accepted control action confirms
  the operator token.
- `layout.spec.ts`: no page scrolls horizontally at 390 px.

On failure, traces and screenshots are kept in `apps/web/e2e/.artifacts/` (CI uploads
them, plus an HTML report, as the `playwright-report` artifact).

### Results

Run on 2026-10-15 on the working tree that includes the engine fixes of commit
`88d349b` and the server and web fixes made after it (Node v22.22.0, PostgreSQL 16,
Chromium from Playwright):

| Command                            | Result                                  |
| ---------------------------------- | --------------------------------------- |
| `pnpm typecheck`                   | passed in all 4 packages                |
| `pnpm lint`                        | passed                                  |
| `pnpm --filter @civ/sim-core test` | 94 / 94 passed (8 files)                |
| `pnpm --filter @civ/web test`      | 120 / 120 passed (15 files)             |
| `pnpm --filter @civ/server test`   | 75 / 75 passed (9 files)                |
| `pnpm test:e2e` (from the root)    | `civ_e2e` migrated, then 18 / 18 passed |
| `pnpm build`                       | passed                                  |
| CI on GitHub                       | not yet run                             |

Timing margins: the slowest engine test ("at population 5000 and walking speed 24
nobody is out at night") takes about 2 s, within Vitest's default 5 s per-test
timeout; the whole engine suite takes about 5 s.

## Running the tests

```sh
docker compose up -d db                 # or any PostgreSQL 16 with civ/civ and the three databases
pnpm install
pnpm db:migrate                         # civ_dev
pnpm check                              # format, lint, types, unit + integration tests
pnpm test:e2e                           # migrates civ_e2e, then Playwright. Chromium must be
                                        #   installed once: pnpm --filter @civ/web exec playwright install chromium
```

Useful variations:

```sh
pnpm --filter @civ/sim-core exec vitest run test/invariants.test.ts   # one file
pnpm --filter @civ/server test:watch                                # watch mode
TEST_DATABASE_URL=postgresql://civ:civ@localhost:5432/other_test pnpm --filter @civ/server test
E2E_DATABASE_URL=postgresql://civ:civ@localhost:5432/other_e2e pnpm db:migrate:e2e
```

`pnpm db:migrate:e2e` (`scripts/migrate-e2e.mjs`) works on every platform, Windows
included. Playwright's server uses the same database (`E2E_DATABASE_URL`, default
`civ_e2e`). When not on CI, Playwright reuses servers already listening on ports 3101
and 5273.

## Benchmark

`packages/sim-core/bench/tick-benchmark.ts` measures the **engine only**: world
generation time, mean milliseconds per tick with and without invariant checks (168
measured ticks after 24 warm-up ticks, seed `benchmark`), serialised state size and
serialisation time. It is not part of `pnpm test` or CI.

```sh
pnpm --filter @civ/sim-core benchmark 100 1000      # default sizes: 100 1000 5000
```

Results measured for this document on 2026-10-15 (two consecutive runs of
`pnpm benchmark 100 1000`, engine as of commit `88d349b`, no other test processes
running):

- Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores (as reported by
  `os.cpus()`), 15 GiB RAM, Linux; a shared virtual machine.

| Population | Run | Genesis (ms) | ms/tick, invariants on | ms/tick, invariants off | State (KiB) | Serialize (ms) |
| ---------- | --- | ------------ | ---------------------- | ----------------------- | ----------- | -------------- |
| 100        | 1   | 8.6          | 0.220                  | 0.089                   | 56          | 1.3            |
| 100        | 2   | 8.4          | 0.296                  | 0.126                   | 56          | 2.0            |
| 1,000      | 1   | 7.0          | 0.871                  | 0.579                   | 547         | 6.0            |
| 1,000      | 2   | 10.7         | 0.934                  | 0.586                   | 547         | 6.0            |

How to read this:

- Run-to-run spread on a shared machine is large (two earlier runs the same day, while
  the browser tests were running, measured 0.35–0.38 ms/tick at 100 and 1.15–1.17
  ms/tick at 1,000 citizens with invariants on); compare runs on an idle machine before
  drawing conclusions.
- Invariant checks are a large share of the per-tick cost at these sizes. They stay on
  by default because experiments must not continue from impossible states.
- **This is engine-only.** It excludes checkpoints (serialisation, gzip, database
  transactions), projections, HTTP and the WebSocket stream. As one end-to-end
  observation, stepping 240 ticks through `POST …/control` (including the final
  checkpoint) took 0.07–0.13 s for 100 citizens and 0.36–0.47 s for 1,000 citizens
  (three requests each) with the production build against a local PostgreSQL on the
  same machine — a handful of samples, not a benchmark. For the cost of checkpoints at
  the maximum population of 5,000, see
  [ARCHITECTURE.md](ARCHITECTURE.md#61-runners-and-the-tick-loop).
