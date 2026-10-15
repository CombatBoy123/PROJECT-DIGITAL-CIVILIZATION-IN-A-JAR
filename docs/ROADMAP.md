# Roadmap

The project is built in phases; each ends with a runnable application, passing tests
and updated documentation. The design behind the phases is in
[ARCHITECTURE.md](ARCHITECTURE.md#9-phased-implementation-plan).

Legend: **[x]** done and verified · **[~]** in progress or not yet verified ·
**[ ]** not started.

Status as of 2026-10-15. "Verified" means a command or test was run for this document
(see [TESTING.md](TESTING.md)); items whose implementation exists but could not be
verified yet are marked in progress.

## Phase 1 — Foundation (in progress)

### Checklist

- [x] pnpm monorepo: `sim-core`, `shared`, `server`, `web`; strict TypeScript, ESLint
      (with determinism rules for the engine), Prettier
- [x] Database schema and migrations (3 migrations, integrity `CHECK` constraints)
- [x] Simulation clock and calendar
- [x] Keyed, seeded random streams; canonical serialisation and state hash
- [x] Procedural world generation: zoning, venues, houses, households, citizens,
      endowments
- [x] Phase 1 rules: seasons, weather, temperature, ageing and life stages, energy,
      daily routine and travel ([SIMULATION_RULES.md](SIMULATION_RULES.md))
- [x] Event catalogue, 17 metrics with definitions, invariant checks every tick
- [x] Server: runners with time-sliced tick loop, atomic checkpoints, projections,
      snapshots and restore, reset, delete, audit log, exports, token auth, crash
      recovery — 56/56 integration tests passed
- [x] REST API and WebSocket stream ([API.md](API.md)) — exercised by hand against the
      production build for this documentation
- [~] Web observatory: civilization list and creation, PixiJS map, playback controls,
  inspectors, event feed, snapshots, lab (reset, exports), audit, metrics dashboard —
  95/95 web unit tests passed; browser tests not run for this document; the web
  build's type-check was failing at the time of writing (in an e2e spec)
- [~] Docker image and Compose app profile — Dockerfile passes `docker build --check`;
  the Compose database service, migrations and the production server layout were
  verified, but a full image build could not run in the documentation environment
  (no network access from containers); CI builds and smoke-tests the image
- [~] CI workflow (`.github/workflows/ci.yml`) — passes `actionlint`; not yet run on
  GitHub
- [x] Documentation set (this folder and the README)

### Acceptance criteria

| #   | Criterion                                                                                                                                 | Status | Evidence                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install`, `pnpm db:migrate`, `pnpm dev` start the server and web app against a local PostgreSQL                                     | [~]    | migrations verified on fresh databases; production server verified; `pnpm dev` not run for this document                                                            |
| 2   | A civilization can be created from the UI or API with a name, seed and population; the world is generated deterministically from the seed | [~]    | API: verified (and the same hashes as the engine); UI: covered by the e2e spec `civilizations.spec.ts`, not run for this document                                   |
| 3   | Citizens are persisted (projection tables + state blob) and survive a server restart                                                      | [x]    | `lifecycle.test.ts` "a new server on the same database continues identically"                                                                                       |
| 4   | The simulation can be started, paused, single-stepped, sped up and reset (reset requires confirmation)                                    | [~]    | API: verified and tested (`lifecycle.test.ts`); UI controls covered by `observatory.spec.ts`, not run for this document                                             |
| 5   | The same seed and configuration produce the same state hash after N ticks (automated test)                                                | [x]    | `determinism.test.ts`; `lifecycle.test.ts` "step N via the API equals the pure engine after N ticks"                                                                |
| 6   | Saving and restoring a snapshot reproduces its hash exactly, and resuming reproduces the original continuation (automated test)           | [x]    | `determinism.test.ts` "a restored snapshot continues exactly like the original run"; `snapshots-halt.test.ts`                                                       |
| 7   | Events and metrics are persisted with pagination and visible in the UI; every metric has a written definition                             | [~]    | persistence, pagination and definitions verified ([ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#definitions)); UI visibility covered by e2e specs not run for this document |
| 8   | Invariant violations halt the civilization and are reported; tests prove violations are detected                                          | [x]    | `invariants.test.ts` (each violation class), `snapshots-halt.test.ts` (server halt with recorded reason)                                                            |
| 9   | Lint, type-check, unit, integration and browser tests pass locally and in CI                                                              | [~]    | unit and integration suites passed; web type-check failing at the time of writing; e2e not run; CI not yet run                                                      |
| 10  | No UI control exists for functionality that is not implemented                                                                            | [~]    | not audited for this document                                                                                                                                       |

### Known issues

None open. Resolved during Phase 1 integration: the flaky `rng.test.ts` uniformity test
(now asserts bounds once per run), `ws` and the Prisma CLI moved to production
dependencies (the image installs with `--prod`), and `initialWealth.medianCents` was
renamed `initialWealth.meanCents` because it is the mean, not the median, of the adult
endowment ([ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#initial-endowments)).

## Phase 2 — Production and markets (planned)

- [ ] Resources and inventories (integer quantities); invariant: no negative inventory
- [ ] Recipes and production using skills; invariant: production consumes recipe inputs
- [ ] Businesses on commercial and farmland blocks, with accounts
- [ ] Employment, hiring and wages; work time in the daily routine
- [ ] Buy/sell orders, order matching and price formation; invariant: sales ≤ owned inventory
- [ ] Transactions with matching debit and credit; flow metrics (income, spending,
      production, trade volume)
- [ ] Projections and history tables for the new entities (`business`, `employment`,
      `resource`, `inventory_item`, `transaction`)

## Phase 3 — People (planned)

- [ ] Needs: hunger, health, happiness, security
- [ ] Utility-based decisions that record the alternatives considered (replacing the
      Phase 1 routine)
- [ ] Consumption, goals, relationships and memories
- [ ] Births, deaths and migration

## Phase 4 — Policy and shocks (planned)

- [ ] Policy engine: taxes, minimum wage, UBI, rent control, benefits, trade rules,
      subsidies, public services; government account
- [ ] Scheduled shocks and disasters
- [ ] Laboratory UI for interventions
- [ ] Economic-shock walkthrough in [EXPERIMENTS.md](EXPERIMENTS.md)

## Phase 5 — Full observatory (planned)

- [ ] Map overlays and filters, inspectors for every entity type
- [ ] Dashboard timeline linking metric changes to events

## Phase 6 — Experiments (planned)

- [ ] Duplicating and branching civilizations
- [ ] Comparing runs; repeated runs over several seeds
- [ ] Richer exports

## Phase 7 — Hardening (planned)

- [ ] Benchmarks at 1,000+ citizens including persistence; worker-thread runners if needed
- [ ] Slimmer production image (`--prod` deploy) and deployment polish
- [ ] Retention options for long runs
- [ ] Documentation pass
