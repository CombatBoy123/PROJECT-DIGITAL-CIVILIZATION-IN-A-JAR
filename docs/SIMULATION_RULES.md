# Simulation rules (Phase 1)

This document states every rule the engine (`packages/sim-core`) applies in Phase 1,
with the exact parameters and formulas from the code. If this document and the code
disagree, the code is right and this document has a bug. Source files are named in
each section so that every statement can be checked.

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) (system design),
[ECONOMIC_MODEL.md](ECONOMIC_MODEL.md) (money and metrics),
[EXPERIMENTS.md](EXPERIMENTS.md) (reproducibility walkthrough with real values).

Engine version `0.1.0` (`ENGINE_VERSION`), state schema version 1, config schema
version 1.

## Contents

1. [Time model](#time-model)
2. [Update order](#update-order)
3. [Randomness and reproducibility](#randomness-and-reproducibility)
4. [Configuration parameters](#configuration-parameters)
5. [World generation](#world-generation)
6. [Environment: seasons, weather, temperature](#environment)
7. [Demography: ages and life stages](#demography)
8. [Needs: energy](#needs-energy)
9. [Daily routine and movement](#daily-routine-and-movement)
10. [Invariants](#invariants)
11. [Event catalogue](#event-catalogue)
12. [Limitations](#limitations)

## Time model

Source: `src/time/clock.ts`.

- **One tick is one simulated hour.** `TICKS_PER_DAY = 24`.
- A **season** lasts `daysPerSeason` days (configurable, 1–60, default 7). There are
  four seasons in the fixed order spring, summer, autumn, winter.
- A **year** therefore lasts `ticksPerYear = daysPerSeason × 4 × 24` ticks — 672
  ticks (28 days) with the default configuration.
- **Tick 0 is genesis**: year 1, first day of spring, 00:00. The calendar of tick `t` is
  derived arithmetically (no state):

  ```
  dayIndex    = ⌊t / 24⌋              day       = dayIndex + 1
  hour        = t − 24·dayIndex
  daysPerYear = 4 · daysPerSeason
  year        = ⌊dayIndex / daysPerYear⌋ + 1
  dayOfYear   = dayIndex mod daysPerYear
  season      = SEASONS[⌊dayOfYear / daysPerSeason⌋]
  dayOfSeason = dayOfYear mod daysPerSeason        (0-based)
  ```

- **Night** is 22:00–05:59 (`isNight(hour) = hour ≥ 22 ∨ hour < 6`; `NIGHT_START_HOUR = 22`,
  `NIGHT_END_HOUR = 6`). `hoursUntilNight(hour)` is `22 − hour` in daytime and 0 at night: the
  whole hours from the start of `hour` until the night begins.
- Display format (`formatCalendar`): `Y1 spring D3 07:00` (day of season 1-based).
- Simulation time is unrelated to wall-clock time. The server's runner decides how
  many ticks to execute per real second (the civilization's _speed_); the speed has
  no influence on results.

Because years are short by default (28 days), ages advance quickly relative to the
daily routine: a citizen ages one year every four simulated weeks. Choose a larger
`daysPerSeason` for a slower demographic clock.

## Update order

Source: `src/engine/simulation.ts`, `src/engine/pipeline.ts`.

`Simulation.step()` produces tick `t + 1` from the state at tick `t`:

1. `t' = t + 1`; the calendar of `t'` is computed; `state.tick` is set to `t'` **before**
   any system runs, and every event emitted during the step is stamped with `t'`.
2. The pipeline runs in the fixed order below. Systems mutate the state in place.
3. All [invariants](#invariants) and the event sequence are checked (unless the
   civilization runs with `INVARIANT_CHECKS=off`). A violation halts the simulation.
4. If `t' mod metricsInterval = 0`, a metric sample is computed from the final state
   of the step.

| Stage | System (file)                              | Phase 1 content                                                     | Planned                                        |
| ----- | ------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | `environment` (`systems/environment.ts`)   | season start, daily weather draw, daily mean and hourly temperature | scheduled shocks, disasters (Phase 4)          |
| 2a    | `demography` (`systems/demography.ts`)     | life stage from age; `LifeStageChanged`                             | births, deaths, migration                      |
| 2b    | `needs` (`systems/needs.ts`)               | energy change for the hour that just elapsed                        | hunger, health, happiness, security (Phase 3)  |
| 3     | — production & business operations         | nothing                                                             | recipes, inventories (Phase 2)                 |
| 4     | — employment, wages, consumption           | nothing                                                             | hiring, payroll, consumption (Phase 2)         |
| 5     | — markets & prices                         | nothing                                                             | order matching, price formation (Phase 2)      |
| 6     | — taxes, benefits, policies                | nothing                                                             | government (Phase 4)                           |
| 7     | `routine` (`systems/routine.ts`)           | arrivals, sleeping/waking, outings to venues, returning home        | utility-based decisions with records (Phase 3) |
| 8     | records & metrics (`engine/simulation.ts`) | invariant checks, metric sample                                     | richer metrics, decision records               |

Stages 3–6 have no Phase 1 content and are absent from `PIPELINE`; the pipeline asserts
at load time that its systems are ordered by stage.

### Implications of the order

- **Needs use the activity chosen in the previous tick.** Stage 2b applies the energy
  change for the activity the citizen held during the elapsed hour, i.e. the activity
  set by stage 7 of the previous step. A citizen who falls asleep in stage 7 of tick
  `t` recovers energy from tick `t + 1` on; one who wakes at `t` drains energy from
  `t + 1` on.
- **Life stage changes before needs.** The elder drain multiplier applies from the
  very tick a citizen becomes an elder (2a runs before 2b).
- **Routine sees today's weather.** The weather is drawn at 00:00 in stage 1, so the
  routine decisions of that same tick already use it. A storm forces visitors home in
  the tick it is drawn (they would also leave because 00:00 is night).
- **Routine sees this tick's energy.** Thresholds in stage 7 (`energy < 20` to sleep,
  `≥ 85` to wake, …) compare against the energy already updated in stage 2b.
- **Arrival ends a citizen's turn.** A citizen whose trip ends at `t'` arrives in stage 7
  and takes no further decision in that tick.
- **Metrics describe the end of the tick**: they are computed after every system ran.

## Randomness and reproducibility

Sources: `src/rng/rng.ts`, `src/rng/hash.ts`, `src/engine/context.ts`.

### Keyed streams

There is no global random generator. Every random decision derives a fresh generator
from the civilization seed and a key:

```
rngFor(seed, k1, k2, …) = sfc32( cyrb128( seed ‖ 0x1F ‖ k1 ‖ 0x1F ‖ k2 ‖ … ) )
```

- `cyrb128` is a 128-bit non-cryptographic string hash using only 32-bit integer
  operations; its four 32-bit words seed `sfc32`, a small generator with 128 bits of
  state. The first 8 outputs are discarded (warm-up) so similar keys give unrelated
  streams.
- `next()` returns `uint32 / 2³²` ∈ [0, 1). Derived draws:
  `uniform(a, b) = a + (b − a)·next()`; `int(a, b) = a + ⌊next()·(b − a + 1)⌋`;
  `chance(p)` = `false` if `p ≤ 0`, `true` if `p ≥ 1`, else `next() < p`;
  `pick(xs)` = `xs[⌊next()·n⌋]`; `weightedIndex(w)` walks the cumulative weights with
  one uniform draw.
- `normal(μ, σ) = μ + σ·(Σ_{i=1..12} U_i − 6)` (Irwin–Hall). Its variance is exactly σ²,
  its support is bounded to μ ± 6σ, and it avoids `Math.log`/`Math.cos`, whose results
  may differ between JavaScript engines.

Inside a step, systems call `ctx.rng(stream, …keys)`, which is
`rngFor(seed, stream, tick, …keys)`. The streams in use:

| Stream key                 | Used for                                             | Draws per use                                                |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| `weather, tick`            | daily weather and daily mean temperature             | at 00:00 only: 1 (Markov step) + 12 (normal)                 |
| `routine, tick, citizenId` | one citizen's routine decision in one tick           | 1 (wake), or 1–2 (outing chance, venue choice), or 1 (leave) |
| `weather, 0`               | daily mean temperature of genesis day                | 12                                                           |
| `worldgen, households`     | household sizes, names, ages                         | sequential, whole world                                      |
| `worldgen, map`            | zoning jitter                                        | one per block                                                |
| `worldgen, names`          | venue names                                          | one per venue (after the first plaza)                        |
| `worldgen, housing`        | house assignment and house capacities                | sequential, whole world                                      |
| `worldgen, citizens`       | education, birth tick, traits, skills, money, energy | sequential, citizen by citizen                               |

### Deterministic versus stochastic rules

| Rule                                                     | Kind                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| Calendar, seasons, `SeasonStarted`                       | deterministic                                           |
| Seasonal temperature baseline and hour-of-day profile    | deterministic                                           |
| Daily weather and daily temperature deviation            | stochastic, optional (`stochastic.weather`, default on) |
| Ageing and life stages                                   | deterministic                                           |
| Energy                                                   | deterministic                                           |
| Waking, going out, venue choice, leaving a venue         | stochastic (always on)                                  |
| Going to sleep, forced departures, arrivals, travel time | deterministic                                           |
| World generation                                         | stochastic, from the seed                               |

With `stochastic.weather = false` the weather is permanently `clear`, the daily mean
temperature is exactly the seasonal baseline, and no `WeatherChanged` events occur.
The routine remains stochastic: in Phase 1 there is no configuration in which a run is
free of random draws, but every draw is a pure function of (seed, stream, tick,
entity id), so every run is still exactly repeatable.

### What reproducibility guarantees

The engine is a pure function of **(engine version, seed, configuration, number of
ticks)**. Concretely:

- Two runs with the same seed and configuration produce identical states, events and
  metric samples at every tick, and therefore identical state hashes. This is tested
  (`test/determinism.test.ts`) and demonstrated with real hashes in
  [EXPERIMENTS.md](EXPERIMENTS.md).
- Restoring a serialised state (a snapshot) and continuing reproduces the original
  continuation exactly; no generator state needs to be saved because streams are
  keyed by tick and entity.
- How the ticks are executed does not matter: stepping 240 times, running at any
  speed, pausing, checkpointing or restarting the server in between all give the same
  state at tick 240.
- All arithmetic is IEEE-754 double precision restricted to `+ − × ÷`, comparisons and
  `Math.floor/round/ceil/min/max/abs/sqrt/imul` (all exactly specified by IEEE-754 or ECMAScript); ESLint forbids `Math.random`, `Date.now`,
  `new Date()`, `performance.now`, `Math.exp/log/pow/sin/cos`, timers and `fetch` in
  `packages/sim-core/src`, so results do not depend on the JavaScript engine,
  platform or wall clock.

### What it does not guarantee

- **A shared seed does not mean matched random events once paths diverge.** Keyed
  streams make the random numbers for (tick, citizen) identical across two runs with
  the same seed, but which decision consumes them depends on the citizen's state. If a
  policy change in one run keeps a citizen at home while in the other run the same
  citizen is at a venue, the same uniform number is used for a "go out?" draw in one
  run and a "leave?" draw in the other; from then on their trajectories are not
  paired. Keyed streams only maximise alignment, they cannot preserve it.
- **World generation is not keyed per entity.** The `worldgen` streams are consumed
  sequentially, so changing the population (or any parameter that changes the number
  of draws, such as `adultAge`) produces an entirely different world, not the same
  world with one more citizen.
- **The configuration is part of the state.** Two runs whose configurations differ in
  any field have different hashes from tick 0, even if the field has not influenced a
  decision yet.
- **Across engine versions** nothing is guaranteed; `ENGINE_VERSION` is bumped whenever
  a rule change alters results, and states with a different `schemaVersion` are
  rejected on restore.
- **The state hash is not cryptographic.** Equal hashes mean equal states with
  overwhelming probability for honest inputs; `cyrb128` is not collision-resistant
  against deliberate tampering.

## Configuration parameters

Source: `src/config.ts` (`SimulationConfigSchema`). Unknown fields are rejected.

| Parameter                   | Type    | Range         | Default | Meaning                                                      |
| --------------------------- | ------- | ------------- | ------- | ------------------------------------------------------------ |
| `population`                | integer | 10–5000       | 100     | citizens created at genesis                                  |
| `daysPerSeason`             | integer | 1–60          | 7       | calendar length (4 seasons per year)                         |
| `initialWealth.meanCents`   | integer | 0–100,000,000 | 50,000  | mean adult endowment (cents); elders get 1.3×                |
| `initialWealth.spread`      | number  | 0–0.9         | 0.5     | dispersion of endowments (see [world generation](#citizens)) |
| `lifeStages.adultAge`       | integer | 14–25         | 18      | age at which a child becomes an adult                        |
| `lifeStages.elderAge`       | integer | 50–90         | 65      | age at which an adult becomes an elder                       |
| `movement.walkTilesPerTick` | integer | 4–200         | 24      | road tiles walked per hour                                   |
| `stochastic.weather`        | boolean | —             | true    | stochastic daily weather and temperature deviation           |
| `metricsInterval`           | integer | 1–168         | 1       | a metric sample is recorded every N ticks                    |

The seed is a string of 1–64 characters from `[A-Za-z0-9._-]`.

## World generation

Source: `src/world/generate.ts`, `src/world/roads.ts`. Everything below is drawn from
the keyed `worldgen` streams, so a seed and a configuration always yield the same world.

### Households

Stream `worldgen, households`. Households are planned until the population is met
exactly:

1. Size `s = weightedIndex([28, 32, 18, 15, 7]) + 1` (sizes 1–5 with weights 28, 32,
   18, 15, 7), truncated to the number of citizens still to place.
2. A surname, and a head of household aged `round(clamp(normal(46, 16), adultAge, 92))`.
3. A partner with probability 0.75 when `s = 2` and 0.8 when `s ≥ 3`, aged
   `clamp(head + int(−6, 6), adultAge, 95)`; the partner keeps a separately drawn
   surname with probability 0.3, otherwise shares the household surname.
4. Remaining members are children aged `int(0, m)` with
   `m = min(adultAge − 1, youngestParentAge − 16)` when `m ≥ 0`; otherwise adult
   relatives aged `clamp(head + int(−8, 8), adultAge, 95)`.

### Map and zoning

Stream `worldgen, map`. The map is a grid of square blocks of 6 × 6 tiles separated by
one-tile roads (road pitch 7): a tile is road iff `x mod 7 = 0 ∨ y mod 7 = 0`.

Block counts by zone, with `H` = number of households and
`houseCount = ⌈1.1·H⌉` (10 % vacant homes):

| Zone        | Blocks                                     | Phase 1 use                                |
| ----------- | ------------------------------------------ | ------------------------------------------ |
| civic       | `venues = max(2, ⌈0.35·population / 35⌉)`  | one public venue (plaza or park) per block |
| commercial  | `max(2, ⌈population / 50⌉)`                | vacant zoned land (businesses: Phase 2)    |
| residential | `⌈houseCount / 4⌉`                         | 4 house lots of 3 × 3 tiles per block      |
| farmland    | `max(4, ⌈population / 25⌉)` + unused cells | vacant zoned land (farms: Phase 2)         |

The grid has `cols = ⌈√total⌉` and `rows = ⌈total / cols⌉` blocks, so the map is
`(7·cols + 1) × (7·rows + 1)` tiles. Each cell gets the key
`dx² + dy² + U(0, 2·cols)` with `dx = 2·col + 1 − cols`, `dy = 2·row + 1 − rows` (squared
distance from the centre in half-block units plus jitter). Cells are sorted by key
(ties: row, then column) and assigned civic, commercial, residential, then farmland
for all remaining cells — central civic blocks, a commercial ring, residential
neighbourhoods and farmland on the outskirts, with irregular, seed-dependent
boundaries.

The venue supply `⌈0.35·population / 35⌉` sizes venues so that 35 % of the population
(the assumed peak leisure share) fits into venues of average capacity (40 + 30) / 2.

### Buildings

- **Venues** (stream `worldgen, names` for names): one per civic block, taken from the
  map centre outwards (see below) and alternating plaza, park, plaza, … The first plaza is named
  "Central Plaza", other plazas "_word_ Square", parks "_word_ Park" (a numeric suffix
  keeps names unique). A venue covers its whole block (6 × 6). Capacity: plaza 40,
  park 30 simultaneous visitors. The door is the road tile above the block's centre.
- **Houses**: residential blocks are filled from the map centre outwards, four 3 × 3 lots per
  block (top-left, top-right, bottom-left, bottom-right), until `houseCount` houses
  exist. A top lot's door is on the road above the block, a bottom lot's door on the
  road below. Houses are named after the door: the house number is `2·doorX` for a top
  lot and `2·doorX + 1` for a bottom lot, followed by the street of the door's road, e.g.
  "12 Willow Street". The top lot of one block and the bottom lot of the block above it
  share the same door tile (the road tile in front of both entrances); the side of the
  road sets the parity of their numbers, so every building name is unique.
- **Housing** (stream `worldgen, housing`): the houses are shuffled (Fisher–Yates) and
  household _i_ moves into the _i_-th shuffled house. An occupied house gets capacity
  `min(6, max(members, int(2, 5)))`; a vacant house `int(2, 5)`.

"From the map centre outwards" orders blocks by the squared distance of the block centre
from the map centre, `(2·col + 1 − cols)² + (2·row + 1 − rows)²`, ties broken by row then
column (no randomness), so the first plaza ("Central Plaza") is the most central civic block.

Every door lies on a horizontal road, which makes shortest routes simple (see
[travel](#travel)).

### Citizens

Stream `worldgen, citizens`, household by household, member by member (ids 1, 2, … in
that order):

- **Life stage** from the planned age (see [demography](#demography)).
- **Birth tick**: `−(age·ticksPerYear + int(0, ticksPerYear − 1))`, so ages at genesis
  are exact whole years and birthdays are spread over the year.
- **Education**: children by age (< 6 none, < 12 primary, otherwise secondary).
  Adults drawn with weights none 5, primary 20, secondary 50, tertiary 25; elders
  with none 10, primary 35, secondary 40, tertiary 15.
- **Personality**: openness, conscientiousness, extraversion, agreeableness and
  neuroticism, each `round₃(clamp(normal(0.5, 0.15), 0, 1))`.
- **Skills** (farming, baking, crafting, commerce, management; 0–100): children
  `round₁(U(0, 10))` each. Adults and elders: experience `e = min(age − adultAge, 30)`,
  one specialty skill picked uniformly; each skill is
  `base(education) + 0.3·e + U(0, 20)`, plus `25 + e` for the specialty, clamped to
  [0, 100] and rounded to 0.1. `base`: none 10, primary 18, secondary 25, tertiary 32.
  Skills are recorded and shown but have no effect in Phase 1.
- **Endowment** (cents): children 0. Adults
  `round(meanCents · Π_{k=1..4} U_k(1 − spread, 1 + spread))`; elders the same
  multiplied by 1.3. See [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md#initial-endowments).
- **Energy** `round₁(U(60, 95))`; everyone starts **asleep at home** with
  `activitySince = 0`.

The genesis events are, in order: `CivilizationFounded` (seq 1), then for each citizen
`CitizenCreated` followed — if the endowment is positive — by `MoneyIssued` with
`causeSeq` pointing to that `CitizenCreated`.

## Environment

Source: `src/systems/environment.ts`. Runs every tick (stage 1).

**At 00:00 of each day** (hour 0, which never happens during a step at tick 0):

1. If it is the first day of a season, emit `SeasonStarted { season, year }`. The
   spring of year 1 starts at genesis and has no `SeasonStarted` event; the first one
   is summer at tick `24·daysPerSeason` (tick 168 by default).
2. Weather (only when `stochastic.weather`): draw today's weather from the season's
   transition row of yesterday's weather (stream `weather, tick`):

   | Season | from \ to | clear | cloudy | rain | storm |
   | ------ | --------- | ----- | ------ | ---- | ----- |
   | spring | clear     | 55    | 30     | 13   | 2     |
   |        | cloudy    | 30    | 40     | 25   | 5     |
   |        | rain      | 20    | 35     | 38   | 7     |
   |        | storm     | 20    | 40     | 30   | 10    |
   | summer | clear     | 70    | 20     | 7    | 3     |
   |        | cloudy    | 45    | 35     | 14   | 6     |
   |        | rain      | 40    | 30     | 22   | 8     |
   |        | storm     | 45    | 30     | 15   | 10    |
   | autumn | clear     | 45    | 35     | 17   | 3     |
   |        | cloudy    | 25    | 40     | 28   | 7     |
   |        | rain      | 15    | 35     | 40   | 10    |
   |        | storm     | 15    | 35     | 35   | 15    |
   | winter | clear     | 45    | 40     | 10   | 5     |
   |        | cloudy    | 25    | 50     | 15   | 10    |
   |        | rain      | 20    | 45     | 25   | 10    |
   |        | storm     | 20    | 40     | 20   | 20    |

   Rows are integer weights summing to 100 (percent probabilities). The long-run
   (stationary) distribution of each season's chain, computed from these matrices, is
   spring 0.362 / 0.352 / 0.240 / 0.046, summer 0.593 / 0.253 / 0.108 / 0.046, autumn
   0.267 / 0.368 / 0.291 / 0.074, winter 0.297 / 0.453 / 0.155 / 0.095 (clear / cloudy
   / rain / storm). With 7-day seasons the chain does not reach its stationary
   distribution within a season; these figures describe tendencies, not frequencies.

3. Daily mean temperature (same stream, after the weather draw):
   `dailyMeanTempC = round₁(normal(base(season), 2.5))` with
   `base`: spring 12 °C, summer 22 °C, autumn 11 °C, winter 1 °C. Without stochastic
   weather it is exactly `base(season)`.
4. If the weather differs from yesterday's, emit
   `WeatherChanged { from, to, dailyMeanTempC }`.

**Every tick**: `temperatureC = round₁(dailyMeanTempC + offset[hour])` with the hourly
offsets (°C, hours 0–23):

```
-3, -3.5, -4, -4, -4.5, -4.5, -3.5, -2.5, -1, 0.5, 1.5, 2.5,
3.5, 4, 4.5, 4.5, 4, 3, 2, 1, 0, -1, -1.5, -2.5
```

Coolest 04:00–05:00 (−4.5), warmest 14:00–15:00 (+4.5). The offsets average
−0.1875 °C, so `dailyMeanTempC` is the profile's reference level, not exactly the
average of the 24 hourly values.

**Genesis**: weather `clear`; the daily mean of day 1 is drawn from the spring baseline
with stream `weather, 0` (or is exactly 12 °C without stochastic weather).

**Bounds** (checked by the `ENVIRONMENT` [invariant](#invariants)): because `normal` is
bounded to μ ± 6σ, the daily mean never deviates from the seasonal baseline by more than
`MAX_DAILY_TEMP_DEVIATION_C = 6 · 2.5 = 15 °C`.

**Effects in Phase 1**: weather scales the probability of going out and a storm sends
venue visitors home (see [routine](#daily-routine-and-movement)). Temperature is
recorded and shown but influences nothing yet.

## Demography

Source: `src/systems/demography.ts`. Runs every tick (stage 2a).

```
age(c, t)        = ⌊(t − birthTick(c)) / ticksPerYear⌋
lifeStage(age)   = child  if age < adultAge
                   adult  if adultAge ≤ age < elderAge
                   elder  if age ≥ elderAge
```

When a citizen's computed stage differs from the stored one, the stored stage is
updated and `LifeStageChanged { from, to, ageYears }` is emitted with the citizen as
`subject`. Stages only move forward because age only increases.

There are no births, deaths or migration in Phase 1: the population is constant.

## Needs: energy

Source: `src/systems/needs.ts`. Runs every tick (stage 2b). Energy is a level in
[0, 100] (0 exhausted, 100 fully rested).

```
Δenergy = +9                     if the elapsed hour's activity was sleeping
        = −d(activity) · m       otherwise
d: at_home 1.5, leisure 2.5, traveling 3        m = 1.25 for elders, 1 otherwise
energy' = round(clamp(energy + Δenergy, 0, 100) · 1000) / 1000
```

Rounding to 1/1000 keeps serialised values short and stable. Hunger, health,
happiness and security are Phase 3.

## Daily routine and movement

Source: `src/systems/routine.ts`, `src/world/roads.ts`. Runs every tick (stage 7),
citizen by citizen in ascending id order. It is an intentionally transparent rule set
that the Phase 3 utility-based decision system will replace.

### Parameters (`ROUTINE_RULES`)

| Parameter               | Value                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeEnergy`            | 85                                                                                                                                                                                    |
| `wakeBase`              | 0.35                                                                                                                                                                                  |
| `wakeConscientiousness` | 0.6                                                                                                                                                                                   |
| `sleepEnergy`           | 20                                                                                                                                                                                    |
| `outingMinEnergy`       | 40                                                                                                                                                                                    |
| `outingMinStayHours`    | 1 (hours at the venue an outing must leave room for; the arrival hour counts)                                                                                                         |
| `leaveVenueEnergy`      | 30                                                                                                                                                                                    |
| `outingBaseByHour`      | 0 for hours 0–7 and 21–23; 08:00 0.04, 09:00 0.06, 10:00 0.08, 11:00 0.08, 12:00 0.07, 13:00 0.07, 14:00 0.08, 15:00 0.09, 16:00 0.10, 17:00 0.10, 18:00 0.08, 19:00 0.05, 20:00 0.02 |
| `weatherOutingFactor`   | clear 1, cloudy 0.8, rain 0.35, storm 0                                                                                                                                               |
| `leaveBase`             | 0.15                                                                                                                                                                                  |
| `leaveIntrovertBonus`   | 0.2                                                                                                                                                                                   |
| `longStayHours`         | 4                                                                                                                                                                                     |
| `longStayBonus`         | 0.2                                                                                                                                                                                   |
| `distanceScale`         | 20 tiles                                                                                                                                                                              |

### Rules

Before the citizen loop, the stage counts the **load** of every non-home building: the
citizens located there plus those travelling there. Capacity is reserved when a trip
starts, so a venue can never be over-booked.

For each citizen (`night` = 22:00–05:59, one stream `routine, tick, citizenId` per
citizen and tick):

1. **Travelling**: nothing happens until `tick ≥ arriveTick`. On arrival the citizen
   is placed at the destination with `activitySince = tick`; at home the activity is
   `sleeping` if it is night or `energy < 20`, otherwise `at_home`; at a venue it is
   `leisure`. No further decision in this tick.
2. **Asleep at home**: wakes up (`at_home`) only if it is not night, `energy ≥ 85`, and
   a draw succeeds with probability

   `p_wake = 0.35 + 0.6 · conscientiousness` (between 0.35 and 0.95).

3. **Awake at home**: goes to sleep if it is night or `energy < 20`. Otherwise goes out
   with probability

   `p_out = 0` if `energy < 40`, else
   `p_out = outingBaseByHour[hour] · (0.5 + extraversion) · weatherOutingFactor[weather]`

   (at most 0.10 · 1.5 · 1 = 0.15 per hour). If the draw succeeds, a venue is chosen
   (below); if no venue has room or no outing [fits](#venue-choice), the citizen stays
   home.

4. **At a venue**: must leave if it is night, `energy < 30`, the weather is a storm, or
   staying one more hour would not leave time and energy to get home, i.e. (with
   `T_home = travelTicks(venue → home)`)

   `1 + T_home > hoursUntilNight(hour)` (home after 22:00), or
   `energy − d(leisure) − T_home · d(traveling) < 20` (home below `sleepEnergy`),

   with the drains `d` of [energy](#needs-energy) (2.5 and 3, × 1.25 for elders).
   Otherwise leaves with probability

   `p_leave = 0.15 + 0.2 · (1 − extraversion) + (0.2 if hoursThere ≥ 4 else 0)`,
   `hoursThere = tick − activitySince` (hours since arrival). Leaving starts a trip
   home.

### Venue choice

With the same generator as the outing draw, a venue is drawn with probability
proportional to its weight:

```
w(v) = 0                                         if load(v) ≥ capacity(v)
w(v) = 0                                         if the outing to v does not fit (below)
w(v) = preference(v) / (1 + routeLength(home → v) / 20)    otherwise
preference(park)  = 0.5 + openness
preference(plaza) = 1.5 − openness
```

Open-minded citizens prefer parks, conventional ones plazas, and nearby venues are
preferred (a venue 20 tiles away has half the weight of one at the door).

**An outing fits** (`outingFits`) when, with `T = travelTicks(home → v)` and
`stay = outingMinStayHours = 1`, both

```
2·T + stay ≤ hoursUntilNight(hour)                                  (home by 22:00)
energy − 2·T·d(traveling) − stay·d(leisure) ≥ sleepEnergy (20)      (energy to spare)
```

hold, with `d(traveling) = 3` and `d(leisure) = 2.5` (× 1.25 for elders). Consequences: no
outing can start at 20:00 or later, only one-tick trips fit at 19:00, and in slow or large
worlds distant venues are never chosen (at `walkTilesPerTick = 4` with 5,000 citizens
almost nobody goes out). When no venue has a positive weight, no venue draw is made;
because every citizen has its own stream per tick, this never shifts another citizen's
random numbers.

Together with the leaving rule above, every routine trip ends by 22:00: nobody is at a
venue or travelling during the night (22:00–05:59), and travelling citizens never fall
below energy 20. The only exception is a state restored in the middle of a trip that was
written by an engine without these rules.

### Travel

Travel time between two buildings is

`travelTicks = max(1, ⌈routeLength(from.door, to.door) / walkTilesPerTick⌉)`

and a trip occupies the window `[departTick, arriveTick)` with
`arriveTick = departTick + travelTicks`. During the trip the citizen's activity is
`traveling`, its location is `null`, and it drains 3 energy per hour (3.75 for elders).

`roadRoute` (shared by the engine and the renderer, so the animation follows the
route the engine timed): doors lie on horizontal roads, so the route runs along the
origin's road to a vertical road `v`, along `v` to the destination's road, then to the
destination door. `v` minimises `|from.x − v| + |v − to.x|`: when a vertical road lies
between the two x positions, every such road is optimal and the one with the smallest x
is taken; otherwise the nearest road outside that interval is taken (on a tie, the one
with the smaller x). `routeLength` is the Manhattan length of the waypoints. There is
no congestion and every citizen walks at the same speed.

## Invariants

Source: `src/invariants/check.ts`. `checkInvariants(state)` runs after genesis, after
every step and whenever a state is deserialised (snapshot restore, checkpoint load).
With `INVARIANT_CHECKS=off` (a server setting meant for benchmarks only) **all** of these
checks are skipped, including those at genesis and on restore: a stored state that
passes the schema and hash checks but violates an invariant is then loaded without
complaint. Up to 50 violations are reported; any violation throws
`InvariantViolationError`, which the server records as a halt (see
[API.md](API.md#halted-civilizations)).

| Code                 | Property that must hold                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOCK`              | `tick` is a non-negative integer; no citizen's `activitySince` lies in the future.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IDENTITY`           | citizen, building, household and block ids are integers, strictly ascending (hence unique) and below their `nextIds` counter.                                                                                                                                                                                                                                                                                                                                                                  |
| `MAP`                | `roadPitch = blockSize + 1`, `width = cols · roadPitch + 1`, `height = rows · roadPitch + 1`; every block sits on its own grid cell (`x = col · roadPitch + 1`, `y = row · roadPitch + 1`, `col < cols`, `row < rows`); every building lies inside its block (hence inside the map) and overlaps no other building; every door lies inside the map on a road tile.                                                                                                                             |
| `HOUSING`            | every household's home and every citizen's home is a house; a citizen lives in its household's home; residents ≤ capacity.                                                                                                                                                                                                                                                                                                                                                                     |
| `NEGATIVE_BALANCE`   | every balance is a safe integer number of cents and ≥ 0 (credit does not exist).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MONEY_CONSERVATION` | `destroyedCents ≤ issuedCents` and `Σ balances = issuedCents − destroyedCents`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOCATION`           | a travelling citizen has no location, activity `traveling`, existing endpoints and `departTick < arriveTick`, `departTick ≤ tick < arriveTick`; a `leisure` trip goes from the citizen's home to a plaza or park and a `home` trip from a plaza or park to its home, with `arriveTick − departTick = travelTicks(from, to)`; a non-travelling citizen is in an existing building, is not `traveling`, sleeps / stays `at_home` only in its own home and has `leisure` only at a plaza or park. |
| `VENUE_CAPACITY`     | present plus incoming visitors of each non-home building ≤ its capacity.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `NEEDS_BOUNDS`       | energy is finite and within [0, 100].                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ENVIRONMENT`        | `temperatureC = round₁(dailyMeanTempC + offset[hour])`; with stochastic weather off, the weather is `clear` and `dailyMeanTempC` equals the seasonal baseline; with it on, `dailyMeanTempC` lies within ±15 °C of the baseline. A state with a storm or a non-baseline temperature while stochastic weather is off is therefore refused.                                                                                                                                                       |
| `LIFE_STAGE`         | the stored life stage equals the stage implied by the age at the current tick.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EVENT_SEQUENCE`     | (`checkEventSequence`) the events of a step have contiguous sequence numbers starting at the state's `nextEventSeq` from before the step, and all carry the step's tick.                                                                                                                                                                                                                                                                                                                       |

Further guarantees enforced elsewhere:

- The clock advances by exactly one per step by construction (`step()` sets
  `tick = tick + 1`).
- `deserializeState` rejects JSON that fails the Zod `WorldStateSchema` (types, ranges,
  unknown fields, a seed that `Simulation.create` would refuse — anything but 1–64
  characters of `[A-Za-z0-9._-]`), any `schemaVersion` other than 1, and — when an expected hash is
  given, as for every snapshot and checkpoint — any state whose canonical hash differs
  from the stored one. A restored snapshot therefore always reproduces its recorded
  hash exactly.

Tests that prove violations are detected: `packages/sim-core/test/invariants.test.ts`
(see [TESTING.md](TESTING.md)).

## Event catalogue

Source: `src/events/types.ts` (`EVENT_CATALOG`). Every event has a per-civilization
`seq` (strictly increasing from 1), the `tick` it happened in, a `type`, a JSON
`payload`, `refs` to involved entities with roles, and an optional `causeSeq`.
High-frequency changes (a citizen walking to the plaza) are not events; they are
visible in the live frame stream and in the state.

| Type                  | Category    | When                                                   | Payload                                                         | Refs (role)                                                     | `causeSeq`           |
| --------------------- | ----------- | ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- | -------------------- |
| `CivilizationFounded` | genesis     | tick 0, seq 1                                          | `seed, population, households, buildings, mapWidth, mapHeight`  | —                                                               | —                    |
| `CitizenCreated`      | genesis     | tick 0, once per citizen                               | `firstName, lastName, ageYears, lifeStage, householdId, homeId` | citizen (`subject`), household (`household`), building (`home`) | —                    |
| `MoneyIssued`         | economy     | tick 0, once per citizen with a positive endowment     | `amountCents, reason: "initial_endowment"`                      | citizen (`recipient`)                                           | the `CitizenCreated` |
| `SeasonStarted`       | environment | 00:00 on the first day of each season (not at genesis) | `season, year`                                                  | —                                                               | —                    |
| `WeatherChanged`      | environment | 00:00 when the daily draw differs from yesterday       | `from, to, dailyMeanTempC`                                      | —                                                               | —                    |
| `LifeStageChanged`    | demography  | the tick a citizen reaches `adultAge` or `elderAge`    | `from, to, ageYears`                                            | citizen (`subject`)                                             | —                    |

Payloads are data only; nothing in the system interprets them as code.

## Limitations

Phase 1 is a foundation, not a society model. In particular:

- **No economy in motion.** Money is issued once at genesis and never moves: there
  are no jobs, prices, purchases or taxes (Phase 2–4). See
  [ECONOMIC_MODEL.md](ECONOMIC_MODEL.md).
- **Constant population.** No births, deaths or migration; children grow up and adults
  become elders, nothing else.
- **One need.** Energy is the only need; it is driven solely by activity.
- **Rule-based routine.** Behaviour is a fixed probabilistic rule set with a handful of
  parameters, not a decision model. Decisions are not recorded with alternatives
  (Phase 3). Skills, education, agreeableness and neuroticism have no behavioural
  effect yet.
- **Leisure only.** Citizens are either at home, travelling, or at a plaza or park.
  There is no work, school or shopping; vacant commercial and farmland blocks are
  zoned land only.
- **Simplified environment.** Weather affects only outings; temperature affects
  nothing. Weather is one condition per day for the whole map.
- **Simplified movement.** Walking at a fixed speed along an L- or Z-shaped road route;
  no congestion, no other transport, everyone (including children and elders) moves
  alike. Children may go out alone during the day.
- **Short default years.** With `daysPerSeason = 7` a year is 28 days, so ageing is fast
  relative to the daily routine.
- **Engine-only performance figures** are in [TESTING.md](TESTING.md#benchmark); they
  exclude persistence and streaming.
