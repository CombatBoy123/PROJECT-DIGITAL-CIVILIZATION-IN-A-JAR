# Digital Civilization in a Jar

An inspectable artificial-society simulator. A small world of autonomous citizens
lives in a deterministic simulation engine; every rule is written down, every number
on screen comes from the simulation, history is auditable, and experiments are
exactly reproducible from a seed.

## Status

**Phase 1 — Foundation — in progress.** The deterministic engine, persistence, the
REST/WebSocket API and the observatory UI exist. Citizens sleep, wake, visit plazas and
parks, travel along roads, tire and age through seasons and weather; money exists and
is conserved, but there is no economy in motion yet (production, markets, jobs and
policies are Phases 2–4). See [docs/ROADMAP.md](docs/ROADMAP.md) for exactly what is
done, verified and outstanding.

## Features (Phase 1)

**Simulation engine** (`packages/sim-core`, pure TypeScript, no I/O)

- One tick = one simulated hour; configurable calendar with four seasons.
- Procedural world from a seed: zoned block map with roads, plazas, parks and houses;
  households with partners, children and relatives; citizens with age, education,
  personality, skills and an initial endowment.
- Rules: seasonal weather (Markov chain) and temperature, ageing and life stages,
  energy, a rule-based daily routine (sleeping, waking, outings to venues with capacity
  limits, travel times along the road network).
- Determinism: keyed random streams per (system, tick, entity), canonical state
  serialisation and hash, no wall-clock or global randomness (enforced by ESLint).
- Integer-cent money with explicit issuance events and a conservation invariant;
  eleven invariant classes checked after every tick; an event catalogue with causal
  links; 17 metrics with written definitions.

**Server** (`apps/server`, Fastify + Prisma + PostgreSQL)

- 25 endpoints including a WebSocket stream, all validated with Zod
  ([docs/API.md](docs/API.md)).
- Background runners with speed control (1–1000 ticks/s or maximum), single steps,
  pause; atomic checkpoints (state, events, metrics, projections in one transaction).
- Named snapshots with exact restore, reset to genesis, delete — destructive actions
  require typing the civilization's name; an audit log of every control action.
- Paginated citizen/building lists and inspectors, keyset-paginated event history,
  downsampled metric series, CSV/NDJSON/JSON exports.
- Live stream: keyframes and delta frames at a fixed frame rate with backpressure,
  live events.
- Token auth (operator/viewer); unauthenticated mode only on loopback; crash recovery
  and graceful shutdown.

**Observatory** (`apps/web`, React + PixiJS + Recharts)

- Civilization list and creation form, an observatory page with the PixiJS world map,
  playback controls, inspectors, event feed, snapshots, a lab tab (reset, exports) and
  the audit log, and a metrics dashboard with definitions. It is being completed in
  Phase 1; see [docs/TESTING.md](docs/TESTING.md#browser-appswebe2e-playwright) for
  what the browser tests cover.

## Quick start

Prerequisites: **Node.js ≥ 22.12**, **pnpm 10** (`corepack enable`), and **PostgreSQL 16**
— your own, or Docker Compose.

```sh
corepack enable
pnpm install
cp .env.example .env              # local development defaults (auth disabled on 127.0.0.1)
docker compose up -d db           # PostgreSQL 16 with civ/civ and civ_dev, civ_test, civ_e2e
pnpm db:migrate                   # apply migrations to civ_dev
pnpm dev                          # API on http://127.0.0.1:3001, UI on http://localhost:5173
```

Then open <http://localhost:5173>, create a civilization (name, seed, population) and
press play. Or use the API directly:

```sh
curl -s -X POST http://127.0.0.1:3001/api/civilizations -H 'content-type: application/json' \
  -d '{"name":"Demo One","seed":"demo-1","config":{"population":100}}'
```

Single container (server + built UI, token auth):

```sh
export OPERATOR_TOKEN=$(openssl rand -hex 32)
docker compose --profile app up -d --build      # http://localhost:3001
```

## Commands

| Command                                                                | What it does                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install`                                                         | install dependencies (and generate the Prisma client)                    |
| `pnpm db:migrate`                                                      | apply database migrations to `DATABASE_URL`                              |
| `pnpm dev`                                                             | run the server and the web app with live reload                          |
| `pnpm build`                                                           | build every package                                                      |
| `pnpm check`                                                           | format check, lint, type-check, unit and integration tests               |
| `pnpm test`                                                            | unit and integration tests (server tests use `civ_test`)                 |
| `pnpm test:e2e`                                                        | Playwright browser tests (uses `civ_e2e`)                                |
| `pnpm benchmark`                                                       | engine tick benchmark                                                    |
| `pnpm --filter @civ/sim-core exec tsx ../../scripts/reproduce-demo.ts` | reproducibility walkthrough ([docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)) |

## Repository map

```
packages/sim-core/   deterministic engine: rng, clock, world generation, systems, events,
                     metrics, invariants, serialisation (bench/ has the benchmark)
packages/shared/     API contract: Zod request schemas, response DTOs, route table, stream messages
apps/server/         Fastify API, simulation runners, persistence, WebSocket stream
  prisma/            schema.prisma and SQL migrations
apps/web/            React observatory, PixiJS world renderer, Recharts dashboard
  e2e/               Playwright browser tests
scripts/             reproduce-demo.ts, Docker entry point, PostgreSQL init script
docs/                documentation (below)
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## Documentation

| Document                                        | Contents                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)         | design, components, data model, invariants, phase plan, acceptance criteria |
| [SIMULATION_RULES.md](docs/SIMULATION_RULES.md) | time model, update order, randomness, every rule with its parameters        |
| [ECONOMIC_MODEL.md](docs/ECONOMIC_MODEL.md)     | money, conservation, metric definitions, downsampling, planned economy      |
| [EXPERIMENTS.md](docs/EXPERIMENTS.md)           | reproducibility walkthrough with real hashes and metrics                    |
| [API.md](docs/API.md)                           | every endpoint, errors, pagination, auth, WebSocket protocol                |
| [DATABASE.md](docs/DATABASE.md)                 | tables, constraints, transactions, recovery, sizes                          |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)           | setup, scripts, conventions, adding systems, events and metrics             |
| [TESTING.md](docs/TESTING.md)                   | test layers, databases, coverage, benchmark results                         |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)             | environment variables, auth, Docker, Compose, backups                       |
| [ROADMAP.md](docs/ROADMAP.md)                   | phase checklist and Phase 1 acceptance status                               |
