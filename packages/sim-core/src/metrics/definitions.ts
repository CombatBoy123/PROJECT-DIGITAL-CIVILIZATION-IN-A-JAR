/**
 * How a metric relates to time. Determines how it may be aggregated when a series
 * is downsampled.
 *  - stock:      a level measured at the sample tick (population, money supply).
 *  - flow:       an amount accumulated during the interval since the previous sample.
 *  - rate:       a dimensionless ratio of two quantities measured at the sample tick.
 *  - index:      a summary statistic of a distribution at the sample tick (Gini).
 *  - cumulative: a running total since genesis.
 */
export type MetricKind = 'stock' | 'flow' | 'rate' | 'index' | 'cumulative';

export type MetricUnit = 'persons' | 'cents' | 'ratio' | 'points' | 'celsius' | 'code';

export interface MetricDefinition {
  key: string;
  label: string;
  category: 'population' | 'activity' | 'needs' | 'money' | 'wealth' | 'environment';
  kind: MetricKind;
  unit: MetricUnit;
  description: string;
  /** Exact calculation, in words or notation. */
  formula: string;
}

export const METRIC_DEFINITIONS = [
  {
    key: 'population.total',
    label: 'Population',
    category: 'population',
    kind: 'stock',
    unit: 'persons',
    description: 'Living citizens.',
    formula: 'count(citizens)',
  },
  {
    key: 'population.children',
    label: 'Children',
    category: 'population',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens younger than the configured adult age.',
    formula: 'count(citizens where lifeStage = child)',
  },
  {
    key: 'population.adults',
    label: 'Adults',
    category: 'population',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens between the adult age and the elder age.',
    formula: 'count(citizens where lifeStage = adult)',
  },
  {
    key: 'population.elders',
    label: 'Elders',
    category: 'population',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens at or above the configured elder age.',
    formula: 'count(citizens where lifeStage = elder)',
  },
  {
    key: 'activity.sleeping',
    label: 'Sleeping',
    category: 'activity',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens asleep at home at the sample tick.',
    formula: 'count(citizens where activity = sleeping)',
  },
  {
    key: 'activity.atHome',
    label: 'At home (awake)',
    category: 'activity',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens awake at home at the sample tick.',
    formula: 'count(citizens where activity = at_home)',
  },
  {
    key: 'activity.leisure',
    label: 'At public venues',
    category: 'activity',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens at a plaza or park at the sample tick.',
    formula: 'count(citizens where activity = leisure)',
  },
  {
    key: 'activity.traveling',
    label: 'Travelling',
    category: 'activity',
    kind: 'stock',
    unit: 'persons',
    description: 'Citizens on the road at the sample tick.',
    formula: 'count(citizens where activity = traveling)',
  },
  {
    key: 'needs.energyMean',
    label: 'Mean energy',
    category: 'needs',
    kind: 'stock',
    unit: 'points',
    description: 'Average energy level (0 = exhausted, 100 = fully rested).',
    formula: 'Σ energy / population',
  },
  {
    key: 'needs.lowEnergyShare',
    label: 'Low-energy share',
    category: 'needs',
    kind: 'rate',
    unit: 'ratio',
    description: 'Share of citizens whose energy is below 20 (the sleep threshold).',
    formula: 'count(energy < 20) / population',
  },
  {
    key: 'money.supply',
    label: 'Money supply',
    category: 'money',
    kind: 'stock',
    unit: 'cents',
    description:
      'All money held in accounts. Must equal issued − destroyed (conservation invariant).',
    formula: 'Σ citizen balances',
  },
  {
    key: 'money.issuedCumulative',
    label: 'Money issued (cumulative)',
    category: 'money',
    kind: 'cumulative',
    unit: 'cents',
    description: 'Total money ever created by MoneyIssued events since genesis.',
    formula: 'ledger.issuedCents',
  },
  {
    key: 'wealth.meanAdult',
    label: 'Mean adult wealth',
    category: 'wealth',
    kind: 'stock',
    unit: 'cents',
    description:
      'Average net worth of adults and elders (children hold no wealth). Phase 1 net worth = account balance.',
    formula: 'Σ balance(adults ∪ elders) / count(adults ∪ elders)',
  },
  {
    key: 'wealth.medianAdult',
    label: 'Median adult wealth',
    category: 'wealth',
    kind: 'stock',
    unit: 'cents',
    description: 'Median net worth of adults and elders.',
    formula: 'median(balance(adults ∪ elders))',
  },
  {
    key: 'wealth.giniAdult',
    label: 'Wealth Gini (adults)',
    category: 'wealth',
    kind: 'index',
    unit: 'ratio',
    description:
      'Gini coefficient of adult and elder net worth. 0 = perfect equality, → 1 = maximal inequality.',
    formula: 'Σ_i (2i − n − 1)·x_(i) / (n·Σx), x sorted ascending',
  },
  {
    key: 'environment.temperatureC',
    label: 'Temperature',
    category: 'environment',
    kind: 'stock',
    unit: 'celsius',
    description: 'Air temperature at the sample hour.',
    formula: 'daily mean + hour-of-day offset',
  },
  {
    key: 'environment.weatherCode',
    label: 'Weather severity',
    category: 'environment',
    kind: 'stock',
    unit: 'code',
    description: 'Ordinal weather code: 0 clear, 1 cloudy, 2 rain, 3 storm.',
    formula: 'index of weather in [clear, cloudy, rain, storm]',
  },
] as const satisfies readonly MetricDefinition[];

export type MetricKey = (typeof METRIC_DEFINITIONS)[number]['key'];

export const METRIC_KEYS: readonly MetricKey[] = METRIC_DEFINITIONS.map((d) => d.key);

export type MetricValues = Record<MetricKey, number>;

export interface MetricSample {
  tick: number;
  values: MetricValues;
}

const byKey = new Map<string, MetricDefinition>(METRIC_DEFINITIONS.map((d) => [d.key, d]));

export function metricDefinition(key: string): MetricDefinition | undefined {
  return byKey.get(key);
}
