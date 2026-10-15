# HTTP and WebSocket API

The contract lives in `packages/shared`: `src/routes.ts` (`API_ROUTES`, the exact list of
endpoints — the server registers exactly these), `src/api.ts` (Zod request schemas and
response types) and `src/stream.ts` (WebSocket messages). The server implementation is
in `apps/server/src/routes/` and `apps/server/src/ws/stream.ts`.

All examples below are real responses from the production build of the server
(`node apps/server/dist/index.js`, `AUTH_MODE=token` with both tokens set, seed
`demo-1`, 100 citizens), recorded on 2026-10-15 (engine `0.2.0` results; the build at the time still reported
`0.1.0`, the only difference in these responses) and shortened where marked with `…`. Ids, timestamps and the ticks reached
while running in real time differ from run to run; hashes, metrics, names and every
other simulation value are reproducible.

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
- Integer query parameters (`limit`, `offset`, `before`, `after`, `fromTick`, `toTick`,
  `citizenId`, `buildingId`, `householdId`, `maxPoints`) accept only decimal digits
  (surrounding whitespace is ignored). An empty, blank or non-decimal value (`?toTick=`,
  `1.5`, `0x10`, `-1`) is `400 VALIDATION_ERROR` ("Expected a non-negative integer"),
  never read as 0; omit a parameter to use its default.
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

Configured by environment variables (see [DEPLOYMENT.md](DEPLOYMENT.md#authentication));
implemented in `apps/server/src/auth/auth.ts`.

| Mode                 | Who can do what                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_MODE=disabled` | Every request acts as operator `local-dev`. Accepted **only** when `HOST` is a loopback address (`127.0.0.1`, `localhost`, `::1`); the server refuses to start otherwise. Requests must also be addressed to a loopback host (below). |
| `AUTH_MODE=token`    | `Authorization: Bearer <token>`. The `OPERATOR_TOKEN` may read and mutate. If `VIEWER_TOKEN` is set, reads require the viewer or operator token; if it is not set, reads are open to anonymous clients.                               |

Each route has an auth level, the `auth` column of `API_ROUTES`:

- `public` — no token ever: `GET /api/health`, `GET /api/meta`.
- `read` — every other `GET` (including the stream).
- `operate` — every `POST`, `PUT` and `DELETE`.

**Access is decided from the route the server matched, not from the URL text.**
Percent-encoded paths (`/%61pi/civilizations/…` reaches `/api/civilizations/…`) and
absolute-form request targets (`GET http://host/api/…`) therefore get exactly the
`401`/`403` of the canonical path. `HEAD` uses the level of the `GET` route. A route under
`/api` that is missing from `API_ROUTES` requires the operator (fail closed); unknown
routes are `404 NOT_FOUND`.

Resolution of a request in token mode: a wrong token → `401 UNAUTHORIZED` ("Invalid
token"); no token while `VIEWER_TOKEN` is set → `401` ("A token is required to read this
server"); a mutation without a token → `401`; a mutation with the viewer token →
`403 FORBIDDEN` ("Operator token required for this action"). Tokens are compared in
constant time.

**Tokens go in the `Authorization` header.** Browsers cannot set headers on WebSocket
connections, so WebSocket upgrade requests of `GET /api/civilizations/:id/stream` (and
only those) also accept `?token=<token>`; the value is redacted from logs. On every other
request a `?token=` is ignored, so the request counts as unauthenticated:

```sh
curl -s "$API/api/civilizations?token=$OPERATOR_TOKEN"
# → 401 { "error": { "code": "UNAUTHORIZED", "message": "A token is required to read this server" } }
```

**With `AUTH_MODE=disabled` only local requests are served.** Binding to loopback keeps
other machines out, but a web page in your browser could rebind its own host name to
`127.0.0.1` and call the server as a same-origin request (DNS rebinding). So every
request — reads, mutations, CORS preflights and WebSocket upgrades, even
`/api/health` — must carry a `Host` header naming a loopback host (`localhost`,
`*.localhost`, `127.0.0.0/8` or `[::1]`, any port), and an `Origin` header, when present,
must be a loopback `http(s)` origin or one of `CORS_ORIGINS` (the opaque origin `null` is
rejected). Otherwise:

```sh
curl -s $API/api/civilizations -H 'Host: rebind.example:3001'
# → 403 { "error": { "code": "FORBIDDEN", "message": "With AUTH_MODE=disabled the server only answers requests addressed to a loopback host (localhost, 127.0.0.1 or [::1])" } }
curl -s $API/api/civilizations -H 'Origin: http://rebind.example'
# → 403 { "error": { "code": "FORBIDDEN", "message": "With AUTH_MODE=disabled the server only accepts browser requests from loopback origins or CORS_ORIGINS" } }
```

Opening the development UI through a LAN address or another host name therefore needs
token mode. Disabled mode still trusts every process on the same machine.

CORS allows the origins in `CORS_ORIGINS` with methods `GET, POST, PUT, DELETE`, headers
`Authorization, Content-Type`, and exposes `Content-Disposition`. The actor recorded in
the audit log is `operator`, `viewer`, `anonymous` or `local-dev` (`engine` and `system`
for entries the server writes itself).

The API has no endpoint that reports the role of a token. The web UI learns it from
the server's answers (a `403` to an operator action means a viewer token; a successful
operator action means the operator token) and remembers it per token in the browser.

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

| Code                    | HTTP | When                                                                                                                                                                                                   |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`      | 400  | invalid path, query or body (`details` lists the issues); malformed JSON. Payload-too-large (413) and unsupported media type (415) keep their HTTP status with this code.                              |
| `CONFIRMATION_REQUIRED` | 400  | a destructive action without `confirm`, or with a name that does not match exactly                                                                                                                     |
| `UNAUTHORIZED`          | 401  | missing or invalid token (including a `?token=` on anything but a stream upgrade)                                                                                                                      |
| `FORBIDDEN`             | 403  | the viewer token used for a mutation; with `AUTH_MODE=disabled`, a non-loopback `Host` or an untrusted `Origin`                                                                                        |
| `NOT_FOUND`             | 404  | unknown civilization, citizen, building, snapshot or route                                                                                                                                             |
| `CONFLICT`              | 409  | duplicate civilization or snapshot name; stepping while running; restoring a detached snapshot; a stored state of another state schema version (`Checkpoint uses state schema X; this server reads Y`) |
| `HALTED`                | 409  | start, step or snapshot on a halted civilization                                                                                                                                                       |
| `INTERNAL`              | 500  | unexpected failures, a failed write, a [stored state that cannot be loaded](#unloadable-stored-state)                                                                                                  |
| `UNAVAILABLE`           | 503  | the server is at capacity (too many live stream connections); retry later                                                                                                                              |

Messages of `500` errors caused by the database or another infrastructure failure
never contain driver output. They read `<what> (<kind>; ref <8 hex>)`, for example
`Checkpoint failed (database error P1001; ref 3f9c2a1b)`, where _what_ is one of
`Checkpoint failed`, `Saving the status failed`, `Runner loop failed`,
`Recording the halt failed`, `Reloading the last checkpoint failed` or
`Loading the civilization failed`, and _kind_ is `database error <Prisma code>`,
`database error`, `database unreachable` or `unexpected error`. The server log holds
the full error under the same `errorRef`. The same format is used for `lastError` in
summaries and stream messages.

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
`simulation.halted` (actor `engine`, details with the `reason` and the violations), and
reloads the last durable checkpoint. `start`, `step` and snapshot creation then return
`409 HALTED`; reads, `pause`, speed changes, snapshot restore, reset and delete still
work. Restore and reset clear the halt. A halt that has not been recorded yet when a
restore or reset commits (for example, one detected while the restore read its
snapshot) is written as `simulation.halted` in the rewind's transaction, before the
`snapshot.restored` or `simulation.reset` entry.

### Unloadable stored state

If a civilization's stored checkpoint cannot be used — a corrupt or non-gzip blob, a
failed hash or schema verification, an invariant violation, or a missing checkpoint —
every request that needs the world (layout, frame, control, snapshot creation, stream) returns
`500 INTERNAL` "The stored state could not be loaded: _reason_". The civilization is
marked `status: halted` with `haltReason` "Stored state could not be loaded: _reason_.
Restore a snapshot or reset.", and one `simulation.state_unloadable` audit entry (actor
`system`) is written per distinct reason, so lists show the problem. **`POST …/reset`
and `POST …/snapshots/:snapshotId/restore` work in this state and recover it**: reset
regenerates the world from the seed and configuration in the database, restore uses
the verified snapshot; neither needs the corrupt checkpoint. Their audit details then
include `recoveredFromUnloadableState: true` and `fromTick`. Delete also works.

A checkpoint written with a different state schema version is not treated as corrupt:
it returns `409 CONFLICT` ("Checkpoint uses state schema X; this server reads Y") and is
not marked halted, because a server with the matching version can read it.

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
  "engineVersion": "0.2.0",
  "authMode": "token",
  "readRequiresToken": true,
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
dayOfYear, season, year`), `population`, `engineVersion`, `haltReason`, `lastError` (the
last persistence failure while it is unresolved, in the client-safe format described
under [errors](#errors)), `loaded` (whether a runner holds it in memory; paused runners
nobody uses are unloaded after 15 minutes), `createdAt`, `updatedAt`.

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
{ "id": "6dfb1e4c-edf2-4709-a429-9003aa0419af", "name": "Demo One", "seed": "demo-1",
  "status": "paused", "speed": 5, "durableTick": 0, "tick": 0,
  "calendar": { "tick": 0, "day": 1, "hour": 0, "dayOfSeason": 0, "dayOfYear": 0, "season": "spring", "year": 1 },
  "population": 100, "engineVersion": "0.2.0", "haltReason": null, "lastError": null, "loaded": true, …,
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

Control actions are atomic: `start`, `pause`, `step` and speed changes write their state
change and their audit entry (`simulation.started`, `simulation.paused`,
`simulation.stepped`, `simulation.speed_changed`) in one transaction, and the server
changes the running simulation only after that commit. If the write fails the action
returns `500 INTERNAL` and nothing changes: `start` does not start the loop and the
speed stays as it was. A failed `step` keeps its ticks in memory and writes them with
the next successful checkpoint.

### `POST /api/civilizations/:id/control` — operate

Body (discriminated by `action`):

| Body                               | Effect                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "action": "start" }`            | runs the background tick loop at the civilization's speed; no-op if already running; `409 HALTED` if halted                                                 |
| `{ "action": "pause" }`            | stops the loop and makes `paused` durable (a checkpoint, or a status-only write when nothing is uncommitted); also retries persistence after a failed write |
| `{ "action": "step", "steps": n }` | `n` = 1–1000 (default 1) ticks on a paused civilization, then a checkpoint; `409 CONFLICT` while running                                                    |

Steps run in time slices of about 12 ms (the budget is checked after each tick) so
other requests stay responsive; at the maximum population of 5,000 a single tick can
take 15–40 ms. If an invariant fails during a step, the response is `200` with
`status: "halted"`.

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
receive `reset`. The audit entry `simulation.reset` records `fromTick` and the genesis
`stateHash`, e.g. `{ "fromTick": 293, "stateHash": "3815410543285c0938f9569f681be08d" }`.
Reset also [recovers an unloadable stored state](#unloadable-stored-state).

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

| Query         | Type / bounds                                 | Default | Meaning                                                                                                                                                                |
| ------------- | --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`      | string ≤ 80                                   | —       | digits only: exact citizen id; otherwise every word (max 4) must match the first or last name (case-insensitive literal substring: `%`, `_` and `\` are not wildcards) |
| `lifeStage`   | `child`, `adult`, `elder`                     | —       | filter                                                                                                                                                                 |
| `activity`    | `sleeping`, `at_home`, `leisure`, `traveling` | —       | filter                                                                                                                                                                 |
| `education`   | `none`, `primary`, `secondary`, `tertiary`    | —       | filter                                                                                                                                                                 |
| `householdId` | integer 1–10,000,000                          | —       | filter                                                                                                                                                                 |
| `sort`        | `id`, `name`, `balance`, `energy`, `age`      | `id`    | `name` = last, first; ties broken by id                                                                                                                                |
| `order`       | `asc`, `desc`                                 | `asc`   |                                                                                                                                                                        |
| `limit`       | 1–200                                         | 50      |                                                                                                                                                                        |
| `offset`      | 0–1,000,000                                   | 0       |                                                                                                                                                                        |

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
  "destinationBuildingId": null, "home": { "id": 46, "name": "67 Elm Street" },
  "location": { "id": 46, "name": "67 Elm Street", "kind": "house" },
  "householdMembers": [{ "id": 2, "firstName": "Alba", "lastName": "Wagner", "ageYears": 40 }], "asOfTick": 240 }
```

### `GET /api/civilizations/:id/buildings` — read

| Query    | Type / bounds            | Default | Meaning                                                                             |
| -------- | ------------------------ | ------- | ----------------------------------------------------------------------------------- |
| `kind`   | `house`, `plaza`, `park` | —       | filter                                                                              |
| `search` | string ≤ 80              | —       | case-insensitive literal substring of the name (`%`, `_` and `\` are not wildcards) |
| `limit`  | 1–500                    | 100     |                                                                                     |
| `offset` | 0–1,000,000              | 0       |                                                                                     |

Ordered by id. Items: `id, kind, name, x, y, width, height, capacity`.

```json
{
  "items": [
    {
      "id": 1,
      "kind": "plaza",
      "name": "Central Plaza",
      "x": 15,
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
    [10, 100, 10, 0],
    [11, 100, 17, 0],
    [12, 100, 18, 0],
    [13, 100, 15, 0]
  ],
  "bucketTicks": 1,
  "fromTick": 10,
  "toTick": 13
}
```

With `maxPoints=10` over 241 samples the response has `bucketTicks: 25` and 10 rows
stamped 24, 49, 74, …, 224 and 240 (the last bucket holds ticks 225–240). Metric definitions: [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#metrics).

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
      "tick": 290,
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
# → { "id": "f47259d5-…", "name": "day 11", "note": "before the experiment", "tick": 240,
#     "stateHash": "1273ba1173fad918ccc81e4d7cf0ac37", "sizeBytes": 56767, "createdAt": "…", "detachedAt": null }
```

### `POST /api/civilizations/:id/snapshots/:snapshotId/restore` — operate, [destructive](#destructive-actions)

Body `{ "confirm": "<exact civilization name>" }`. Rewinds the civilization to the
snapshot: the state is loaded, schema-validated, hash-verified and invariant-checked;
events and metric samples after the snapshot are deleted; snapshots taken after it are
marked `detachedAt` (they belong to the abandoned timeline and cannot be restored in
place — `409 CONFLICT`); status becomes `paused`. The restored state's hash equals the
snapshot's `stateHash`, and continuing reproduces the original continuation exactly.
The audit entry `snapshot.restored` records `snapshotId`, `name`, `fromTick`, `toTick` and the
`stateHash`. Restore also
[recovers an unloadable stored state](#unloadable-stored-state).

```sh
curl -s -X POST $API/api/civilizations/$ID/snapshots/$SNAPSHOT/restore -H "$AUTH" -H "$JSON" -d '{}'
# → 400 { "error": { "code": "CONFIRMATION_REQUIRED", "message": "This action is destructive: send { \"confirm\": \"<exact civilization name>\" }" } }
curl -s -X POST $API/api/civilizations/$ID/snapshots/$SNAPSHOT/restore -H "$AUTH" -H "$JSON" -d '{"confirm":"Demo One"}'
# → 200 { …, "status": "paused", "tick": 240, "durableTick": 240, … }
```

## Exports

Downloads with `content-disposition: attachment` and `cache-control: no-store`. Each
export is cut at the durable checkpoint observed when it starts, so rows committed by
later checkpoints are not included. Large exports are streamed in pages, so server
memory stays bounded. **If a snapshot restore, a reset or a delete commits while an
export streams, the transfer is aborted** (the connection is reset and the chunked body
is incomplete, so `curl` reports an error): a file is either one consistent timeline or
visibly incomplete, never a silently shortened or spliced one. Download it again.

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
`?token=` from browsers or the `Authorization` header). The civilization is resolved
and authorised **before** the upgrade, so an unknown id gets a plain `404` and a bad
token `401`/`403`. A plain (non-upgrade) `GET` returns `400` ("This endpoint requires a
WebSocket upgrade"). The stream is server → client only; anything a client sends is
ignored (maximum client frame 4 KiB).

**Connection limits.** The server accepts at most `STREAM_MAX_CONNECTIONS` live streams
in total (default 256) and `STREAM_MAX_CONNECTIONS_PER_ADDRESS` per client IP address
(default 32; behind a reverse proxy this is per proxy address). Over a limit the upgrade
is refused with `503 UNAVAILABLE` ("Too many live stream connections; try again later")
before the civilization is loaded; a connection that races past the check is closed
right after the upgrade with WebSocket close code `1013` (try again later).

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

A real sequence (connect to a paused civilization at tick 252, noon of day 11, step 3
ticks, then reset):

```
hello      status=paused tick=252 durableTick=252 speed=25
keyframe   tick=252 citizens=100
checkpoint tick=255
delta      tick=255 citizens=31        ← only the 31 tuples that changed
reset      tick=0
keyframe   tick=0 citizens=100
status     status=paused tick=0 durableTick=0 speed=25
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
applied to a stale base. A client that stays congested continuously for 10 s
(`STALLED_CLIENT_MS`, checked when frames are sent) is disconnected, so a client that
stops reading cannot pin server memory. Clients are pinged every 30 s; a client that
misses a pong is terminated.

### Reset semantics

On `reset` a client must discard its live event list and frame baseline, refetch the
layout and any lists or history it shows (the REST history was rewritten), and wait
for the keyframe that follows. Live events that were streamed before a halt or a
rewind may describe ticks that no longer exist.
