# Experiments and reproducibility

A run of Digital Civilization in a Jar is fully determined by **engine version, seed,
configuration and number of ticks** (see
[SIMULATION_RULES.md](SIMULATION_RULES.md#randomness-and-reproducibility)). This
walkthrough shows that with real values, first with the engine alone and then through
the API, and explains what reproducibility does and does not promise.

Every number on this page was produced by running the code (engine `0.2.0`, Node
v22.22.0) on 2026-10-15. Re-run the script to check them on your machine.

> **Engine `0.2.0` changed results.** Outings became time- and energy-aware and houses
> were renumbered (see [SIMULATION_RULES.md](SIMULATION_RULES.md#venue-choice)), so every
> hash and most activity metrics differ from engine `0.1.0`. Two intermediate commits
> (`88d349b`, `2175f7f`) already produced these `0.2.0` results while still reporting
> `0.1.0`.

## 1. Engine-only walkthrough

The script `scripts/reproduce-demo.ts` creates the world for seed `demo-1` with 100
citizens (all other parameters at their defaults), runs it to tick 240 (10 days) and
prints hashes, metrics, event counts and three checks. It needs no database.

```sh
pnpm --filter @civ/sim-core exec tsx ../../scripts/reproduce-demo.ts            # seed demo-1, 100 citizens
pnpm --filter @civ/sim-core exec tsx ../../scripts/reproduce-demo.ts my-seed 500
```

(`tsx` is a dependency of `@civ/sim-core`, hence the `--filter`; the path is relative to
`packages/sim-core`.) The script exits with code 1 if check 1 or 2 fails.

### The world at genesis

```
map 36×36 tiles, 5×5 blocks (farmland 8, residential 13, civic 2, commercial 2)
buildings 51 (plaza 1, park 1, house 49), vacant houses 5
households 44, citizens 100, money issued 3727849 cents
```

### State hashes

| Tick | Calendar           | State hash                         |
| ---- | ------------------ | ---------------------------------- |
| 0    | Y1 spring D1 00:00 | `3815410543285c0938f9569f681be08d` |
| 24   | Y1 spring D2 00:00 | `cc32f72331d7ee6df5eb05e6ca31ffb8` |
| 240  | Y1 summer D4 00:00 | `1273ba1173fad918ccc81e4d7cf0ac37` |

The hash is `cyrb128` of the canonical JSON of the complete world state (sorted keys,
no whitespace), so any difference anywhere in the state — one cent, one energy point,
one citizen's location — changes it.

### Metrics

Ticks 0, 24 and 240 are midnight (everyone asleep); ticks 12 and 228 are noon.

| Metric                     | Tick 0   | Tick 12  | Tick 24  | Tick 228 | Tick 240 |
| -------------------------- | -------- | -------- | -------- | -------- | -------- |
| `population.total`         | 100      | 100      | 100      | 100      | 100      |
| `population.children`      | 32       | 32       | 32       | 32       | 32       |
| `population.adults`        | 55       | 55       | 55       | 55       | 55       |
| `population.elders`        | 13       | 13       | 13       | 13       | 13       |
| `activity.sleeping`        | 100      | 0        | 100      | 0        | 100      |
| `activity.atHome`          | 0        | 74       | 0        | 78       | 0        |
| `activity.leisure`         | 0        | 18       | 0        | 14       | 0        |
| `activity.traveling`       | 0        | 8        | 0        | 8        | 0        |
| `needs.energyMean`         | 76.749   | 90.78    | 89.06    | 90.7875  | 90.16125 |
| `money.supply`             | 3727849  | 3727849  | 3727849  | 3727849  | 3727849  |
| `wealth.medianAdult`       | 44158    | 44158    | 44158    | 44158    | 44158    |
| `wealth.giniAdult`         | 0.341035 | 0.341035 | 0.341035 | 0.341035 | 0.341035 |
| `environment.temperatureC` | 8.1      | 14.6     | 9.5      | 24.9     | 18.8     |

The money and wealth metrics are constant because Phase 1 has no transactions (see
[ECONOMIC_MODEL.md](ECONOMIC_MODEL.md)). Money supply equals money issued, as the
conservation invariant requires.

### Events from genesis through tick 240

| Type                  | Count |
| --------------------- | ----- |
| `CivilizationFounded` | 1     |
| `CitizenCreated`      | 100   |
| `MoneyIssued`         | 68    |
| `SeasonStarted`       | 1     |
| `WeatherChanged`      | 4     |

Next event seq: 175. Weather at tick 240: cloudy. `MoneyIssued` = 68 = the 55 adults and
13 elders (children receive no endowment). No citizen crossed a life-stage threshold
in these 10 days.

### The three checks

```
[1] Second independent run, identical hashes at 0/24/240: true
[2] Restored from tick 24, continued to tick 240: hash 1273ba1173fad918ccc81e4d7cf0ac37 (matches: true)
[3] Same seed, stochastic weather off:
    tick   0: d9bf063f1363a0145e71269afeb9f1cb (same as default: false)
    tick  24: 5e4faba96ad823476e3527b823e77148 (same as default: false)
    tick 240: 7a2d284ce2e284ef3bae3ed8a32c021c (same as default: false)
    citizens identical at genesis: true
    citizens whose state differs at tick 240: 8 of 100
    citizen-hours at venues over ticks 0–240: default 1690, weather off 1942
```

1. **Repeatability**: an independent second run gives the same hashes.
2. **Snapshot continuation**: serialising the state at tick 24, restoring it (with hash
   verification) and continuing gives exactly the original tick-240 state. No random
   generator state is saved; streams are keyed by tick and citizen.
3. **Same seed is not the same experiment.** Turning stochastic weather off changes the
   hash from tick 0 (the configuration is part of the state, and the genesis day's
   temperature is no longer drawn), although the generated citizens are identical.
   By tick 240, 8 of the 100 citizens are in a different state, and citizens spent
   1,942 instead of 1,690 hours at venues (no rain or cloud discouraged outings).

## 2. The same run through the API

The server uses the same engine, so the same seed and configuration give the same
hashes. Against a running server (`pnpm dev`, or the container — add
`-H "Authorization: Bearer $OPERATOR_TOKEN"` to every request in token mode):

```sh
API=http://127.0.0.1:3001
ID=$(curl -s -X POST $API/api/civilizations -H 'content-type: application/json' \
  -d '{"name":"Demo One","seed":"demo-1","config":{"population":100}}' | jq -r .id)

curl -s -X POST $API/api/civilizations/$ID/control -H 'content-type: application/json' \
  -d '{"action":"step","steps":240}' | jq '{tick, durableTick}'
# { "tick": 240, "durableTick": 240 }

curl -s $API/api/civilizations/$ID/export/config | jq '{seed, config, exportedAtTick, stateHashAtExport}'
# "exportedAtTick": 240, "stateHashAtExport": "1273ba1173fad918ccc81e4d7cf0ac37"
```

This was run against the production build of the server (`AUTH_MODE=token`, on
2026-10-15): the durable state hash at tick 240 is `1273ba1173fad918ccc81e4d7cf0ac37`,
identical to the engine-only run.
Further steps confirmed through the API:

- A snapshot taken at tick 240 recorded `stateHash` `1273ba11…ac37`; after stepping 24
  more ticks and restoring it (`{"confirm":"Demo One"}`), the exported hash was again
  `1273ba11…ac37`.
- The metric series (`GET …/metrics?fromTick=10&toTick=13`) gave
  `activity.leisure` = 10, 17, 18, 15 for ticks 10–13 — the same values the engine
  computes.

How the ticks were executed does not matter: stepping, running at any speed,
pausing, checkpointing or restarting the server in between all reach the same state
at a given tick.

### Recreating a run from its exported configuration

`GET …/export/config` returns everything needed to recreate genesis:

```json
{
  "format": "civ-config",
  "formatVersion": 1,
  "name": "Demo One",
  "seed": "demo-1",
  "engineVersion": "0.2.0",
  "configSchemaVersion": 1,
  "config": {
    "population": 100,
    "daysPerSeason": 7,
    "initialWealth": { "meanCents": 50000, "spread": 0.5 },
    "lifeStages": { "adultAge": 18, "elderAge": 65 },
    "movement": { "walkTilesPerTick": 24 },
    "stochastic": { "weather": true },
    "metricsInterval": 1
  },
  "exportedAtTick": 240,
  "stateHashAtExport": "1273ba1173fad918ccc81e4d7cf0ac37"
}
```

To reproduce it, create a civilization with the same `seed` and `config` (any name)
on a server with the same `engineVersion`, step to `exportedAtTick`, and compare the
new export's `stateHashAtExport`. A mismatch means a different engine version, a
modified configuration, or a bug — please report it.

## 3. What reproducibility does not give you

- **Different engine versions** may produce different results; `engineVersion` is
  recorded with every civilization and export.
- **Paired experiments diverge.** Keyed random streams keep the random numbers for a
  given (tick, citizen) identical across runs with the same seed, which keeps two
  scenarios aligned for as long as possible. Once a citizen's state differs between
  the runs, the same random number serves a different decision, so the two runs no
  longer experience "the same luck" (check 3 above). Compare distributions over
  several seeds, not single trajectories.
- **World generation is sequential**: changing the population or the age thresholds
  produces a different world, not the same world with a small change.
- **Live stream events are not the record.** Events received over the WebSocket can be
  rolled back by a halt or a rewind; the REST history and exports contain only durable
  events.

## 4. Economic-shock experiments

Phase 1 has no economy in motion and no shock mechanism, so there is no shock
experiment to show yet. A worked example — the same seed with and without a scheduled
shock, compared metric by metric — will be added in Phase 4 when shocks and policies
exist (see [ROADMAP.md](ROADMAP.md)).
