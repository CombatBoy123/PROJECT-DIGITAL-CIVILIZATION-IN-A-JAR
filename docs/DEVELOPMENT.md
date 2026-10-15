# Development

How to set up the repository, what the scripts do, how the workspace is organised, the
conventions the code follows, and step-by-step recipes for extending the simulation.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md),
[DEPLOYMENT.md](DEPLOYMENT.md), [SIMULATION_RULES.md](SIMULATION_RULES.md).

## Prerequisites

- **Node.js ≥ 22.12** (`.nvmrc` pins major version 22; `engines` requires ≥ 22.12.0).
- **pnpm 10** — the exact version is pinned by `packageManager` in `package.json`;
  `corepack enable` provides it.
- **PostgreSQL 16**, either your own or the Compose service (below).
- Optional: Docker with Compose v2, for the database or the single-container image.

## Setup

```sh
corepack enable
pnpm install                      # also runs `prisma generate` for the server
cp .env.example .env              # local defaults; never commit .env
docker compose up -d db           # PostgreSQL 16 on 127.0.0.1:5432 (skip if you have your own)
pnpm db:migrate                   # apply migrations to civ_dev (DATABASE_URL from .env)
pnpm dev                          # server on 127.0.0.1:3001 + web app on http://localhost:5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` (including the
WebSocket stream) to the Fastify server. With `.env` as copied, `AUTH_MODE=disabled`
(allowed only because the server binds to `127.0.0.1`), so no token is needed. In this
mode the server only answers requests whose `Host` is a loopback name and whose
`Origin`, if any, is a loopback origin or in `CORS_ORIGINS` (protection against DNS
rebinding); to open the UI from another device, use token auth
([DEPLOYMENT.md](DEPLOYMENT.md#authentication)).

### Database

`docker compose up -d db` starts `postgres:16` with user/password `civ`/`civ`,
database `civ_dev`, a named volume `pgdata`, and a health check. On first start (empty
volume) `scripts/postgres-init/01-create-test-databases.sql` also creates `civ_test`
(server integration tests) and `civ_e2e` (browser tests). The port is published on
the loopback interface only.

With your own PostgreSQL, create the role and the three databases yourself, for
example:

```sql
CREATE ROLE civ LOGIN PASSWORD 'civ';
CREATE DATABASE civ_dev OWNER civ;
CREATE DATABASE civ_test OWNER civ;
CREATE DATABASE civ_e2e OWNER civ;
```

`pnpm db:migrate` reads `DATABASE_URL` from the environment, falling back to `.env`
(variables already set in the environment take precedence), so other databases are
migrated with `DATABASE_URL=postgresql://civ:civ@localhost:5432/<database> pnpm db:migrate`.
`pnpm db:migrate:e2e` does this for `civ_e2e` (or `E2E_DATABASE_URL`), and
`pnpm test:e2e` runs it before Playwright. The integration tests migrate `civ_test`
themselves.

To start over: `docker compose down -v` deletes the volume (all data), or
`pnpm --filter @civ/server db:reset` drops and re-migrates the database in
`DATABASE_URL`.

## Scripts

Root (`package.json`):

| Script                | Does                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm dev`            | server (`tsx watch`, TypeScript sources) and web app (Vite) in parallel                                 |
| `pnpm build`          | `pnpm -r build`: sim-core and shared (`tsc` → `dist/`), server (`tsc`), web (type-check + `vite build`) |
| `pnpm typecheck`      | `tsc --noEmit` in every package                                                                         |
| `pnpm lint`           | ESLint over the whole repository                                                                        |
| `pnpm format`         | Prettier, write                                                                                         |
| `pnpm format:check`   | Prettier, check only                                                                                    |
| `pnpm test`           | Vitest in every package (server tests need `civ_test`)                                                  |
| `pnpm test:e2e`       | `db:migrate:e2e`, then the Playwright browser tests (`@civ/web`)                                        |
| `pnpm check`          | `format:check`, `lint`, `typecheck`, `test`                                                             |
| `pnpm db:migrate`     | `prisma migrate deploy` for `DATABASE_URL`                                                              |
| `pnpm db:migrate:e2e` | `pnpm db:migrate` for `civ_e2e` (`E2E_DATABASE_URL` overrides the URL; POSIX shell syntax)              |
| `pnpm db:generate`    | regenerate the Prisma client                                                                            |
| `pnpm benchmark`      | engine tick benchmark (see [TESTING.md](TESTING.md#benchmark))                                          |

Per package: `@civ/server` also has `start` (built server), `test:watch`,
`db:migrate:dev` (create a new migration from `schema.prisma` changes) and `db:reset`;
`@civ/web` has `preview`; `@civ/sim-core` has `test:watch` and `benchmark`.

Helper scripts in `scripts/`:

| File                                         | Purpose                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reproduce-demo.ts`                          | engine-only reproducibility walkthrough ([EXPERIMENTS.md](EXPERIMENTS.md)); run with `pnpm --filter @civ/sim-core exec tsx ../../scripts/reproduce-demo.ts` |
| `docker-entrypoint.sh`                       | container entry point: `prisma migrate deploy`, then the server                                                                                             |
| `postgres-init/01-create-test-databases.sql` | creates `civ_test` and `civ_e2e` in the Compose database                                                                                                    |

## Workspace layout

```
packages/sim-core   @civ/sim-core  deterministic engine; pure TypeScript, no I/O
packages/shared     @civ/shared    HTTP/WebSocket contract: Zod request schemas, DTOs, API_ROUTES
apps/server         @civ/server    Fastify API, runners, persistence (Prisma/PostgreSQL), stream
apps/web            @civ/web       React + Vite observatory, PixiJS world renderer, Recharts dashboard
scripts/                           helper scripts (see above)
docs/                              documentation (this folder)
```

Dependencies point one way: `web → shared → sim-core` and `server → shared → sim-core`.
The engine knows nothing about HTTP, the database or rendering.

**Package resolution.** `@civ/sim-core` and `@civ/shared` export three conditions:
`source` (TypeScript sources), `types` and `default` (`dist/`). Development tools use
`source` — `tsx --conditions=source`, Vite and Vitest (`resolve.conditions`), and
`tsc` (`customConditions: ["source"]` in `tsconfig.base.json`) — so no build is needed
while developing. The built server (`node dist/index.js`) resolves the `default`
condition and therefore needs `dist/` of both packages: run `pnpm build` before
`pnpm --filter @civ/server start`.

## Conventions

### Code

- TypeScript strict mode with `noUncheckedIndexedAccess`, ESM with `NodeNext`
  resolution (relative imports end in `.js`), `verbatimModuleSyntax`
  (`import type` for types, enforced by ESLint's `consistent-type-imports`).
- Prettier: 100 columns, single quotes, trailing commas, semicolons.
- Small pure functions with brief doc comments that explain intent; one file per
  pipeline stage in `sim-core/src/systems/`.
- Untrusted input is validated with Zod at the boundary (HTTP bodies, query strings,
  environment, stored configs and state blobs).

### Determinism rules (engine)

ESLint enforces these in `packages/sim-core/src/**` (`eslint.config.js`):

| Forbidden                                                  | Use instead                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Math.random`                                              | a keyed stream: `ctx.rng('<stream>', entityId)` or `rngFor(seed, …)`                                         |
| `Date.now`, `new Date()`, `performance.now`                | the tick counter and the calendar                                                                            |
| `Math.exp`, `Math.log`, `Math.pow`, `Math.sin`, `Math.cos` | multiplication, lookup tables, Irwin–Hall `normal()` (not bit-identical across JavaScript engines otherwise) |
| `setTimeout`, `setInterval`, `fetch`                       | nothing: the engine is synchronous and does no I/O; scheduling belongs to the server's runner                |

Rules that are not linted but reviewed:

- Iterate entities in ascending id order (the state arrays are sorted by id); never
  depend on `Map`/`Set` insertion order built from external input, database row order
  or object key order.
- Randomness for an entity in a tick uses a stream keyed by that entity
  (`ctx.rng(stream, id)`), so processing order and other entities cannot shift its draws.
  Use a new stream name for a new kind of decision.
- Round derived floating-point state that is stored (e.g. energy to 1/1000) so
  serialised values stay short and stable.
- Bump `ENGINE_VERSION` (`src/version.ts`) whenever a change alters results for an
  existing seed and configuration (commit `88d349b` did not, see
  [ROADMAP.md](ROADMAP.md#known-issues)); bump `STATE_SCHEMA_VERSION` when the
  serialised state layout changes (old states are then rejected rather than
  reinterpreted).

### Money

All amounts are **integer cents** (`balanceCents`, `amountCents`, `…Cents`). Never
store or sum fractional money; divide only for statistics. Money is created only with
a `MoneyIssued` event (and, later, destroyed only with a matching destruction event),
and every movement must keep `Σ balances = issued − destroyed` (checked every tick).
See [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md).

### Server

- Request handlers never run ticks; they enqueue operations on the civilization's
  runner, whose control queue serialises them.
- Everything that must be consistent is written in one transaction (see
  [DATABASE.md](DATABASE.md#transaction-boundaries)).
- Errors are `AppError`s with a code from `ERROR_CODES`; the global handler turns
  them into `{ error: { code, message, details? } }`. Never put a raw infrastructure
  error message into an `AppError`, `lastError` or a stream message: use
  `reportFailure` (`src/http/failure.ts`), which logs the full error with a reference
  and returns a client-safe summary.
- The routes the server registers must equal `API_ROUTES` (a test checks this). New
  endpoints are added to `packages/shared/src/routes.ts` first, with the right `auth`
  level: authorisation is looked up from that column for the matched route, and a
  route under `/api` missing from it requires the operator.
- A control action writes its state change and audit entry in one transaction
  (`CivilizationStore.updateRuntime` or a checkpoint carrying the audit) and changes the
  runner's memory only after the commit.

## Recipes

### Adding a system (a pipeline stage)

1. Create `packages/sim-core/src/systems/<name>.ts` exporting a `SimSystem`
   `{ name, stage, run(ctx) }`. `stage` is its position in the documented update order
   ([SIMULATION_RULES.md](SIMULATION_RULES.md#update-order)); mutate `ctx.state` in
   place, iterate in id order, draw randomness from `ctx.rng('<new stream>', id)`,
   emit events with `ctx.events.emit(…)`.
2. Put its parameters in an exported constant (like `ROUTINE_RULES`) or in
   `SimulationConfigSchema` if users should be able to change them (bump
   `CONFIG_SCHEMA_VERSION` when the config shape changes).
3. Add it to `PIPELINE` in `src/engine/pipeline.ts`. The module asserts at load time
   that stages are in non-decreasing order.
4. If it needs new state, extend `WorldStateSchema` in `src/state/schema.ts`,
   initialise it in `src/world/generate.ts`, and bump `STATE_SCHEMA_VERSION`.
5. Add the invariants it must preserve to `src/invariants/check.ts` (new
   `InvariantCode`) with a test that corrupts a state and expects the code.
6. Export it from `src/index.ts`, add tests (`test/systems.test.ts`, determinism), bump
   `ENGINE_VERSION`, and document the rule with its parameters in
   [SIMULATION_RULES.md](SIMULATION_RULES.md).
7. If the new state should be queryable in SQL, add projection columns or tables in
   `apps/server/prisma/schema.prisma`, create a migration
   (`pnpm --filter @civ/server db:migrate:dev --name <name>`), and extend
   `apps/server/src/persistence/projections.ts`.

### Adding an event type

1. Add the payload to `EventPayloads` in `packages/sim-core/src/events/types.ts`
   (JSON data only), the type to `EVENT_TYPES`, and its `category`, `label` and
   `description` to `EVENT_CATALOG` (a `Record<EventType, …>`, so the compiler insists).
2. Emit it from a system with `ctx.events.emit(type, payload, refs, causeSeq)`. Give
   `refs` for every involved entity with a role (they power "events involving X"),
   and `causeSeq` when the cause is known. Entity kinds are limited to `citizen`,
   `building`, `household`; a new kind also needs the `EntityKind` enum in
   `schema.prisma` and a migration.
3. No database change is needed: events are stored generically (`type`, JSONB
   `payload`). The API accepts the new type in `types=` filters automatically.
4. Add a human-readable summary for it in the web app (`apps/web/src/lib/events.ts`
   formats each type).
5. Add a test and a row in the [event catalogue](SIMULATION_RULES.md#event-catalogue).

### Adding a metric

1. Add a `MetricDefinition` to `METRIC_DEFINITIONS` in
   `packages/sim-core/src/metrics/definitions.ts`: `key` (`category.name`), `label`,
   `category`, `kind`, `unit`, `description` and an exact `formula`. Choose `kind`
   carefully: it decides how the series is downsampled
   ([ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#downsampling-of-metric-series)).
2. Compute it in `src/metrics/compute.ts`; the return type `MetricValues` requires every
   registered key, so a missing computation is a compile error.
3. Samples recorded before the metric existed have no value for it: the series API
   returns `null` for those rows and the CSV export an empty cell. No migration is
   needed (samples are JSONB).
4. The dashboard groups and charts metrics from `METRIC_DEFINITIONS`
   (`apps/web/src/lib/metrics.ts`); a new `category` also needs a label there.
5. Add a test in `test/metrics.test.ts`, bump `ENGINE_VERSION` if stored results change,
   and add the definition to [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#definitions).

### Changing the database schema

Edit `apps/server/prisma/schema.prisma`, then
`pnpm --filter @civ/server db:migrate:dev --name <change>` to generate a migration
against `civ_dev`. Constraints Prisma cannot express (`CHECK`) go into a hand-written
migration, as in `20261014204500_integrity_checks`. Never edit an applied migration;
add a new one. Update [DATABASE.md](DATABASE.md).

## Troubleshooting

- **`AUTH_MODE=disabled is only allowed when HOST is a loopback address`**: you set
  `HOST=0.0.0.0` without token auth. Use `HOST=127.0.0.1`, or set `AUTH_MODE=token` and
  an `OPERATOR_TOKEN` (see [DEPLOYMENT.md](DEPLOYMENT.md#authentication)).
- **`Cannot find module '…/dist/index.js'` when running the built server**: run
  `pnpm build` first (see package resolution above).
- **Port 5432 already in use** when starting the Compose database: another PostgreSQL
  is running; stop it or use it directly.
- **Integration tests fail to connect**: the server tests use `TEST_DATABASE_URL`
  (default `postgresql://civ:civ@localhost:5432/civ_test`), not `DATABASE_URL`.
- **`403 FORBIDDEN` "only answers requests addressed to a loopback host"**: with
  `AUTH_MODE=disabled` you opened the app through a LAN address or another host name;
  use `localhost`/`127.0.0.1`, or switch to token auth.
- **Browser tests fail with missing tables**: `civ_e2e` is not migrated; run
  `pnpm db:migrate:e2e` (or use `pnpm test:e2e`, which does it first).
