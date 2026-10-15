import type { CivilizationDetail } from '@civ/shared';
import { expect, test } from '@playwright/test';
import {
  createCivilization,
  deleteCivilization,
  expectTick,
  firstBuilding,
  liveTick,
  openObservatory,
  readTick,
  uniqueName,
} from './helpers';

let civ: CivilizationDetail | null = null;

test.afterEach(async ({ request }) => {
  await deleteCivilization(request, civ);
  civ = null;
});

test('stepping one day advances tick and calendar and records events', async ({
  page,
  request,
}) => {
  // One-day seasons: a SeasonStarted event is guaranteed at tick 24.
  civ = await createCivilization(request, uniqueName('E2E Step'), { daysPerSeason: 1 });
  await openObservatory(page, civ.id);
  await expectTick(page, 0);
  await expect(page.getByTestId('calendar')).toHaveText('Y1 spring D1 00:00');
  await expect(
    page.locator('[data-testid="event-item"][data-type="CivilizationFounded"]'),
  ).toBeVisible();

  await page.getByTestId('step-24').click();
  await expectTick(page, 24);
  await expect(page.getByTestId('calendar')).toHaveText('Y1 summer D1 00:00');
  await expect(
    page.locator(
      '[data-testid="event-feed"] [data-testid="event-item"][data-type="SeasonStarted"]',
    ),
  ).toBeVisible();
  await expect(page.getByTestId('durable-tick')).toHaveText('at tick 24');

  // The "." shortcut steps one tick; it is ignored while typing.
  await page.getByTestId('citizen-search').fill('.');
  await page.keyboard.press('.');
  await page.getByTestId('citizen-search').fill('');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('.');
  await expectTick(page, 25);
});

test('play then pause: the tick advances and then stops', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Play'));
  await openObservatory(page, civ.id);
  await page.getByTestId('speed-select').selectOption('25');
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'running');
  await expect.poll(() => readTick(page), { timeout: 15_000 }).toBeGreaterThan(3);
  await page.getByTestId('play-pause').click();
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'paused');
  const stopped = await readTick(page);
  await page.waitForTimeout(1_000);
  await expect(liveTick(page)).toHaveAttribute('data-tick', String(stopped));
});

test('selecting a citizen opens the inspector; the home link opens the building', async ({
  page,
  request,
}) => {
  civ = await createCivilization(request, uniqueName('E2E Inspect'));
  await openObservatory(page, civ.id);
  const row = page.getByTestId('citizen-row').first();
  const name = (await row.locator('.entity-name').textContent())?.trim() ?? '';
  await row.click();
  await expect(page.getByTestId('inspector-title')).toHaveText(name);
  await expect(page.getByTestId('citizen-balance')).toContainText('$');
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-selection', /^citizen:\d+$/);
  await expect(page.getByTestId('entity-timeline')).toBeVisible();

  await page.getByTestId('home-link').click();
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-selection', /^building:\d+$/);
  await expect(page.getByTestId('building-kind')).toHaveText('House');
  await expect(page.getByTestId('building-residents')).toContainText(name);
});

test('clicking a building on the map opens its inspector', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Map'));
  // At tick 0 (midnight) everyone sleeps at home, so public venues are empty.
  const plaza = await firstBuilding(request, civ.id, 'plaza');
  await openObservatory(page, civ.id);
  const handle = await page.waitForFunction(
    (id) => window.__civWorldTestHook?.screenPointOf({ kind: 'building', id }) ?? null,
    plaza.id,
    { timeout: 15_000 },
  );
  const point = (await handle.jsonValue()) as { x: number; y: number };
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('inspector')).toHaveAttribute(
    'data-selection',
    `building:${plaza.id}`,
  );
  await expect(page.getByTestId('inspector-title')).toHaveText(plaza.name);
});

test('save a snapshot, step, restore with confirmation', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Snap'));
  await openObservatory(page, civ.id);
  await page.keyboard.press('.');
  await expectTick(page, 1);

  await page.getByTestId('tab-snapshots').click();
  await page.getByTestId('snapshot-name').fill('Before day one');
  await page.getByTestId('snapshot-note').fill('saved by e2e');
  await page.getByTestId('snapshot-save').click();
  const snapRow = page.locator('[data-testid="snapshot-row"][data-name="Before day one"]');
  await expect(snapRow).toBeVisible();
  await expect(snapRow).toContainText('saved by e2e');

  await page.getByTestId('step-24').click();
  await expectTick(page, 25);

  await snapRow.getByTestId('snapshot-restore').click();
  const dialog = page.getByTestId('restore-dialog');
  await expect(dialog.getByTestId('confirm-submit')).toBeDisabled();
  await dialog.getByTestId('confirm-input').fill(civ.name);
  await dialog.getByTestId('confirm-submit').click();
  await expect(dialog).toBeHidden();
  await expectTick(page, 1);
});

test('reset requires typing the exact name and returns to genesis', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Reset'));
  await openObservatory(page, civ.id);
  await page.getByTestId('step-24').click();
  await expectTick(page, 24);

  await page.getByTestId('tab-lab').click();
  await page.getByTestId('reset-world').click();
  const dialog = page.getByTestId('reset-dialog');
  const submit = dialog.getByTestId('confirm-submit');
  await expect(submit).toBeDisabled();
  await dialog.getByTestId('confirm-input').fill(civ.name.toUpperCase());
  await expect(submit).toBeDisabled();
  await dialog.getByTestId('confirm-input').fill(civ.name.slice(0, -1));
  await expect(submit).toBeDisabled();
  await dialog.getByTestId('confirm-input').fill(civ.name);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  await expectTick(page, 0);
  await expect(page.getByTestId('calendar')).toHaveText('Y1 spring D1 00:00');
});
