# Economic model

This document describes the money model that exists in Phase 1, every metric the
engine records (with its exact definition), how metric series are downsampled, and the
economic model planned for Phases 2–4. Anything marked **(planned)** does not exist in
the code yet; nothing planned is shown in the UI.

Related documents: [SIMULATION_RULES.md](SIMULATION_RULES.md) (all non-economic rules),
[API.md](API.md#history) (metric endpoints), [DATABASE.md](DATABASE.md) (storage).

## Phase 1 money model

Sources: `packages/sim-core/src/state/schema.ts`, `src/world/generate.ts`,
`src/invariants/check.ts`.

### Units

All money is an **integer number of cents** (minor units), stored as a JavaScript
number restricted to safe integers (`|x| ≤ 2⁵³ − 1`) in the engine and as `BIGINT` in
PostgreSQL. No floating-point amount is ever stored or summed; averages (for example
the mean wealth metric) are statistics, not balances.

### Accounts and the ledger

- Every citizen has one account, `balanceCents ≥ 0`. There are no business,
  household or government accounts yet, and no credit: a negative balance is an
  invariant violation.
- The world state has a ledger with two running totals:
  `issuedCents` (all money ever created) and `destroyedCents` (all money ever removed).

### Issuance only at genesis

Money enters the economy only through `MoneyIssued` events. In Phase 1 they occur
only at genesis (tick 0), once per citizen with a positive initial endowment, with
`reason: "initial_endowment"`, the citizen as `recipient` and `causeSeq` pointing to
that citizen's `CitizenCreated` event. Each issuance adds the amount to the citizen's
balance and to `ledger.issuedCents`. Nothing destroys money in Phase 1, so
`destroyedCents` stays 0.

### Initial endowments

```
endowment(child) = 0
endowment(adult) = round( meanCents · Π_{k=1..4} U_k ),  U_k ~ Uniform(1 − spread, 1 + spread)
endowment(elder) = round( meanCents · 1.3 · Π_{k=1..4} U_k )
```

(defaults `meanCents = 50,000`, `spread = 0.5`). The product of four independent
uniforms with mean 1 has **mean exactly 1**, so `meanCents` is the expected adult
endowment. Its median is lower because the product is right-skewed. Monte Carlo
estimates of the factor `Π U_k` (10⁶ draws with the engine's `Rng`):

| `spread` | mean   | median | 10th percentile | 90th percentile | maximum observed |
| -------- | ------ | ------ | --------------- | --------------- | ---------------- |
| 0.25     | 0.9995 | 0.9618 | 0.6516          | 1.4002          | 2.3854           |
| 0.5      | 1.0001 | 0.8520 | 0.3683          | 1.8407          | 4.7908           |
| 0.9      | 0.9995 | 0.5191 | 0.0689          | 2.5914          | 12.2898          |

So with the defaults the median adult endowment is about 85 % of `meanCents`. The factor is bounded by `(1 ± spread)⁴`. For the demo
world in [EXPERIMENTS.md](EXPERIMENTS.md) (seed `demo-1`, 100 citizens) the 68
adults and elders received 3,727,849 cents in total: mean 54,821.31, median 44,158,
minimum 15,979, maximum 181,209 cents, adult wealth Gini 0.341035.

### Conservation invariant

After every tick the engine checks (invariant `MONEY_CONSERVATION`, see
[SIMULATION_RULES.md](SIMULATION_RULES.md#invariants)):

```
destroyedCents ≤ issuedCents
Σ_citizens balanceCents = issuedCents − destroyedCents
```

together with `balanceCents ≥ 0` and integrality for every account
(`NEGATIVE_BALANCE`). A violation halts the civilization rather than letting it
continue from an impossible state. In Phase 1 no rule moves money after genesis, so
the money supply is constant; the invariant exists now so that every Phase 2 transfer
is checked from the first day it exists.

### No transactions yet

Phase 1 has no prices, wages, purchases, rents or taxes. Wealth therefore only
changes by issuance, and all wealth metrics are constant after tick 0. The metrics and
invariants are in place so that the Phase 2 economy is measured from its first tick.

## Metrics

Source: `packages/sim-core/src/metrics/definitions.ts` (`METRIC_DEFINITIONS`) and
`src/metrics/compute.ts`, `src/metrics/stats.ts`. A metric sample is computed from the
state at the end of a tick (after all systems), at genesis and every `metricsInterval`
ticks (default every tick). Non-integer values are rounded to 6 decimals.

### Metric kinds

| Kind         | Meaning                                                             | Downsampling aggregate        |
| ------------ | ------------------------------------------------------------------- | ----------------------------- |
| `stock`      | a level measured at the sample tick (population, money supply)      | last sample in the bucket     |
| `flow`       | an amount accumulated during the interval since the previous sample | sum over the bucket           |
| `rate`       | a dimensionless ratio of two quantities measured at the sample tick | arithmetic mean of the bucket |
| `index`      | a summary statistic of a distribution at the sample tick (Gini)     | last sample in the bucket     |
| `cumulative` | a running total since genesis                                       | last sample in the bucket     |

Phase 1 defines no `flow` metric; the rule exists for Phase 2 (income, spending,
production).

### Definitions

"Adults" in the wealth metrics means **adults and elders** (`lifeStage ≠ child`);
children hold no wealth in Phase 1. Net worth is the account balance in Phase 1.

| Key                        | Label                     | Kind       | Unit    | Definition                                                                            |
| -------------------------- | ------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------- |
| `population.total`         | Population                | stock      | persons | `count(citizens)`                                                                     |
| `population.children`      | Children                  | stock      | persons | `count(lifeStage = child)` — younger than `adultAge`                                  |
| `population.adults`        | Adults                    | stock      | persons | `count(lifeStage = adult)` — from `adultAge` to below `elderAge`                      |
| `population.elders`        | Elders                    | stock      | persons | `count(lifeStage = elder)` — `elderAge` or older                                      |
| `activity.sleeping`        | Sleeping                  | stock      | persons | `count(activity = sleeping)` — asleep at home                                         |
| `activity.atHome`          | At home (awake)           | stock      | persons | `count(activity = at_home)`                                                           |
| `activity.leisure`         | At public venues          | stock      | persons | `count(activity = leisure)` — at a plaza or park                                      |
| `activity.traveling`       | Travelling                | stock      | persons | `count(activity = traveling)`                                                         |
| `needs.energyMean`         | Mean energy               | stock      | points  | `Σ energy / population` (0 = exhausted, 100 = fully rested; 0 if no citizens)         |
| `needs.lowEnergyShare`     | Low-energy share          | rate       | ratio   | `count(energy < 20) / population` (20 = the sleep threshold; 0 if no citizens)        |
| `money.supply`             | Money supply              | stock      | cents   | `Σ citizen balances`; must equal issued − destroyed                                   |
| `money.issuedCumulative`   | Money issued (cumulative) | cumulative | cents   | `ledger.issuedCents` — total created by `MoneyIssued` since genesis                   |
| `wealth.meanAdult`         | Mean adult wealth         | stock      | cents   | `Σ balance(adults ∪ elders) / count(adults ∪ elders)` (0 if none)                     |
| `wealth.medianAdult`       | Median adult wealth       | stock      | cents   | median of `balance(adults ∪ elders)`; mean of the two middle values for an even count |
| `wealth.giniAdult`         | Wealth Gini (adults)      | index      | ratio   | Gini coefficient of `balance(adults ∪ elders)` (below)                                |
| `environment.temperatureC` | Temperature               | stock      | celsius | air temperature at the sample hour = daily mean + hour-of-day offset                  |
| `environment.weatherCode`  | Weather severity          | stock      | code    | index of the weather in `[clear, cloudy, rain, storm]` (0–3)                          |

The four `activity.*` counts always sum to `population.total`, as do the three
`population.*` stage counts.

### Gini coefficient

For non-negative values sorted ascending, `x₍₁₎ ≤ … ≤ x₍ₙ₎`:

```
G = Σ_{i=1..n} (2i − n − 1) · x₍ᵢ₎  /  ( n · Σ_{i=1..n} x₍ᵢ₎ )
```

`G = 0` means perfect equality; the maximum, when one holder owns everything, is
`(n − 1)/n`. By definition `G = 0` when fewer than two values exist or the total is 0.
Negative values are rejected (they cannot occur while balances are non-negative).
This is the standard "mean absolute difference over twice the mean" Gini,
`G = Σᵢ Σⱼ |xᵢ − xⱼ| / (2n² · x̄)`, computed in O(n log n).

### Downsampling of metric series

Source: `apps/server/src/persistence/history-queries.ts` (`metricSeries`). Charts ask
for at most `maxPoints` rows (10–5000, default 600; see
[API.md](API.md#history)). When the requested range holds at most
`maxPoints` samples, raw samples are returned (`bucketTicks = 1`). Otherwise:

```
bucketTicks = ⌈(lastTick − firstTick + 1) / maxPoints⌉
bucket(t)   = ⌊(t − firstTick) / bucketTicks⌋
```

where `firstTick`/`lastTick` are the first and last stored samples in the range. Each
bucket becomes one row stamped with the **last sample tick in the bucket**, and each
metric is aggregated by its kind:

- **stock, index, cumulative → the value of the last sample in the bucket.** A level
  at a point in time cannot be summed, and averaging would invent a level that never
  existed at the row's tick. Short peaks inside a bucket are therefore not visible in a
  downsampled chart; request a narrower range (or export the raw CSV) to see them.
- **rate → the arithmetic mean** of the bucket's samples.
- **flow → the sum** of the bucket's samples (the amount over the whole bucket).

Aggregation runs in PostgreSQL; only the output rows are transferred. The CSV export
(`/export/metrics.csv`) always contains raw samples.

Example (real response, seed `demo-1` at tick 240, 241 samples, `maxPoints=10`):
`bucketTicks = ⌈241 / 10⌉ = 25`, first row stamped tick 24 (bucket 0–24).

## Planned economic model (Phases 2–4)

**(planned)** — none of the following exists in the code. It is the design the next
phases will implement; details may change, and this section will then be replaced by
exact rules. Every mechanism will move money only by explicit, evented transfers with
a matching debit and credit, so the conservation invariant above stays exact.

### Phase 2 — production and markets (planned)

- **Resources and inventories**: goods (for example grain, flour, bread, tools) held
  in integer quantities by citizens and businesses. New invariant: no inventory is
  ever negative.
- **Recipes**: production turns inputs into outputs using labour time and skills
  (the skills generated in Phase 1 become productive). Invariant: production
  consumes exactly the recipe inputs.
- **Businesses** on the commercial and farmland blocks generated in Phase 1, with
  owners, accounts, inventories and employees.
- **Employment and wages**: hiring and payroll as account-to-account transfers;
  citizens' routines gain work time.
- **Order matching and price formation**: buy and sell orders in a market per good,
  matched with a documented rule; prices emerge from matched trades instead of being
  set exogenously. Invariant: sales never exceed owned inventory.
- **Transactions**: every transfer recorded with debit and credit, enabling flow
  metrics (income, spending, production, trade volume) and the `flow` aggregation
  rule above.

### Phase 3 — consumption and needs (planned)

Hunger, health, happiness and security needs; consumption of goods to satisfy them;
utility-based decisions that record the alternatives considered.

### Phase 4 — policy and shocks (planned)

A policy engine: taxes, minimum wage, universal basic income, rent control, benefits,
subsidies, trade rules and public services, with a government account (taxes are
transfers to it; money creation and destruction by policy would use `MoneyIssued` and
a matching destruction event so the ledger identity holds). Scheduled shocks and
disasters, and a laboratory UI to compare runs. The economic-shock example in
[EXPERIMENTS.md](EXPERIMENTS.md) will be added then.
