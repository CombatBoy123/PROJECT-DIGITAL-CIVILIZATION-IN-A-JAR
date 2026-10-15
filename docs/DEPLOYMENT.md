# Deployment and operations

How to configure and run the server outside of development: environment variables,
authentication, the Docker image and Compose file, migrations, backups and recovery.

Related documents: [DATABASE.md](DATABASE.md) (transactions, crash recovery),
[API.md](API.md#authentication) (auth from a client's point of view),
[DEVELOPMENT.md](DEVELOPMENT.md) (local setup).

## Environment variables

Parsed and validated at start-up by `apps/server/src/config/env.ts`; an invalid value
stops the server with a list of problems. `.env.example` contains the development
defaults (`pnpm dev` and `pnpm db:migrate` read `.env`; variables already present in the
environment take precedence).

| Variable                  | Values                                                       | Default                 | Meaning                                                                                                     |
| ------------------------- | ------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | PostgreSQL URL                                               | **required**            | the application database                                                                                    |
| `HOST`                    | address                                                      | `127.0.0.1`             | listen address; `0.0.0.0` to accept remote connections (requires token auth)                                |
| `PORT`                    | 0–65535                                                      | `3001`                  | listen port                                                                                                 |
| `CORS_ORIGINS`            | comma-separated origins                                      | `http://localhost:5173` | browser origins allowed to call the API cross-origin (not needed when the server serves the web app itself) |
| `AUTH_MODE`               | `disabled`, `token`                                          | `disabled`              | see [authentication](#authentication)                                                                       |
| `OPERATOR_TOKEN`          | ≥ 24 characters                                              | —                       | bearer token for reads and mutations; required when `AUTH_MODE=token`                                       |
| `VIEWER_TOKEN`            | ≥ 24 characters, different from `OPERATOR_TOKEN`             | —                       | optional read-only token; when set, reads require a token                                                   |
| `CHECKPOINT_INTERVAL_MS`  | 100–600,000                                                  | `2000`                  | maximum real time between checkpoints of a running civilization (bounds what a crash can lose)              |
| `MAX_BUFFERED_EVENTS`     | 100–1,000,000                                                | `20000`                 | uncommitted events that force a checkpoint before more ticks run (backpressure)                             |
| `FRAME_RATE`              | 1–30                                                         | `5`                     | maximum WebSocket frames per second per civilization                                                        |
| `INVARIANT_CHECKS`        | `every-tick`, `off`                                          | `every-tick`            | `off` exists for benchmarks only; never use it for experiments whose results matter                         |
| `RESUME_RUNNING_ON_START` | `true`, `false`, `1`, `0`                                    | `false`                 | continue civilizations that were running when the server stopped (otherwise they are paused)                |
| `LOG_LEVEL`               | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | `info`                  | JSON logs on stdout (pino); `Authorization` headers and stream `?token=` values are redacted                |
| `WEB_DIST_DIR`            | directory                                                    | —                       | serve the built web app from this directory (single-origin deployment, SPA fallback)                        |
| `NODE_ENV`                | `development`, `test`, `production`                          | `development`           | set to `production` in the image                                                                            |
| `TEST_DATABASE_URL`       | PostgreSQL URL                                               | `…/civ_test`            | **tests only**: the integration-test database (its tables are truncated)                                    |

## Authentication

| Mode       | Behaviour                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` | No tokens; every request acts as the operator `local-dev`. Accepted **only** when `HOST` is `127.0.0.1`, `localhost` or `::1`.                                                                                |
| `token`    | `Authorization: Bearer <token>` (WebSocket: `?token=`). `OPERATOR_TOKEN` may do everything; `VIEWER_TOKEN`, if set, may only read and is then required for reads; without `VIEWER_TOKEN` reads are anonymous. |

**Why `disabled` is loopback-only.** Without tokens, anyone who can reach the port can
start, reset, restore or delete civilizations. Binding to a loopback address limits
that to processes on the same machine, which is acceptable for a developer's own
workstation and nothing else. The server enforces the rule at start-up instead of
trusting documentation: `HOST=0.0.0.0` with `AUTH_MODE=disabled` is a configuration
error. The same applies inside a container, where the server must listen on
`0.0.0.0` to be reachable — so the image can only run with token auth.

Further notes:

- Generate tokens with `openssl rand -hex 32`. Keep them out of images, Compose files
  and version control; pass them as environment variables or secrets.
- The server speaks plain HTTP. Tokens are bearer credentials, so put a TLS-terminating
  reverse proxy in front of any deployment that is reachable beyond localhost, and
  configure it to proxy WebSocket upgrades for `/api/civilizations/:id/stream`. The
  stream token travels in the query string; make sure the proxy does not log query
  strings (the server redacts them from its own logs).
- The web app keeps the token the user enters in the browser's `localStorage` (memory
  only when storage is unavailable); use the viewer token for shared screens.
- Destructive actions additionally require the civilization's exact name (see
  [API.md](API.md#destructive-actions)). All control actions are audited with the actor.

## Docker image

`Dockerfile` (multi-stage, `node:22.22.0-bookworm-slim`):

1. **base** — Node 22, `openssl` (lets Prisma pick the right engine), pnpm via
   `corepack` at the version pinned in `package.json`.
2. **build** — copies the manifests and runs `pnpm install --frozen-lockfile` (cached
   layer), copies the sources, runs `pnpm -r build` (sim-core and shared to `dist/`,
   server `tsc`, web `vite build`), then assembles `/out/app` with
   `pnpm --filter=@civ/server deploy --legacy`: the server with its own `node_modules`,
   in which `@civ/sim-core` and `@civ/shared` are copied packages containing only
   `package.json` and `dist/` (the built server resolves them through their `default`
   export condition). It adds the compiled server, the Prisma schema and migrations,
   generates the Prisma client, and copies the web build to `/app/web`.
3. **runtime** — `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3001`,
   `WEB_DIST_DIR=/app/web`; runs as the unprivileged `node` user; files are owned by
   root (the process never writes to its own files); `EXPOSE 3001`; a `HEALTHCHECK`
   that requests `/api/health` with Node's `fetch` (no curl in the image); entry point
   `scripts/docker-entrypoint.sh`.

**Image contents.** The deployed `node_modules` holds production dependencies only
(`pnpm deploy --prod`; about 240 MB when assembled outside Docker for this document,
most of it Prisma engines). They include the Prisma CLI, which runs
`prisma migrate deploy` on start, and `ws`, which the stream hub imports.

No authentication settings are baked into the image. It refuses to start until
`AUTH_MODE=token` and `OPERATOR_TOKEN` are provided.

```sh
docker build -t civ-jar .
docker run --rm -p 3001:3001 \
  -e DATABASE_URL=postgresql://civ:civ@db-host:5432/civ_dev \
  -e AUTH_MODE=token -e OPERATOR_TOKEN="$(openssl rand -hex 32)" \
  civ-jar
```

### Migrations on start

`scripts/docker-entrypoint.sh` runs
`prisma migrate deploy --schema ./prisma/schema.prisma` and then `exec node dist/index.js`,
so Node replaces the shell as PID 1 and receives `SIGTERM` directly (the server installs
its own `SIGTERM`/`SIGINT` handlers). `migrate deploy`
applies only migrations not yet recorded in `_prisma_migrations`, each in its own
transaction, and never resets data; if a migration fails the container exits and the
server does not start. When several replicas start at once, Prisma serialises
`migrate deploy` with a PostgreSQL advisory lock — but note that running more than one
server against the same database is not supported in Phase 1 (each server would run
its own copy of a civilization; see [limitations](#limitations)).

## Docker Compose

`docker-compose.yml` defines:

- **`db`** — `postgres:16`, user/password `civ`/`civ`, database `civ_dev`, named volume
  `pgdata`, health check `pg_isready`, port `127.0.0.1:5432`. On first start it also
  creates `civ_test` and `civ_e2e` (`scripts/postgres-init/`). Usable alone for
  development: `docker compose up -d db`.
- **`app`** (profile `app`, so it only starts when asked for) — built from the
  `Dockerfile`, waits for `db` to be healthy, runs migrations then the server with the
  built web app, `AUTH_MODE=token`, `HOST=0.0.0.0`, published on `${APP_PORT:-3001}`.
  `OPERATOR_TOKEN` comes from your shell (the server refuses to start without one);
  `VIEWER_TOKEN`, `RESUME_RUNNING_ON_START` and `LOG_LEVEL` are passed through when set.
  `stop_grace_period: 40s` leaves time for the final checkpoints (the server
  force-exits after 30 s).

```sh
export OPERATOR_TOKEN=$(openssl rand -hex 32)
docker compose --profile app up -d --build
# browse to http://localhost:3001 and enter the operator token in the UI's token control
docker compose --profile app logs -f app
docker compose --profile app down     # keeps the database volume; add -v to delete it
```

The `civ`/`civ` credentials are for local use. For anything else, change the
PostgreSQL password (`POSTGRES_PASSWORD` and the `DATABASE_URL` of `app`), keep the
database port unpublished, and use a managed or properly secured PostgreSQL.

## Backups

The database holds everything: run state (checkpoints, snapshots), history and the
audit log. Back it up with PostgreSQL's tools; `pg_dump` takes a transactionally
consistent snapshot, and because every checkpoint is a single transaction, a dump
always contains complete checkpoints with exactly their events and metrics.

```sh
# Compose database
docker compose exec -T db pg_dump -U civ -Fc civ_dev > civ_dev-$(date +%F).dump
# restore into an empty database, then start the server (migrations run on start)
docker compose exec -T db createdb -U civ civ_restore
docker compose exec -T db pg_restore -U civ -d civ_restore --no-owner < civ_dev-2026-10-15.dump
```

A dump taken while a civilization runs contains its last committed checkpoint;
the uncommitted ticks are re-simulated identically when it runs again.

Per-civilization exports (`/export/config`, `/export/metrics.csv`,
`/export/events.ndjson`) are for analysis, not backups. Because Phase 1 has no
interventions, a civilization's state at tick _N_ is fully determined by its config
export and _N_ (see [EXPERIMENTS.md](EXPERIMENTS.md)), but snapshots, audit entries and
wall-clock information are only in the database.

## Recovery and restarts

Details are in [DATABASE.md](DATABASE.md#crash-and-restart-recovery). In short:

- **Graceful stop** (`SIGTERM`/`SIGINT`, e.g. `docker compose stop`): stop accepting
  requests, close streams, write a final checkpoint for every loaded civilization, exit.
- **Crash or kill**: at most the ticks since the last checkpoint are lost (about
  `CHECKPOINT_INTERVAL_MS` of running time); events never exist without their state.
- **Start-up**: civilizations stored as running are paused with an audit entry, or
  resumed when `RESUME_RUNNING_ON_START=true`.
- **Database unavailable**: `/api/health` returns `503`; a failed checkpoint pauses
  the civilization, keeps the uncommitted ticks in memory and reports `lastError`;
  pausing again (or the next checkpoint) retries.
- **Halts**: an invariant violation halts the civilization and keeps the last good
  checkpoint; restore a snapshot or reset it (see [API.md](API.md#halted-civilizations)).

## Upgrades

Pull or build the new image and restart; pending migrations are applied on start.
`engineVersion` is recorded per civilization at creation. A newer engine continues
existing civilizations with its own rules, so results of a run that spans two engine
versions are not reproducible with either alone; recreate experiments from their
config export on one engine version when exact reproduction matters. States with a
different state schema version are refused rather than reinterpreted.

## Limitations

- **One server process per database.** Civilizations are loaded into the memory of
  the process that serves them; there is no cross-process coordination in Phase 1, so
  do not run replicas against the same database.
- **No built-in TLS, rate limiting or user accounts**: two shared tokens (operator,
  viewer) are the whole access model.
- **No retention policy**: history grows with simulated time until a civilization is
  deleted (sizes in [DATABASE.md](DATABASE.md#size-and-retention)).
