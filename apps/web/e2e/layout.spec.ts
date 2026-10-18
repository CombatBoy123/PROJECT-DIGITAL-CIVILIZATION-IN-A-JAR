import type { CivilizationDetail } from '@civ/shared';
import { expect, test, type Page } from '@playwright/test';
import { createCivilization, deleteCivilization, stepViaApi, uniqueName } from './helpers';

/*
 * Phone-width layout: no page may scroll sideways (wide tables scroll inside their
 * own container instead).
 */

let civ: CivilizationDetail | null = null;

test.use({ viewport: { width: 390, height: 844 } });

test.afterEach(async ({ request }) => {
  await deleteCivilization(request, civ);
  civ = null;
});

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBe(
    clientWidth,
  );
}

test('no page scrolls horizontally at 390px', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Mobile'));
  await stepViaApi(request, civ.id, 2);

  await page.goto('/');
  await expect(page.getByTestId('civilization-table')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto(`/civ/${civ.id}`);
  await expect(page.getByTestId('observatory')).toBeVisible();
  await expectNoHorizontalScroll(page);
  for (const tab of ['snapshots', 'lab', 'audit'] as const) {
    await page.getByTestId(`tab-${tab}`).click();
    await expectNoHorizontalScroll(page);
  }

  await page.goto(`/civ/${civ.id}/dashboard`);
  await expect(page.getByTestId('metric-chart').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});
