# HTTP and WebSocket API

The contract lives in `packages/shared`: `src/routes.ts` (`API_ROUTES`, the exact list of
endpoints — the server registers exactly these), `src/api.ts` (Zod request schemas and
response types) and `src/stream.ts` (WebSocket messages). The server implementation is
in `apps/server/src/routes/` and `apps/server/src/ws/stream.ts`.

All examples below are real responses from the production build of the server
(seed `demo-1`, 100 citizens), shortened where marked with `…`.

Related documents: [DATABASE.md](DATABASE.md) (where data comes from),
[DEPLOYMENT.md](DEPLOYMENT.md) (auth configuration),
[SIMULATION_RULES.md](SIMULATION_RULES.md) (event types, rules).

## Contents

- [Conventions](#conventions) · [Authentication](#authentication) ·
  [Errors](#errors) · [Pagination](#pagination) ·
  [Destructive actions](#destructive-actions) ·
  [Halted civilizations](#halted-civilizations)
- Endpoints: [system](#system) · [civilizations](#civilizations) ·
  [control](#control) · [world](#world) · [history](#history) ·
  [snapshots](#snapshots) · [exports](#exports)
- [WebSocket stream](#websocket-stream)

## Conventions

- Base URL: the server origin, e.g. `http://127.0.0.1:3001` in development (the Vite dev
  server on `http://localhost:5173` proxies `/api` including WebSockets). All paths
  start with `/api/`.
- Requests and responses are JSON (`content-type: application/json`), except the
  CSV/NDJSON exports and the WebSocket. Request bodies are limited to 256 KiB.
- Every request object is validated with Zod **strict** schemas: unknown body fields
  and unknown query parameters are rejected with `400 VALIDATION_ERROR`.
- `:id` is a civilization UUID; `:citizenId` and `:buildingId` are positive integers
  (engine ids); `:snapshotId` is a UUID.
- Status values are lower case: `paused`, `running`, `halted`.
- Money is always integer cents (`balanceCents`).

In the examples:

```sh
API=http://127.0.0.1:3001
AUTH="Authorization: Bearer $OPERATOR_TOKEN"   # omit with AUTH_MODE=disabled
JSON='content-type: application/json'
```

## Authentication

Configured by environment variables (see [DEPLOYMENT.md](DEPLOYMENT.md#authentication)).

| Mode                 | Who can do what                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE=disabled` | Every request acts as operator `local-dev`. Accepted **only** when `HOST` is a loopback address (`127.0.0.1`, `localhost`, `::1`); the server refuses to start otherwise.                               |
| `AUTH_MODE=token`    | `Authorization: Bearer <token>`. The `OPERATOR_TOKEN` may read and mutate. If `VIEWER_TOKEN` is set, reads require the viewer or operator token; if it is not set, reads are open to anonymous clients. |

Each route has an auth level (`API_ROUTES[].auth`):

- `public` — no token ever: `GET /api/health`, `GET /api/meta`.
- `read` — every other `GET` (including the stream).
- `operate` — every `POST`, `PUT` and `DELETE`.

Resolution of a request in token mode: a wrong token → `401 UNAUTHORIZED` ("Invalid
token"); no token while `VIEWER_TOKEN` is set → `401`; a mutation without a token →
`401`; a mutation with the viewer token → `403 FORBIDDEN`. Tokens are compared in
constant time. Browsers cannot set headers on WebSocket connections, so the stream
endpoint also accepts `?token=<token>`; the value is redacted from logs. CORS allows the
origins in `CORS_ORIGINS` with methods `GET, POST, PUT, DELETE`, headers
`Authorization, Content-Type`, and exposes `Content-Disposition`. The actor recorded in
the audit log is `operator`, `viewer`, `anonymous` or `local-dev`.

## Errors

Every error has the same body:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      {
        "path": "config.population",
        "message": "Too small: expected number to be >=10",
        "code": "too_small"
      }
    ]
  }
}
```

| Code                    | HTTP | When                                                                                                                                                                      |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`      | 400  | invalid path, query or body (`details` lists the issues); malformed JSON. Payload-too-large (413) and unsupported media type (415) keep their HTTP status with this code. |
| `CONFIRMATION_REQUIRED` | 400  | a destructive action without `confirm`, or with a name that does not match exactly                                                                                        |
| `UNAUTHORIZED`          | 401  | missing or invalid token                                                                                                                                                  |
| `FORBIDDEN`             | 403  | the viewer token used for a mutation                                                                                                                                      |
| `NOT_FOUND`             | 404  | unknown civilization, citizen, building, snapshot or route                                                                                                                |
| `CONFLICT`              | 409  | duplicate civilization or snapshot name; stepping while running; restoring a detached snapshot; incompatible state schema version                                         |
| `HALTED`                | 409  | start, step or snapshot on a halted civilization                                                                                                                          |
| `INTERNAL`              | 500  | unexpected failures, a failed checkpoint, a stored state that cannot be loaded                                                                                            |

## Pagination

Two schemes, chosen by the kind of data:

- **Offset pagination for projections** (`/citizens`, `/buildings`): `limit` and
  `offset`, a `total` count, and `asOfTick`, the checkpoint tick the rows represent.
  Each page is read in one consistent snapshot transaction, and orders always end with
  the unique id, so pages are stable for a given `asOfTick`. While a simulation runs,
  a checkpoint may land between two page requests; compare `asOfTick` to detect that
  the pages come from different ticks.
- **Keyset pagination for append-only history** (`/events` by `seq`, `/audit` by
  `id`): pass the previous response's `nextCursor` as `before` (newest-first pages)
  or `after` (oldest-first pages, events only). `nextCursor` is `null` when the
  direction is exhausted. Keyset pages never skip or repeat rows when new rows are
  appended. History is only rewritten by a restore or reset (see
  [stream `reset`](#message-types)); restart pagination after one.

Small collections are returned whole, newest first: civilizations (at most 1,000) and
snapshots (at most 500), as `{ "items": [...] }`.

## Destructive actions

Reset, snapshot restore and delete permanently remove data. Besides the operator
token they require the civilization's **exact** name in the body:
`{ "confirm": "<exact civilization name>" }` (case-sensitive, at most 80
characters). A missing `confirm` or a mismatch is `400 CONFIRMATION_REQUIRED`; a body
of the wrong shape is `400 VALIDATION_ERROR`. Every destructive action is recorded in
the audit log.

## Halted civilizations

If the engine detects an invariant violation (or throws), the runner stops, drops
the uncommitted ticks, records `status: halted` with `haltReason` and an audit entry
`simulation.halted` (actor `engine`, details listing the violations), and reloads the
last durable checkpoint. `start`, `step` and snapshot creation then return
`409 HALTED`; reads, `pause`, speed changes, snapshot restore, reset and delete still
work. Restore and reset clear the halt.

---

## System

### `GET /api/health` — public

Liveness and database reachability (`SELECT 1` with a 2 s timeout). `200
{ "ok": true, "database": "up" }`, or `503 { "ok": false, "database": "down" }`. Used by
the Docker health check.

### `GET /api/meta` — public

```sh
curl -s $API/api/meta
```

```json
{
  "engineVersion": "0.1.0",
  "authMode": "token",
  "readRequiresToken": false,
  "frameRate": 5,
  "maxStepsPerRequest": 1000
}
```

`readRequiresToken` is true when `AUTH_MODE=token` and `VIEWER_TOKEN` is set.

## Civilizations

### `GET /api/civilizations` — read

`ListResponse<CivilizationSummary>`, newest first, at most 1,000.

`CivilizationSummary` fields: `id`, `name`, `seed`, `status`, `speed` (target ticks per
second, 0 = maximum), `durableTick` (tick of the latest checkpoint), `tick` (in-memory
tick when loaded, else the durable tick), `calendar` (`tick, day, hour, dayOfSeason,
dayOfYear, season, year`), `population`, `engineVersion`, `haltReason`, `lastError` (last
persistence error, if the latest checkpoint attempt failed), `loaded` (whether a runner
holds it in memory), `createdAt`, `updatedAt`.

### `POST /api/civilizations` — operate

Creates a civilization: generates the world (tick 0) and persists it, its genesis
events and the first metric sample in one transaction. The civilization starts
`paused` at speed 5.

| Field    | Type   | Rules                                                                                                    |
| -------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `name`   | string | trimmed, 1–80 characters, starts with a letter or digit; then letters, digits, spaces, `. _ ' -`; unique |
| `seed`   | string | optional; 1–64 of `[A-Za-z0-9._-]`; omitted ⇒ the server generates 16 random hex characters (recorded)   |
| `config` | object | optional; [`SimulationConfig`](SIMULATION_RULES.md#configuration-parameters), strict, defaults filled in |

```sh
curl -s -X POST $API/api/civilizations -H "$AUTH" -H "$JSON" \
  -d '{"name":"Demo One","seed":"demo-1","config":{"population":100}}'
```

`201 CivilizationDetail` = summary + `config` (complete, with defaults) +
`configSchemaVersion`:

```json
{ "id": "20a4ea01-ff81-4762-ae6e-aa6e71bb28b8", "name": "Demo One", "seed": "demo-1",
  "status": "paused", "speed": 5, "durableTick": 0, "tick": 0,
  "calendar": { "tick": 0, "day": 1, "hour": 0, "dayOfSeason": 0, "dayOfYear": 0, "season": "spring", "year": 1 },
  "population": 100, "engineVersion": "0.1.0", "haltReason": null, "lastError": null, "loaded": true, …,
  "config": { "population": 100, "daysPerSeason": 7, "initialWealth": { "meanCents": 50000, "spread": 0.5 },
              "lifeStages": { "adultAge": 18, "elderAge": 65 }, "movement": { "walkTilesPerTick": 24 },
              "stochastic": { "weather": true }, "metricsInterval": 1 },
  "configSchemaVersion": 1 }
```

Errors: `400 VALIDATION_ERROR` (e.g. `population` 5), `409 CONFLICT` (name taken).

### `GET /api/civilizations/:id` — read

`CivilizationDetail`. `404` if unknown.

### `DELETE /api/civilizations/:id` — operate, [destructive](#destructive-actions)

Body `{ "confirm": "<name>" }`. Stops the runner, deletes the civilization and all its
data (snapshots, projections, history, checkpoint); audit entries are kept with the
civilization id in `details`. `204` on success. Stream subscribers receive `deleted`.

```sh
curl -s -X DELETE $API/api/civilizations/$ID -H "$AUTH" -H "$JSON" -d '{"confirm":"Demo One"}'
```

## Control

All control operations of one civilization are serialised on a per-civilization queue,
so they never interleave with each other or with a checkpoint. Each returns the updated
`CivilizationSummary`.

### `POST /api/civilizations/:id/control` — operate

Body (discriminated by `action`):

| Body                               | Effect                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `{ "action": "start" }`            | runs the background tick loop at the civilization's speed; no-op if already running; `409 HALTED` if halted |
| `{ "action": "pause" }`            | stops the loop and checkpoints the current tick; also retries persistence after a failed checkpoint         |
| `{ "action": "step", "steps": n }` | `n` = 1–1000 (default 1) ticks on a paused civilization, then a checkpoint; `409 CONFLICT` while running    |

Steps run in time slices (≤ 12 ms each) so other requests stay responsive. If an
invariant fails during a step, the response is `200` with `status: "halted"`.

```sh
curl -s -X POST $API/api/civilizations/$ID/control -H "$AUTH" -H "$JSON" -d '{"action":"step","steps":240}'
# → { …, "status": "paused", "durableTick": 240, "tick": 240,
#     "calendar": { "tick": 240, "day": 11, "hour": 0, "dayOfSeason": 3, "dayOfYear": 10, "season": "summer", "year": 1 }, … }
```

### `PUT /api/civilizations/:id/speed` — operate

Body `{ "ticksPerSecond": n }`, integer 0–1000 (0 = as fast as possible). Applies
immediately, also while paused. The UI offers the presets 1, 2, 5, 10, 25, 50, 100 and
max (`SPEED_PRESETS`). Speed never changes results, only how fast ticks are executed.

### `POST /api/civilizations/:id/reset` — operate, [destructive](#destructive-actions)

Body `{ "confirm": "<name>" }`. Regenerates the world from the same seed and
configuration (tick 0, identical to the original genesis), deletes all events and
metric samples and re-inserts the genesis records, detaches every snapshot taken after
tick 0, clears any halt, and leaves the civilization `paused`. Stream subscribers
receive `reset`.

## World

### `GET /api/civilizations/:id/layout` — read

Static geography from the in-memory state (the civilization is loaded if necessary):
`{ map, buildings, households, asOfTick }`. `map` has `width, height, cols, rows,
blockSize, roadPitch, blocks[] (id, col, row, x, y, zone)`; each building has `id, kind,
name, blockId, x, y, width, height, capacity, door {x, y}`; each household `id, homeId,
surname`. For `demo-1` / 100 citizens: a 36 × 36 tile map with 51 buildings and 44
households.

### `GET /api/civilizations/:id/frame` — read

Current citizen positions from the in-memory state (same shape as a stream keyframe):

```json
{ "tick": 240, "calendar": { …, "season": "summer", "year": 1 }, "weather": "cloudy", "temperatureC": 18.8,
  "citizens": [[1, 0, 46, 0, 0, 0, 0], [2, 0, 46, 0, 0, 0, 0], …] }
```

Each citizen is a [frame tuple](#frame-tuples).

### `GET /api/civilizations/:id/citizens` — read

Offset-paginated list from the `citizen` projection.

| Query         | Type / bounds                                 | Default | Meaning                                                                                                                    |
| ------------- | --------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `search`      | string ≤ 80                                   | —       | digits only: exact citizen id; otherwise every word (max 4) must match the first or last name (case-insensitive substring) |
| `lifeStage`   | `child`, `adult`, `elder`                     | —       | filter                                                                                                                     |
| `activity`    | `sleeping`, `at_home`, `leisure`, `traveling` | —       | filter                                                                                                                     |
| `education`   | `none`, `primary`, `secondary`, `tertiary`    | —       | filter                                                                                                                     |
| `householdId` | integer 1–10,000,000                          | —       | filter                                                                                                                     |
| `sort`        | `id`, `name`, `balance`, `energy`, `age`      | `id`    | `name` = last, first; ties broken by id                                                                                    |
| `order`       | `asc`, `desc`                                 | `asc`   |                                                                                                                            |
| `limit`       | 1–200                                         | 50      |                                                                                                                            |
| `offset`      | 0–1,000,000                                   | 0       |                                                                                                                            |

```sh
curl -s "$API/api/civilizations/$ID/citizens?sort=balance&order=desc&limit=2"
```

```json
{ "items": [
    { "id": 17, "firstName": "Sana", "lastName": "Brennan", "ageYears": 28, "lifeStage": "adult",
      "education": "primary", "activity": "sleeping", "energy": 95.5, "balanceCents": 181209,
      "householdId": 7, "homeBuildingId": 39, "locationBuildingId": 39 }, … ],
  "total": 100, "limit": 2, "offset": 0, "asOfTick": 240 }
```

### `GET /api/civilizations/:id/citizens/:citizenId` — read

`CitizenDetail` = list item + `birthTick`, `personality` (five traits 0–1), `skills`
(five levels 0–100), `destinationBuildingId` (while travelling), `home {id, name}`,
`location {id, name, kind} | null`, `householdMembers[]` (other members), `asOfTick`.

```json
{ "id": 1, "firstName": "Victor", "lastName": "Wagner", "ageYears": 41, "lifeStage": "adult", …,
  "birthTick": -27356,
  "personality": { "openness": 0.532, "conscientiousness": 0.705, "extraversion": 0.613, "agreeableness": 0.382, "neuroticism": 0.219 },
  "skills": { "farming": 39.6, "baking": 42.6, "crafting": 44.8, "commerce": 48, "management": 78.8 },
  "destinationBuildingId": null, "home": { "id": 46, "name": "12 Willow Street" },
  "location": { "id": 46, "name": "12 Willow Street", "kind": "house" },
  "householdMembers": [{ "id": 2, "firstName": "Alba", "lastName": "Wagner", "ageYears": 40 }], "asOfTick": 240 }
```

### `GET /api/civilizations/:id/buildings` — read

| Query    | Type / bounds            | Default | Meaning                                |
| -------- | ------------------------ | ------- | -------------------------------------- |
| `kind`   | `house`, `plaza`, `park` | —       | filter                                 |
| `search` | string ≤ 80              | —       | case-insensitive substring of the name |
| `limit`  | 1–500                    | 100     |                                        |
| `offset` | 0–1,000,000              | 0       |                                        |

Ordered by id. Items: `id, kind, name, x, y, width, height, capacity`.

```json
{
  "items": [
    {
      "id": 1,
      "kind": "plaza",
      "name": "Central Plaza",
      "x": 8,
      "y": 15,
      "width": 6,
      "height": 6,
      "capacity": 40
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0,
  "asOfTick": 240
}
```

### `GET /api/civilizations/:id/buildings/:buildingId` — read

`BuildingDetail` = list item + `residents[]` (citizens whose home it is) and
`occupants[]` (citizens currently inside), each `{ id, firstName, lastName, activity }`
and at most 500, plus `asOfTick`.

## History

### `GET /api/civilizations/:id/events` — read

Keyset-paginated event log (only durable events).

| Query                                    | Type / bounds               | Default | Meaning                                               |
| ---------------------------------------- | --------------------------- | ------- | ----------------------------------------------------- |
| `before`                                 | integer ≥ 1                 | —       | events with `seq < before`, newest first              |
| `after`                                  | integer ≥ 0                 | —       | events with `seq > after`, oldest first               |
| `limit`                                  | 1–500                       | 100     |                                                       |
| `types`                                  | comma-separated event types | all     | must be types from the catalogue                      |
| `citizenId`, `buildingId`, `householdId` | integer 1–10,000,000        | —       | only events that reference this entity (any role)     |
| `fromTick`, `toTick`                     | integer 0–2,000,000,000     | —       | inclusive tick range; `fromTick > toTick` is rejected |

Without a cursor the newest events come first. `before` and `after` are mutually
exclusive. Response `{ items: EventDto[], nextCursor }`, with `EventDto = { seq, tick,
type, payload, refs: [{ kind, id, role }], causeSeq }`.

```sh
curl -s "$API/api/civilizations/$ID/events?limit=3"
# → { "items": [ { "seq": 174, "tick": 216, "type": "WeatherChanged",
#                  "payload": { "to": "cloudy", "from": "clear", "dailyMeanTempC": 21.4 }, "refs": [], "causeSeq": null },
#                { "seq": 173, … }, { "seq": 172, "tick": 168, "type": "SeasonStarted", … } ],
#     "nextCursor": 172 }
curl -s "$API/api/civilizations/$ID/events?limit=3&before=172"     # next (older) page
curl -s "$API/api/civilizations/$ID/events?citizenId=1&after=0"     # a citizen's history, oldest first
# → CitizenCreated (seq 2), then MoneyIssued (seq 3, causeSeq 2)
```

### `GET /api/civilizations/:id/metrics` — read

Metric series for charts, downsampled to at most `maxPoints` rows by metric kind (see
[ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#downsampling-of-metric-series)).

| Query                | Type / bounds               | Default     |
| -------------------- | --------------------------- | ----------- |
| `keys`               | comma-separated metric keys | all metrics |
| `fromTick`, `toTick` | integer 0–2,000,000,000     | all         |
| `maxPoints`          | 10–5000                     | 600         |

Response `{ keys, rows, bucketTicks, fromTick, toTick }`; each row is
`[tick, value₁, value₂, …]` in `keys` order.

```sh
curl -s "$API/api/civilizations/$ID/metrics?keys=population.total,activity.leisure,needs.lowEnergyShare&fromTick=10&toTick=13"
```

```json
{
  "keys": ["population.total", "activity.leisure", "needs.lowEnergyShare"],
  "rows": [
    [10, 100, 8, 0],
    [11, 100, 16, 0],
    [12, 100, 18, 0],
    [13, 100, 14, 0]
  ],
  "bucketTicks": 1,
  "fromTick": 10,
  "toTick": 13
}
```

With `maxPoints=10` over 241 samples the response has `bucketTicks: 25` and 10 rows
stamped 24, 49, 74, …. Metric definitions: [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#metrics).

### `GET /api/civilizations/:id/audit` — read

Control actions, newest first. Query `before` (id cursor) and `limit` (1–200, default
50). Response `{ items: [{ id, action, actor, tick, details, createdAt }], nextCursor }`.

```json
{
  "items": [
    {
      "id": 8,
      "action": "simulation.paused",
      "actor": "operator",
      "tick": 292,
      "details": {},
      "createdAt": "…"
    },
    {
      "id": 7,
      "action": "simulation.started",
      "actor": "operator",
      "tick": 240,
      "details": { "speed": 25 },
      "createdAt": "…"
    },
    {
      "id": 6,
      "action": "simulation.speed_changed",
      "actor": "operator",
      "tick": 240,
      "details": { "ticksPerSecond": 25 },
      "createdAt": "…"
    }
  ],
  "nextCursor": 6
}
```

## Snapshots

### `GET /api/civilizations/:id/snapshots` — read

`{ items: SnapshotDto[] }`, newest first, at most 500. `SnapshotDto = { id, name, note,
tick, stateHash, sizeBytes, createdAt, detachedAt }`.

### `POST /api/civilizations/:id/snapshots` — operate

Body `{ "name": <same rules as a civilization name>, "note"?: string ≤ 500 }`. Writes a
checkpoint of the current tick, then stores an immutable copy of that state. `201
SnapshotDto`; `409 CONFLICT` for a duplicate name; `409 HALTED` when halted.

```sh
curl -s -X POST $API/api/civilizations/$ID/snapshots -H "$AUTH" -H "$JSON" \
  -d '{"name":"day 11","note":"before the experiment"}'
# → { "id": "5eebddfa-…", "name": "day 11", "note": "before the experiment", "tick": 240,
#     "stateHash": "a0aac4798d1ec307007ff36a7c006d26", "sizeBytes": 56768, "createdAt": "…", "detachedAt": null }
```

### `POST /api/civilizations/:id/snapshots/:snapshotId/restore` — operate, [destructive](#destructive-actions)

Body `{ "confirm": "<exact civilization name>" }`. Rewinds the civilization to the
snapshot: the state is loaded, schema-validated, hash-verified and invariant-checked;
events and metric samples after the snapshot are deleted; snapshots taken after it are
marked `detachedAt` (they belong to the abandoned timeline and cannot be restored in
place — `409 CONFLICT`); status becomes `paused`. The restored state's hash equals the
snapshot's `stateHash`, and continuing reproduces the original continuation exactly.

```sh
curl -s -X POST $API/api/civilizations/$ID/snapshots/$SNAPSHOT/restore -H "$AUTH" -H "$JSON" -d '{}'
# → 400 { "error": { "code": "CONFIRMATION_REQUIRED", "message": "This action is destructive: send { \"confirm\": \"<exact civilization name>\" }" } }
curl -s -X POST $API/api/civilizations/$ID/snapshots/$SNAPSHOT/restore -H "$AUTH" -H "$JSON" -d '{"confirm":"Demo One"}'
# → 200 { …, "status": "paused", "tick": 240, "durableTick": 240, … }
```

## Exports

Downloads with `content-disposition: attachment` and `cache-control: no-store`. Each
export is cut at the durable checkpoint observed when it starts. Large exports are
streamed in pages, so server memory stays bounded.

| Endpoint                            | Query                         | Content                                                                                                                                                      |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET …/export/config` — read        | —                             | `ConfigExport` JSON: `format: "civ-config"`, `formatVersion: 1`, `name, seed, engineVersion, configSchemaVersion, config, exportedAtTick, stateHashAtExport` |
| `GET …/export/metrics.csv` — read   | `keys`, `fromTick`, `toTick`  | raw samples (never downsampled): header `tick,<keys…>`, one row per sampled tick                                                                             |
| `GET …/export/events.ndjson` — read | `types`, `fromTick`, `toTick` | one `EventDto` JSON per line, ascending `seq`                                                                                                                |

```sh
curl -s "$API/api/civilizations/$ID/export/metrics.csv?keys=population.total,environment.temperatureC&toTick=3"
# tick,population.total,environment.temperatureC
# 0,100,8.1
# 1,100,7.6
# 2,100,7.1
# 3,100,7.1
```

The config export is what [EXPERIMENTS.md](EXPERIMENTS.md) uses to reproduce a run.

---

## WebSocket stream

`GET /api/civilizations/:id/stream` (WebSocket upgrade; `read` auth, token via
`?token=` from browsers). The civilization is resolved and authorised **before** the
upgrade, so an unknown id gets a plain `404` and a bad token `401`/`403`. A plain
(non-upgrade) `GET` returns `400`. The stream is server → client only; anything a
client sends is ignored (maximum client frame 4 KiB).

```js
const ws = new WebSocket(`ws://127.0.0.1:3001/api/civilizations/${id}/stream?token=${token}`);
```

### Message types

Every message is one JSON object with a `type` (`StreamMessage` in
`packages/shared/src/stream.ts`):

| `type`       | Fields                                                                                | Sent                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `hello`      | `civilizationId`, `status`, `speed`, `tick`, `durableTick`, `haltReason`, `lastError` | once, first, on connect                                                                                |
| `keyframe`   | `tick`, `calendar`, `weather`, `temperatureC`, `citizens` (all tuples)                | after `hello` (immediately or within one frame interval), after `reset`, and to resynchronise a client |
| `delta`      | same fields; `citizens` holds only tuples that changed since the previous frame       | at most `FRAME_RATE` times per second while ticks advance                                              |
| `events`     | `events: EventDto[]` (≤ 200), `dropped`                                               | batched with frames; **live**, not yet durable                                                         |
| `status`     | same fields as `hello` minus `civilizationId`                                         | on start, pause, speed change, halt, persistence error, after a reset                                  |
| `checkpoint` | `tick`                                                                                | when a checkpoint commits (the new durable tick)                                                       |
| `reset`      | `tick`                                                                                | the world was replaced (snapshot restore, reset, or reload after a halt)                               |
| `deleted`    | —                                                                                     | the civilization was deleted; the server then closes with code 1000                                    |

A real sequence (connect to a paused civilization at tick 292, step 3 ticks, then
reset):

```
hello      status=paused tick=292 durableTick=292 speed=25
keyframe   tick=292 citizens=100
checkpoint tick=295
delta      tick=295 citizens=87        ← only the 87 tuples that changed
reset      tick=0
keyframe   tick=0 citizens=100
status     status=paused tick=0 durableTick=0
```

### Frame tuples

`[id, activityCode, locationId, fromId, toId, departTick, arriveTick]` — activity codes
`0 sleeping, 1 at_home, 2 leisure, 3 traveling`; `locationId` is 0 while travelling;
the trip fields are 0 when not travelling. A client draws a travelling citizen at
fraction `(t − departTick) / (arriveTick − departTick)` along
`roadRoute(from.door, to.door)` (exported by `@civ/sim-core`, the same route the engine
used to compute the travel time), with the doors taken from the layout.

### Frame rate and deltas

- Frames are computed once per civilization and broadcast to every subscriber, at most
  `FRAME_RATE` times per second (`1–30`, default 5; interval `round(1000 / FRAME_RATE)`
  ms) **independently of the simulation speed**. At high speeds a frame skips ticks; it
  always shows the current state.
- A delta is relative to the previous frame. Deltas cannot express removed citizens;
  if one disappeared, every client gets a keyframe instead.
- No frame is sent when nothing advanced and no events are pending.

### Live events

Events are streamed as soon as the engine emits them, **before they are durable**. At
most 200 are sent per message; if more accumulated since the previous frame the most
recent 200 are kept and the rest are counted in `dropped`. The REST endpoint
`/events` is the durable, complete record — use it for anything that must be exact.

### Backpressure

A client whose socket buffer holds more than 1 MiB is congested: it is skipped for
deltas and events (the skipped events are added to its `dropped` count) and marked
out of sync. Once its buffer drains it receives a fresh keyframe, so a delta is never
applied to a stale base. Clients are pinged every 30 s; a client that misses a pong is
terminated.

### Reset semantics

On `reset` a client must discard its live event list and frame baseline, refetch the
layout and any lists or history it shows (the REST history was rewritten), and wait
for the keyframe that follows. Live events that were streamed before a halt or a
rewind may describe ticks that no longer exist.
