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
  limits that must fit before nightfall and the citizen's energy, travel times along the
  road network).
- Determinism: keyed random streams per (system, tick, entity), canonical state
  serialisation and hash, no wall-clock or global randomness (enforced by ESLint).
- Integer-cent money with explicit issuance events and a conservation invariant;
  twelve invariant classes checked at genesis, after every tick and on every restore; an
  event catalogue with causal links; 17 metrics with written definitions.

**Server** (`apps/server`, Fastify + Prisma + PostgreSQL)

- 25 endpoints including a WebSocket stream, all validated with Zod
  ([docs/API.md](docs/API.md)).
- Background runners with speed control (1–1000 ticks/s or maximum), single steps,
  pause; atomic checkpoints (state, events, metrics, projections in one transaction);
  every control action commits together with its audit entry.
- Named snapshots with exact restore, reset to genesis, delete — destructive actions
  require typing the civilization's name; an audit log of every control action.
- Paginated citizen/building lists and inspectors, keyset-paginated event history,
  downsampled metric series, CSV/NDJSON/JSON exports.
- Live stream: keyframes and delta frames at a fixed frame rate with backpressure,
  live events, connection limits.
- Token auth (operator/viewer), decided per matched route; unauthenticated mode only on
  loopback and only for requests addressed to a loopback host (DNS-rebinding safe);
  crash recovery, recovery from corrupt stored state, graceful shutdown.

**Observatory** (`apps/web`, React + PixiJS + Recharts)

- Civilization list and creation form, an observatory page with the PixiJS world map,
  playback controls, inspectors, event feed, snapshots, a lab tab (reset, exports) and
  the audit log, and a metrics dashboard with definitions. With token auth, operator-only
  controls are disabled with an explanation for viewers. See
  [docs/TESTING.md](docs/TESTING.md#browser-appswebe2e-playwright-18-tests) for what the browser
  tests cover.

## Quick start

**One command on Debian, Ubuntu or Kali Linux.** From the repository root, run
`bash scripts/setup-debian.sh`. It installs Node 22 (with nvm) and PostgreSQL if they are
missing, creates the local development role and databases, installs the dependencies,
applies the migrations and starts the app on <http://localhost:5173>. Running it again is
safe; `--no-start` skips the last step.

**Manual setup.** Prerequisites: **Node.js ≥ 22.12**, **pnpm 10** (`corepack enable`), and **PostgreSQL 16**
— your own, or Docker Compose.

```sh
corepack enable
pnpm install
cp .env.example .env              # local development defaults (auth disabled on 127.0.0.1)
docker compose up -d db           # PostgreSQL 16 with civ/civ and civ_dev, civ_test, civ_e2e
pnpm db:migrate                   # apply migrations to civ_dev
pnpm dev                          # API on http://127.0.0.1:3001, UI on http://localhost:5173
```

`docker compose` needs the Docker Compose v2 plugin; without it Docker answers
`unknown shorthand flag: 'd' in -d`. Install the plugin, use the older `docker-compose`
command, or skip Docker: `scripts/setup-debian.sh` installs PostgreSQL directly.

Then open <http://localhost:5173>, create a civilization (name, seed, population) and
press play. Without tokens the server only answers requests addressed to a loopback host
(`localhost`, `127.0.0.1`, `[::1]`), so opening the UI through a LAN address needs token
auth ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#authentication)). Or use the API directly:

```sh
curl -s -X POST http://127.0.0.1:3001/api/civilizations -H 'content-type: application/json' \
  -d '{"name":"Demo One","seed":"demo-1","config":{"population":100}}'
```

Run the tests (the server tests use `civ_test`; `pnpm test:e2e` first migrates `civ_e2e`,
and Playwright needs Chromium once: `pnpm --filter @civ/web exec playwright install chromium`):

```sh
pnpm test                         # unit and integration tests
pnpm test:e2e                     # browser tests (migrates civ_e2e, then runs Playwright)
```

Single container (server + built UI, token auth):

```sh
export OPERATOR_TOKEN=$(openssl rand -hex 32)
docker compose --profile app up -d --build      # http://localhost:3001
```

## Using the observatory

- **Create** a civilization with a name, a seed and, under _Advanced parameters_, the
  [configuration](docs/SIMULATION_RULES.md#configuration-parameters). _Initial wealth
  mean (cents)_ is the expected adult endowment; the median is about 85 % of it at the
  default spread of 0.5. A failed submission opens the section with the first invalid
  field and focuses it.
- **Playback**: play/pause, single step and speed presets. Keyboard: `Space` toggles
  play/pause and `.` steps one tick, except while typing, in a dialog, on a button or
  tab, or while a scrollable panel such as the Events tab has focus (then `Space`
  scrolls it).
- **Map**: drag to pan, zoom with the wheel or the buttons, fit to view. Clicking inside
  a building selects a citizen only when the click lands on the citizen's dot;
  otherwise it selects the building. On roads and open ground a small tolerance
  applies.
- **Dashboard**: every metric with its definition. Season starts are drawn as lines;
  only the labels that fit without overlapping are shown, above the plot. Head counts
  use whole-number axis steps and shares are limited to 0–100 %. An invalid custom range
  shows a prompt instead of the previous range's charts.
- **Token auth**: enter a token with the header's _Enter access token_ button, which
  then reads _Operator token_, _Viewer token_, _Invalid token_ or _Token set
  (unverified)_. The role is learned from the server's answers and remembered per token
  in the browser; operator-only controls (play, step, speed and their shortcuts, reset,
  save snapshot, restore, delete, create) are disabled with an explanation for viewers,
  without a token and for a rejected token. A viewer token is recognised at its first
  refused operator action. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#authentication).

## Browser demo

A standalone, single-file version of the simulator that runs entirely in the browser,
phones included: the real engine (`@civ/sim-core`) steps in the page and the real
PixiJS map draws it. No server and no database are involved.

```sh
pnpm demo:build    # → apps/web/dist-demo/digital-civilization-in-a-jar.html
```

`demo:build` runs the Vite demo build (`apps/web/vite.demo.config.ts`, entry
`apps/web/demo.html`) and inlines the CSS and the single JS bundle into one HTML
fragment (about 1 MB) meant to be published as a page: a `<title>`, one `<style>`,
`<div id="root">` and one `<script type="module">`, with no network requests and no
`eval` (PixiJS's CSP-safe `pixi.js/unsafe-eval` build, Zod's JIT off). For live
development run `pnpm --filter @civ/web exec vite --config vite.demo.config.ts` and
open `/demo.html`. Source: `apps/web/src/demo/`.

The demo has the map (pinch, pan, tap to select), playback (1, 4, 12 or 48 simulated
hours per second, +1 hour, +1 day), an inspector, a searchable people list, live
statistics with their definitions, the newest 400 events, and a World tab: generate a
new world (seed, 10–1,000 people, days per season, stochastic weather), one in-memory
save point, reset to genesis, and the state fingerprint (`demo-1` with 100 people
reads `cc32f723…` at tick 24, as in [EXPERIMENTS.md](docs/EXPERIMENTS.md)). Compared
with the full app it has no persistence (a reload starts over), no history beyond the
recent events, no snapshots on disk, no exports and no operator/viewer access tokens.

## Commands

| Command                                                                | What it does                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install`                                                         | install dependencies (and generate the Prisma client)                    |
| `pnpm db:migrate`                                                      | apply database migrations to `DATABASE_URL`                              |
| `pnpm db:migrate:e2e`                                                  | apply migrations to `civ_e2e` (or `E2E_DATABASE_URL`)                    |
| `pnpm dev`                                                             | run the server and the web app with live reload                          |
| `pnpm build`                                                           | build every package                                                      |
| `pnpm check`                                                           | format check, lint, type-check, unit and integration tests               |
| `pnpm test`                                                            | unit and integration tests (server tests use `civ_test`)                 |
| `pnpm test:e2e`                                                        | `db:migrate:e2e`, then the Playwright browser tests (on `civ_e2e`)       |
| `pnpm demo:build`                                                      | build the single-file browser demo ([Browser demo](#browser-demo))       |
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
  src/demo/          standalone browser demo (engine in the page; see Browser demo)
  e2e/               Playwright browser tests
scripts/             reproduce-demo.ts, build-demo-artifact.mjs, Docker entry point,
                     PostgreSQL init script
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
