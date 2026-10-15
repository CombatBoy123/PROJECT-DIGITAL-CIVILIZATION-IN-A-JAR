import type { CivilizationDetail } from '@civ/shared';
// Playwright's loader does not apply the `source` export condition, so runtime values
// from workspace packages are imported from their source files directly.
import { METRIC_DEFINITIONS } from '../../../packages/sim-core/src/metrics/definitions';
import { expect, test } from '@playwright/test';
import { createCivilization, deleteCivilization, stepViaApi, uniqueName } from './helpers';

let civ: CivilizationDetail | null = null;

test.afterEach(async ({ request }) => {
  await deleteCivilization(request, civ);
  civ = null;
});

test('dashboard charts every metric with its definition', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Dash'), { daysPerSeason: 1 });
  await stepViaApi(request, civ.id, 48);

  await page.goto(`/civ/${civ.id}`);
  await page.getByTestId('nav-dashboard').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();

  const charts = page.getByTestId('metric-chart');
  await expect(charts).toHaveCount(METRIC_DEFINITIONS.length);
  // Every chart plots real samples (a line is drawn).
  await expect(page.locator('[data-testid="metric-chart"] .recharts-area-curve')).toHaveCount(
    METRIC_DEFINITIONS.length,
  );

  const population = page.locator('[data-testid="metric-chart"][data-metric="population.total"]');
  await population.getByText('Definition').click();
  await expect(population.getByTestId('metric-formula')).toHaveText('count(citizens)');
  await expect(population.locator('.chart-latest')).toContainText('20');

  // Season starts (ticks 24 and 48) are marked on the time axis.
  await expect(population.locator('.recharts-reference-line')).toHaveCount(2);

  // Range presets refetch the same charts.
  await page.getByTestId('range-day').click();
  await expect(page.getByTestId('range-day')).toHaveAttribute('aria-checked', 'true');
  await expect(charts).toHaveCount(METRIC_DEFINITIONS.length);

  // Events of the range link back into the observatory.
  await page.getByTestId('range-all').click();
  await expect(page.getByTestId('range-events')).toBeVisible();
  await page.getByTestId('nav-observatory').click();
  await expect(page.getByTestId('observatory')).toBeVisible();
});

test('season labels never overlap and axis labels are distinct', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Seasons'), { daysPerSeason: 1 });
  await stepViaApi(request, civ.id, 600);
  await page.goto(`/civ/${civ.id}/dashboard`);
  const population = page.locator('[data-testid="metric-chart"][data-metric="population.total"]');
  // 25 season starts (every 24 ticks): every one keeps its line.
  await expect(population.locator('.recharts-reference-line')).toHaveCount(25);

  const charts = page.getByTestId('metric-chart');
  await expect(charts.first().locator('.chart-season-label').first()).toBeVisible();
  for (const chart of await charts.all()) {
    const boxes = await chart.locator('.chart-season-label').evaluateAll((labels) =>
      labels.map((l) => {
        const r = l.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.length).toBeLessThan(25);
    boxes.sort((a, b) => a.left - b.left);
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
    }
    const ticks = await chart
      .locator('.recharts-yAxis .recharts-cartesian-axis-tick-value')
      .allTextContents();
    expect(new Set(ticks).size, ticks.join(' | ')).toBe(ticks.length);
    // Shares stay within 0–100 %.
    for (const t of ticks.filter((x) => x.endsWith('%')))
      expect(Number.parseFloat(t)).toBeLessThanOrEqual(100);
  }
});

test('an invalid custom range hides the previous range’s charts', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Range'));
  await stepViaApi(request, civ.id, 30);
  await page.goto(`/civ/${civ.id}/dashboard`);
  await expect(page.getByTestId('metric-chart').first()).toBeVisible();
  await expect(page.getByText(/^Ticks \d/)).toBeVisible();

  await page.getByTestId('range-custom').click();
  await page.getByLabel('From tick').fill('20');
  await page.getByLabel('To tick').fill('10');
  await expect(page.getByRole('alert')).toContainText('“from” not after “to”');
  await expect(page.getByTestId('metric-chart')).toHaveCount(0);
  await expect(page.getByText(/^Ticks /)).toHaveCount(0);

  await page.getByLabel('To tick').fill('25');
  await expect(page.getByTestId('metric-chart').first()).toBeVisible();
  await expect(page.getByText(/^Ticks \d/)).toBeVisible();
});
