# Roadmap

The project is built in phases; each ends with a runnable application, passing tests
and updated documentation. The design behind the phases is in
[ARCHITECTURE.md](ARCHITECTURE.md#9-phased-implementation-plan).

Legend: **[x]** done and verified · **[~]** in progress or not yet verified ·
**[ ]** not started.

Status as of 2026-10-15. "Verified" means a command or test was run for this document
on that date, on the working tree that includes the engine fixes of commit `88d349b`
and the server and web fixes made after it (see [TESTING.md](TESTING.md#results));
items whose implementation exists but could not be verified are marked in progress.

## Phase 1 — Foundation (in progress)

### Checklist

- [x] pnpm monorepo: `sim-core`, `shared`, `server`, `web`; strict TypeScript, ESLint
      (with determinism rules for the engine), Prettier — `pnpm typecheck`, `pnpm lint`
      and `pnpm format:check` pass
- [x] Database schema and migrations (4 migrations, integrity `CHECK` constraints)
- [x] Simulation clock and calendar
- [x] Keyed, seeded random streams; canonical serialisation and state hash
- [x] Procedural world generation: zoning, venues, houses with unique names,
      households, citizens, endowments
- [x] Phase 1 rules: seasons, weather, temperature, ageing and life stages, energy,
      daily routine with outings that fit the day and the energy budget, travel
      ([SIMULATION_RULES.md](SIMULATION_RULES.md))
- [x] Event catalogue, 17 metrics with definitions, twelve invariant classes checked
      at genesis, every tick and on restore
- [x] Server: runners with time-sliced tick loop, atomic checkpoints and control
      actions, projections, snapshots and restore, reset, delete, audit log, exports
      that abort on a rewind, token auth per matched route, DNS-rebinding protection in
      disabled mode, stream connection limits, crash recovery and recovery from
      unloadable stored state — 75/75 integration tests passed
- [x] REST API and WebSocket stream ([API.md](API.md)) — every example in API.md
      regenerated from the production build
- [x] Web observatory: civilization list and creation, PixiJS map, playback controls,
      inspectors, event feed, snapshots, lab (reset, exports), audit, metrics
      dashboard, role-aware controls under token auth — 120/120 web unit tests and
      18/18 browser tests passed; `pnpm build` passes
- [~] Docker image and Compose app profile — `docker compose --profile app config`
  validates; the image could not be built in the documentation environment (no
  Docker daemon); CI builds and smoke-tests the image
- [~] CI workflow (`.github/workflows/ci.yml`) — valid YAML; every command it runs
  except the image job passed locally; not yet run on GitHub
- [x] Documentation set (this folder and the README)

### Acceptance criteria

| #   | Criterion                                                                                                                                 | Status | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install`, `pnpm db:migrate`, `pnpm dev` start the server and web app against a local PostgreSQL                                     | [x]    | dependencies of this checkout installed with `pnpm install`; `pnpm db:migrate` and `pnpm dev` run with the `.env.example` values: `/api/health` up, UI served on port 5173, `/api` and the WebSocket stream proxied, the README `curl` created a civilization                                                                                 |
| 2   | A civilization can be created from the UI or API with a name, seed and population; the world is generated deterministically from the seed | [x]    | API: verified, same hashes as the engine ([EXPERIMENTS.md](EXPERIMENTS.md#2-the-same-run-through-the-api)); UI: `civilizations.spec.ts` passed; determinism: `determinism.test.ts`, `worldgen.test.ts`                                                                                                                                        |
| 3   | Citizens are persisted (projection tables + state blob) and survive a server restart                                                      | [x]    | `lifecycle.test.ts` "a new server on the same database continues identically"                                                                                                                                                                                                                                                                 |
| 4   | The simulation can be started, paused, single-stepped, sped up and reset (reset requires confirmation)                                    | [x]    | API: `lifecycle.test.ts`, `runner.test.ts`; UI: `observatory.spec.ts` (step one day, play then pause, speed change in the audit tab, reset requires the exact name) passed                                                                                                                                                                    |
| 5   | The same seed and configuration produce the same state hash after N ticks (automated test)                                                | [x]    | `determinism.test.ts`; `lifecycle.test.ts` "step N via the API equals the pure engine after N ticks"                                                                                                                                                                                                                                          |
| 6   | Saving and restoring a snapshot reproduces its hash exactly, and resuming reproduces the original continuation (automated test)           | [x]    | `determinism.test.ts` "a restored snapshot continues exactly like the original run"; `snapshots-halt.test.ts`; `observatory.spec.ts` snapshot and restore                                                                                                                                                                                     |
| 7   | Events and metrics are persisted with pagination and visible in the UI; every metric has a written definition                             | [x]    | `reads.test.ts` (pagination, downsampling); `observatory.spec.ts` (events recorded after a step); `dashboard.spec.ts` (every metric charted with its definition); [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#definitions)                                                                                                                          |
| 8   | Invariant violations halt the civilization and are reported; tests prove violations are detected                                          | [~]    | halts: `invariants.test.ts`, `snapshots-halt.test.ts` (server halt with recorded reason); detection tests exist for 11 of the 12 invariant codes — **`CLOCK` has no detection test** ([TESTING.md](TESTING.md#engine-packagessim-coretest-92-tests))                                                                                          |
| 9   | Lint, type-check, unit, integration and browser tests pass locally and in CI                                                              | [~]    | locally: format check, lint, type-check, 92 + 120 + 75 unit and integration tests and 18 browser tests passed; CI not yet run on GitHub                                                                                                                                                                                                       |
| 10  | No UI control exists for functionality that is not implemented                                                                            | [x]    | audited for this document: every `<button>` and click handler in `apps/web/src` triggers an implemented action (playback, speed, step, snapshots, restore, reset, exports, delete, create, token, map zoom/fit, tabs, pagination, dashboard ranges); no placeholder or "coming soon" control; operator-only controls are disabled for viewers |

### Known issues

- **No `CLOCK` detection test** (criterion 8): add an `invariants.test.ts` case for a
  negative tick and for an `activitySince` in the future.
- **Engine results changed without a new `ENGINE_VERSION`**: commit `88d349b` changed
  the routine and house names but kept `0.1.0`, so `engineVersion` does not distinguish
  runs made before and after it ([EXPERIMENTS.md](EXPERIMENTS.md)).
- **`INVARIANT_CHECKS=off` skips every check**, including at genesis and on restore
  (documented in [SIMULATION_RULES.md](SIMULATION_RULES.md#invariants)); it is meant
  for benchmarks only.
- **Token strength is not checked**: the server accepts any `OPERATOR_TOKEN` of 24 or
  more characters; generate it with `openssl rand -hex 32`.
- **Viewers see operator controls enabled until the first refusal**: the API has no
  endpoint that reports a token's role, so the web UI learns it from the first `403`.
- **Checkpoints at 5,000 citizens block the event loop for roughly 50–150 ms**, and a
  single tick can exceed the 12 ms slice budget at that size
  ([ARCHITECTURE.md](ARCHITECTURE.md#61-runners-and-the-tick-loop)).

Resolved during Phase 1 integration: the slow `rng.test.ts` uniformity test (now
asserts bounds once per run), `ws` and the Prisma CLI moved to production
dependencies (the image installs with `--prod`), `initialWealth.medianCents` renamed
`initialWealth.meanCents` because it is the mean, not the median, of the adult
endowment ([ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#initial-endowments)), citizens out at
night in large or slow worlds, duplicate house names, and the review findings on
authorisation, DNS rebinding, durable pauses, atomic control actions, export
consistency, unloadable state and client-safe errors.

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

- [ ] Map overlays and filters, inspectors for the entity types of Phases 2–4
- [ ] An API endpoint that reports the role of the presented token, so the UI can
      disable operator-only controls for viewers before the first refusal
- [ ] Dashboard timeline linking metric changes to events

## Phase 6 — Experiments (planned)

- [ ] Duplicating and branching civilizations
- [ ] Comparing runs; repeated runs over several seeds
- [ ] Richer exports

## Phase 7 — Hardening (planned)

- [ ] Benchmarks at 1,000+ citizens including persistence; worker-thread runners (or
      a cheaper checkpoint) for 5,000-citizen worlds
- [ ] Deployment polish (the image already installs production dependencies only)
- [ ] Retention options for long runs
- [ ] Documentation pass
