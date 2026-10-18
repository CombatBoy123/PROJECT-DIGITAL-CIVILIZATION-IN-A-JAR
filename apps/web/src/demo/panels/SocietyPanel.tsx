import { METRIC_DEFINITIONS, type MetricDefinition, type MetricKey } from '@civ/sim-core';
import { useState } from 'react';
import { formatDecimal, formatMetricValue, UNIT_LABELS } from '../../lib/format';
import { ACTIVITY_COLORS, cssColor } from '../../world/palette';
import { useDemo } from '../context';
import { Meter, Section } from '../ui';

/*
 * Live statistics from computeMetrics, one stat tile per metric. Each tile shows the
 * metric's label, value, unit and kind; tapping it reveals the written definition
 * and formula from METRIC_DEFINITIONS.
 */

const DEFINITIONS = new Map<string, MetricDefinition>(METRIC_DEFINITIONS.map((d) => [d.key, d]));

const ACTIVITY_OF: Partial<Record<MetricKey, keyof typeof ACTIVITY_COLORS>> = {
  'activity.sleeping': 'sleeping',
  'activity.atHome': 'at_home',
  'activity.leisure': 'leisure',
  'activity.traveling': 'traveling',
};

const GROUPS: { title: string; keys: MetricKey[]; note?: string }[] = [
  {
    title: 'Population by life stage',
    keys: ['population.total', 'population.children', 'population.adults', 'population.elders'],
    note: 'Births, deaths and migration are not simulated yet, so the total stays constant; people age and change life stage.',
  },
  {
    title: 'What people are doing',
    keys: ['activity.sleeping', 'activity.atHome', 'activity.leisure', 'activity.traveling'],
  },
  { title: 'Energy', keys: ['needs.energyMean', 'needs.lowEnergyShare'] },
  {
    title: 'Money and wealth',
    keys: ['money.supply', 'wealth.medianAdult', 'wealth.giniAdult'],
    note: 'Money exists only as the endowments handed out at genesis. There are no jobs, trade or prices yet, so these numbers do not change until the economy arrives in a later phase.',
  },
];

function StatTile({
  definition,
  value,
  expanded,
  onToggle,
}: {
  definition: MetricDefinition;
  value: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const activity = ACTIVITY_OF[definition.key as MetricKey];
  const detailId = `metric-${definition.key.replace('.', '-')}`;
  return (
    <li className={`stat ${expanded ? 'stat-open' : ''}`}>
      <button
        type="button"
        className="stat-button"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={onToggle}
        data-metric={definition.key}
      >
        <span className="stat-label">
          {activity && (
            <span
              className="swatch"
              aria-hidden="true"
              style={{ background: cssColor(ACTIVITY_COLORS[activity]) }}
            />
          )}
          {definition.label}
        </span>
        <span className="stat-value">{formatMetricValue(definition.unit, value)}</span>
        <span className="stat-unit">
          {UNIT_LABELS[definition.unit]} · {definition.kind}
        </span>
      </button>
      <div id={detailId} className="stat-detail" hidden={!expanded}>
        <p>{definition.description}</p>
        <p className="stat-formula">
          <span className="muted">Formula </span>
          <code>{definition.formula}</code>
        </p>
      </div>
    </li>
  );
}

export function SocietyPanel() {
  const { engine } = useDemo();
  const [open, setOpen] = useState<string | null>(null);
  const metrics = engine.metrics;
  const energy = metrics['needs.energyMean'];
  return (
    <div className="society" data-testid="society">
      <p className="muted small">
        Live from the engine at the current hour. Tap a tile for its definition.
      </p>
      {GROUPS.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.keys.includes('needs.energyMean') && (
            <Meter
              label="Mean energy"
              value={energy}
              display={formatDecimal(energy, 1)}
              tone="data"
            />
          )}
          <ul className="stat-grid">
            {group.keys.map((key) => {
              const def = DEFINITIONS.get(key);
              if (!def) return null;
              return (
                <StatTile
                  key={key}
                  definition={def}
                  value={metrics[key]}
                  expanded={open === key}
                  onToggle={() => setOpen((k) => (k === key ? null : key))}
                />
              );
            })}
          </ul>
          {group.note && <p className="note">{group.note}</p>}
        </Section>
      ))}
    </div>
  );
}
