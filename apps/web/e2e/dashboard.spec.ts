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
