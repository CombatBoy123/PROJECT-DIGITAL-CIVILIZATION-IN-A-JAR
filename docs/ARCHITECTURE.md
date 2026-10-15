# Architecture

This document is the architecture proposal for Digital Civilization in a Jar and
the reference for how the system is put together. It is updated as phases land;
anything marked _(planned)_ does not exist in the code yet.

## 1. Repository inspection (starting point)

The repository contained a placeholder `README.md` and nothing else, so the
project was initialised from scratch. No existing code had to be preserved.

## 2. Goals that drive the design

| Requirement                                      | Design consequence                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Reproducible experiments                         | A pure, deterministic engine with keyed (counter-based) random streams, integer money, no wall-clock or `Math.random`.    |
| Simulation logic independent of UI               | The engine is a separate package (`@civ/sim-core`) with no I/O and no knowledge of HTTP, the database or rendering.       |
| Persistence without silent state loss            | Atomic checkpoints (state blob + events + metrics + projections) in a single database transaction.                        |
| Auditable history                                | An append-only, sequenced event log; current state is a snapshot, never "reconstructed" from an incomplete log.           |
| Scale from 100 to 1,000+ citizens                | In-memory engine with array/Map state, batched writes, diffed projections, throttled delta frames to the browser.         |
| Long-running processing outside request handlers | One `SimulationRunner` per loaded civilization, ticking in a time-sliced background loop; handlers only enqueue commands. |
| Safe destructive controls                        | Server-side confirmation for reset/restore/delete, token auth with viewer/operator roles outside loopback development.    |

## 3. System overview

```
┌──────────────────────────── browser ────────────────────────────┐
│  apps/web  (React + Vite)                                       │
│   ├─ PixiJS world renderer  (consumes frames, decides nothing)  │
│   ├─ Inspectors / lists     (REST, paginated)                   │
│   └─ Charts (Recharts)      (REST, downsampled metric series)   │
└───────────────▲──────────────────────────────▲──────────────────┘
                │ REST (JSON, Zod-validated)   │ WebSocket (status, delta frames, live events)
┌───────────────┴──────────────────────────────┴──────────────────┐
│  apps/server  (Fastify)                                         │
│   ├─ routes/        validation, auth, consistent errors         │
│   ├─ runner/        RunnerManager → SimulationRunner per civ    │
│   │                  time-sliced tick loop, command queue       │
│   ├─ persistence/   CivilizationStore (transactions),           │
│   │                  projections, history queries               │
│   └─ ws/            stream hub with backpressure                │
│                      │ calls                                    │
│   ┌──────────────────▼─────────────────────────┐                │
│   │ packages/sim-core  (pure TypeScript)       │                │
│   │  rng · clock · worldgen · systems · events │                │
│   │  invariants · metrics · serialization/hash │                │
│   └────────────────────────────────────────────┘                │
└───────────────┬─────────────────────────────────────────────────┘
                │ Prisma
┌───────────────▼─────────────────────────────────────────────────┐
│ PostgreSQL: civilizations, configs, checkpoints, snapshots,     │
│ projections (citizens, buildings, skills), events, metrics,     │
│ audit log                                                       │
└─────────────────────────────────────────────────────────────────┘
```

`packages/shared` holds the HTTP/WebSocket contract (Zod schemas and DTO
types) used by both the server and the web client.

## 4. Directory structure

```
.
├── apps/
│   ├── server/                 Fastify API, simulation runners, persistence
│   │   ├── prisma/             schema.prisma + SQL migrations
│   │   ├── src/
│   │   │   ├── config/         environment parsing (Zod)
│   │   │   ├── db/             Prisma client, raw SQL helpers
│   │   │   ├── auth/           token auth, roles
│   │   │   ├── runner/         SimulationRunner, RunnerManager, world replacement (rewinds)
│   │   │   ├── persistence/    CivilizationStore (all transactional writes), state codec,
│   │   │   │                   projection diffing, world and history queries
│   │   │   ├── routes/         REST endpoints
│   │   │   ├── ws/             WebSocket stream hub
│   │   │   └── http/           error types, client-safe failure reports
│   │   └── test/               integration tests (real PostgreSQL)
│   └── web/                    React + Vite + PixiJS observatory
│       ├── src/
│       │   ├── api/            REST/WS clients
│       │   ├── world/          PixiJS renderer (pure consumer of frames)
│       │   ├── components/     panels, inspectors, controls
│       │   └── pages/
│       └── e2e/                Playwright browser tests
├── packages/
│   ├── sim-core/               deterministic engine (no I/O)
│   │   ├── src/
│   │   │   ├── rng/            keyed sfc32 streams, hashing
│   │   │   ├── time/           simulation clock / calendar
│   │   │   ├── state/          Zod state schema, canonical serialization
│   │   │   ├── world/          procedural world generation
│   │   │   ├── systems/        per-tick systems (one file per pipeline stage)
│   │   │   ├── events/         event catalogue (discriminated union)
│   │   │   ├── metrics/        metric registry and calculations
│   │   │   ├── invariants/     impossible-state detection
│   │   │   └── engine/         Simulation class, tick pipeline
│   │   └── test/
│   └── shared/                 API contract: Zod request/response schemas
├── docs/                       architecture, rules, model, API, ops docs
├── scripts/                    reproduce-demo.ts, Docker entry point, PostgreSQL init
├── .github/workflows/          CI
├── Dockerfile                  single-container image (server + built web app)
└── docker-compose.yml          PostgreSQL for development; optional `app` profile
```

## 5. Simulation engine

### 5.1 State and time

The whole simulation is one serialisable `WorldState` value (validated by a Zod
schema). Entities are stored in arrays sorted by integer id; lookup indexes
(`Map<id, entity>`) are derived and never serialised. All money is integer
minor units ("cents"); all iteration is in ascending id order, so results never
depend on database or rendering order.

One tick is one simulated hour. A day is 24 ticks; the calendar
(`daysPerSeason × 4 seasons = 1 year`) is configurable. Simulation time is a
tick counter and is unrelated to wall-clock time: the runner decides how many
ticks per real second to execute.

### 5.2 Tick pipeline

Every call to `Simulation.step()` advances `state.tick` by one and runs the
pipeline below in this fixed order. Events emitted during a step carry the new
tick number.

| #   | Stage                                     | Phase 1 content                               | Later phases                             |
| --- | ----------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| 1   | Environment & scheduled events            | clock, seasons, weather (optional stochastic) | scheduled shocks, disasters (P4)         |
| 2   | Citizen needs & circumstances             | ageing / life stages, energy                  | hunger, health, happiness, security (P3) |
| 3   | Production & business operations          | —                                             | recipes, inventory (P2)                  |
| 4   | Employment, wages, consumption            | —                                             | hiring, payroll (P2)                     |
| 5   | Markets & prices                          | —                                             | order matching, price formation (P2)     |
| 6   | Taxes, benefits, policies                 | —                                             | government (P4)                          |
| 7   | Relationships, goals, decisions, movement | rule-based daily routine and travel           | utility-based decisions (P3)             |
| 8   | Records & metrics                         | invariant checks, metric sample               | richer metrics, decision records         |

Implications of the order are documented in
[SIMULATION_RULES.md](SIMULATION_RULES.md#update-order) (for example, needs
are updated from the activity chosen in the previous tick, so an activity
change takes effect on energy one tick later).

### 5.3 Determinism

- **Keyed random streams.** Randomness never comes from a shared global
  generator. Each random decision creates a small sfc32 generator seeded from
  `hash(seed, stream, tick, entityId, …)`. A draw for citizen 17 at tick 300 is
  therefore independent of how many draws happened for other citizens or
  systems, which keeps paired experiments aligned for as long as their paths
  allow. (It still cannot guarantee matched events once scenarios diverge — a
  citizen who is at work in one run and at home in the other consumes different
  draws.)
- **Deterministic vs. stochastic rules.** Optional stochastic processes
  (currently weather) are isolated in their own systems and can be disabled via
  configuration; with them disabled the run is a pure function of initial
  state.
- **No hidden inputs.** ESLint forbids `Math.random`, `Date.now` and
  `new Date()` inside `sim-core`. Transcendental math (`Math.exp`, `Math.log`,
  `Math.sin`, …) is avoided because it is not guaranteed bit-identical across
  JavaScript engines; distributions use sums/products of uniforms instead.
- **State hash.** `Simulation.hash()` hashes the canonical (sorted-key) JSON
  serialisation. Tests assert equal hashes for equal inputs.

### 5.4 Events

Events are a discriminated union (`type` + typed `payload`) with a per-civilization
monotonically increasing `seq`, the simulation `tick`, `refs` to involved
entities (with roles), and an optional `causeSeq` linking an effect to its
cause. The engine returns the events of each step; it does not store them.
High-frequency, low-information changes (a citizen walking to the plaza) are
not events: they are visible in the live frame stream and in state.

### 5.5 Invariants

`checkInvariants(state)` returns a list of violations; the runner halts a
civilization (status `HALTED`, reason stored) instead of continuing from an
impossible state. See §8 for the list.

## 6. Server

### 6.1 Runners and the tick loop

`RunnerManager` lazily loads a civilization (from its latest checkpoint) into a
`SimulationRunner`, with single-flight loading. A paused runner that nobody streams and
nobody has used for 15 minutes (`DEFAULT_IDLE_EVICT_MS`) is unloaded again, but only
when it is fully durable (no uncommitted ticks or halt, and the stored status equals
the in-memory one); this is why civilization summaries carry `loaded`. A runner:

- runs ticks in **time slices**: after each tick it checks whether the slice budget
  (`SLICE_BUDGET_MS`, 12 ms) is used up and, if so, yields to the event loop, so HTTP
  handlers never execute ticks themselves and stay responsive at the populations of the
  demos (100–1,000 citizens). Because the check runs after a tick, a slice can overrun
  by one tick: at the maximum population of 5,000 a single tick can take 15–40 ms;
- paces itself to the requested speed (ticks per real second, or "max");
- serialises all control operations (start, pause, step, speed, snapshot, restore,
  reset) through a per-runner async queue (`runner/serial-queue.ts`) so they cannot
  interleave;
- buffers events and metric samples in memory and writes them with its state in
  `SimulationRunner.checkpoint()`, which calls `CivilizationStore.writeCheckpoint`
  (`persistence/store.ts`). The projection diff (`persistence/projections.ts`) compares
  the rows it last wrote with the current state per entity id. Measured at 5,000
  citizens on a shared machine, the diff takes about 5–25 ms and `captureState`
  (canonical serialisation plus hash) about 40–120 ms, so **a checkpoint at the maximum
  population blocks the event loop for roughly 50–150 ms** every
  `CHECKPOINT_INTERVAL_MS`. At 100–1,000 citizens it is a few milliseconds.

### 6.2 Atomic checkpoints

A checkpoint captures, at one tick and inside **one database transaction**:

1. buffered events (+ their entity references) and metric samples,
2. the gzip-compressed canonical state blob and its hash,
3. changed rows of the normalised projections (citizens, skills, buildings),
4. `civilization.current_tick` and `status`, plus the audit entry of the control
   action (pause, step) that triggered the checkpoint, if any.

Checkpoints run every `CHECKPOINT_INTERVAL_MS` while running and immediately on
pause, step, snapshot and shutdown; a rewind (restore, reset) writes its own
checkpoint in its transaction. Only one flush is in flight; if buffers
exceed their bounds the loop waits for the flush (**backpressure**) instead of
growing memory.

**Control actions are atomic with their audit entry.** start, pause, speed changes and
steps write the state change (a checkpoint, or a status-only update when nothing is
uncommitted) and the audit entry in one transaction, and change the in-memory runner
only after that commit. If the write fails the action returns `500` and nothing
changes. Pausing therefore always makes `PAUSED` durable, even when no tick is
uncommitted.

Because events are only committed together with the state that
produced them, a crash can lose at most the uncommitted ticks since the last
checkpoint and can never leave events without their state (or vice versa).
Recovery loads the checkpoint; because the engine is deterministic, the lost
ticks are re-simulated identically when the civilization is resumed.

### 6.3 Read paths

- **Current state** (citizen lists, inspectors, buildings): served from the
  projection tables, labelled with the tick they represent (`asOfTick`). They
  are at most one checkpoint interval behind a running simulation and exact
  when it is paused.
- **History** (events, metrics, snapshots, audit): append-only tables. Events and
  the audit log are keyset-paginated, metric series are range-limited and
  downsampled to a bounded number of points, and the snapshot list is bounded.
- **Live view**: the WebSocket stream sends a keyframe on connect, then delta
  frames (only citizens whose position/activity changed) at most `FRAME_RATE`
  times per second, independent of the simulation speed. Slow clients skip
  deltas and receive a fresh keyframe once their socket drains; a client whose
  buffer stays congested for 10 s is disconnected. Live connections are capped in
  total and per client address (`STREAM_MAX_CONNECTIONS`,
  `STREAM_MAX_CONNECTIONS_PER_ADDRESS`).

### 6.4 Security

Source: `apps/server/src/auth/auth.ts`.

- **Two modes.** `AUTH_MODE=disabled` is accepted only when the server binds to a
  loopback address (trusted local development). Otherwise `AUTH_MODE=token` is
  required: `OPERATOR_TOKEN` authorises mutations; an optional `VIEWER_TOKEN` gates
  reads. Tokens are compared in constant time.
- **Authorisation follows the matched route, not the URL text.** Every route in
  `API_ROUTES` (`packages/shared/src/routes.ts`) has an `auth` level (`public`, `read`,
  `operate`). The `onRequest` hook looks up the route pattern Fastify actually matched
  (`request.routeOptions.url`; `HEAD` uses the `GET` entry), so percent-encoded paths
  (`/%61pi/…`) and absolute-form request targets get exactly the checks of the
  canonical path. A matched route under `/api` that is missing from `API_ROUTES`
  requires the operator (fail closed); unmatched requests only reach the 404 handler.
- **Tokens travel in `Authorization: Bearer`.** `?token=` is read only on WebSocket
  upgrade `GET`s of `/api/civilizations/:id/stream` (browsers cannot set headers
  there) and is redacted from logs; on every other request a query token is ignored.
- **Disabled mode accepts only local requests (DNS rebinding).** Binding to loopback
  keeps other machines out, but a web page in the developer's browser could rebind its
  own host name to `127.0.0.1` and send same-origin requests. So in disabled mode every
  request — reads, mutations, CORS preflights and WebSocket upgrades — must carry a
  `Host` header naming a loopback host (`localhost`, `*.localhost`, `127.0.0.0/8` or
  `[::1]`, any port, strict syntax), and a present `Origin` must be a loopback
  `http(s)` origin or listed in `CORS_ORIGINS` (the opaque origin `null` is rejected);
  otherwise `403 FORBIDDEN`. The remaining trust assumption: any process on the same
  machine can operate a server in disabled mode.
- **Destructive actions** (reset, restore, delete) additionally require the
  civilization's exact name in the request body (`confirm`), checked on the
  server.
- **Validation.** All input is validated with Zod (strict schemas; integer query
  parameters accept only decimal digits). Search terms are matched literally (`%`, `_`
  and `\` are escaped before `ILIKE`). State blobs read from the database are
  re-validated and hash-checked before use. Event payloads are data only — no
  code paths evaluate user-supplied content.
- **Client-safe errors.** Persistence failures are logged in full with a random
  reference; clients (`lastError`, stream status, `500` bodies) only see
  `<what> (<kind>; ref <8 hex>)`, never driver messages or server paths
  (`apps/server/src/http/failure.ts`).
- **Resource limits.** Request bodies ≤ 256 KiB, steps per request ≤ 1,000, list
  pages bounded, live stream connections capped in total and per address.

## 7. Data model (Phase 1)

| Table               | Purpose                                                            | Key / indexes                                                          |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `civilization`      | experiment run: name, seed, status, speed, current tick, timeline  | PK `id` (uuid); unique `name`                                          |
| `simulation_config` | validated config parameters + schema version (1:1)                 | PK `civilization_id`                                                   |
| `world_checkpoint`  | latest durable state blob (gzip), hash, tick                       | PK `civilization_id`                                                   |
| `snapshot`          | named immutable state blobs                                        | PK `id`; unique (`civilization_id`, `name`)                            |
| `building`          | projection of buildings (kind, footprint, capacity)                | PK (`civilization_id`, `id`)                                           |
| `household`         | projection of households (home building)                           | PK (`civilization_id`, `id`); home                                     |
| `citizen`           | projection of citizens (identity, traits, money, energy, activity) | PK (`civilization_id`, `id`); name, activity, wealth                   |
| `citizen_skill`     | normalised skill levels                                            | PK (`civilization_id`, `citizen_id`, `skill`)                          |
| `simulation_event`  | append-only event log                                              | PK (`civilization_id`, `seq`); (`civ`, `tick`), (`civ`, `type`, `seq`) |
| `event_entity`      | entity ↔ event index for "events involving X"                      | PK (`civ`, `seq`, kind, id, role); (`civ`, kind, id, `seq`)            |
| `metric_sample`     | metric values per sampled tick                                     | PK (`civilization_id`, `tick`)                                         |
| `audit_log`         | control actions (who did what, when)                               | PK `id`; (`civilization_id`, `created_at`)                             |

Planned for later phases _(planned)_: `business`, `employment`, `resource`,
`inventory_item`, `transaction`, `relationship`, `memory`, `decision_record`,
`policy`, `disaster`, `experiment` (groups of runs), `comparison`. They will be
added by migrations when the corresponding mechanics exist, so no table in the
database pretends to hold data the simulation does not produce.

Full column-level documentation lives in [DATABASE.md](DATABASE.md).

## 8. Simulation invariants

Checked by `checkInvariants` (after genesis, after every tick and on every restore by
default; `INVARIANT_CHECKS=off` disables them for benchmarks) and by tests:

1. **Clock** — `tick` is a non-negative integer and advances by exactly one per step
   (by construction in `step()`); no activity starts in the future.
2. **Identity** — entity ids are unique positive integers, below the next-id counters.
3. **Money is non-negative** — no balance is negative while credit is disabled.
4. **Money conservation** — Σ balances = Σ issued − Σ destroyed (ledger totals).
5. **Housing** — each citizen's home exists and is residential; occupants ≤ capacity.
6. **Location** — a citizen is either at an existing building (no travel) or
   travelling (no location) with `departTick ≤ tick < arriveTick`, on a home ↔ venue
   trip whose duration equals the travel time of its route.
7. **Bounded needs** — needs are finite and within [0, 100].
8. **Life stage** — stored life stage matches the stage implied by age.
9. **Events** — event `seq` strictly increases; events carry the tick they were emitted in.
10. **Snapshots** — a restored snapshot's canonical hash equals the stored hash
    (enforced by `deserializeState`, which also validates the schema).
11. **Map** — the map is exactly a grid of blocks separated by roads; every building
    lies inside its block without overlapping another, and every door is on a road.
12. **Venue capacity** — present plus incoming visitors never exceed a venue's capacity.
13. **Environment** — the temperature follows the daily mean and the hourly profile;
    the daily mean stays within its bounded deviation from the seasonal baseline (and
    equals it, with clear weather, when stochastic weather is off).

Items 1–9 and 11–13 are the twelve codes reported by `checkInvariants` /
`checkEventSequence` (`CLOCK`, `IDENTITY`, `NEGATIVE_BALANCE`, `MONEY_CONSERVATION`,
`HOUSING`, `LOCATION`, `NEEDS_BOUNDS`, `LIFE_STAGE`, `EVENT_SEQUENCE`, `MAP`,
`VENUE_CAPACITY`, `ENVIRONMENT`); item 10 is enforced by `deserializeState`. See
[SIMULATION_RULES.md](SIMULATION_RULES.md#invariants) for the exact conditions.
With `INVARIANT_CHECKS=off` (benchmarks only) the twelve coded checks are skipped after
each step but still run at genesis and on every restore, as do the schema and hash checks
of item 10.

Planned with Phase 2+: inventories never negative, sales ≤ owned inventory,
production consumes recipe inputs, every transfer has matching debit and credit.

## 9. Phased implementation plan

| Phase | Scope                                                                                                                                                                                                                                        | Status      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1     | Monorepo, schema + migrations, clock, seeded RNG, world generation, persistent citizens, repeatable ticks, checkpoints/snapshots, observatory with metrics dashboard and definitions, config/metrics/events exports, Docker image, CI, tests | in progress |
| 2     | Resources, recipes, businesses, employment, wages, inventory, transactions, order matching and price formation; accounting invariants                                                                                                        | planned     |
| 3     | Needs (hunger, health, happiness, security), utility-based decisions with recorded alternatives, consumption, goals, relationships, memories                                                                                                 | planned     |
| 4     | Policy engine (taxes, minimum wage, UBI, rent control, benefits, trade, subsidies, public services), disasters and shocks, laboratory UI                                                                                                     | planned     |
| 5     | Full observatory: overlays, filters, inspectors for every new entity type, timeline linking metrics to events                                                                                                                                | planned     |
| 6     | Experiments: duplication/branching, comparison of runs, repeated runs with different seeds, richer exports                                                                                                                                   | planned     |
| 7     | Hardening: benchmarks at 1,000+ citizens including persistence, worker-thread runners if needed, deployment polish, retention, documentation pass                                                                                            | planned     |

Each phase ends with a runnable application, passing tests and updated docs.
See [ROADMAP.md](ROADMAP.md) for the detailed checklist.

## 10. Phase 1 acceptance criteria

1. `pnpm install`, `pnpm db:migrate`, `pnpm dev` start the server and web app against a local PostgreSQL.
2. A civilization can be created from the UI or API with a name, seed and population; the world
   (map, buildings, households, citizens) is generated deterministically from the seed.
3. Citizens are persisted (projection tables + state blob) and survive a server restart.
4. The simulation can be started, paused, single-stepped, sped up and reset (reset requires confirmation).
5. The same seed and configuration produce the same state hash after N ticks (automated test).
6. Saving a snapshot and restoring it reproduces the snapshot's state hash exactly, and resuming
   from it reproduces the original continuation (automated test).
7. Events (genesis, weather, seasons, life stages) and metrics are persisted with pagination and
   visible in the UI; every metric has a written definition.
8. Invariant violations halt the civilization and are reported; tests prove violations are detected.
9. Lint, type-check, unit, integration and browser tests pass locally and in CI.
10. No UI control exists for functionality that is not implemented.
