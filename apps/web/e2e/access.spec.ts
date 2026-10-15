import type { CivilizationDetail, MetaResponse } from '@civ/shared';
import { expect, test, type Page } from '@playwright/test';
import {
  createCivilization,
  deleteCivilization,
  expectTick,
  openObservatory,
  uniqueName,
} from './helpers';

/*
 * Operator-only controls under AUTH_MODE=token. The e2e server runs with auth
 * disabled, so the browser is shown a token-mode /api/meta and, for the viewer
 * case, the server's 403 answer to a viewer token on operator routes.
 */

let civ: CivilizationDetail | null = null;

test.afterEach(async ({ request }) => {
  await deleteCivilization(request, civ);
  civ = null;
});

async function serveTokenMode(page: Page): Promise<void> {
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    const meta = (await response.json()) as MetaResponse;
    await route.fulfill({
      response,
      json: { ...meta, authMode: 'token', readRequiresToken: false } satisfies MetaResponse,
    });
  });
}

/** Answer every operator route like the server answers a viewer token. */
async function rejectAsViewer(page: Page): Promise<{ count: () => number }> {
  let rejected = 0;
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const method = route.request().method();
      if (method === 'GET' || method === 'HEAD') return route.fallback();
      rejected++;
      await route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: 'Operator token required for this action' } },
      });
    },
  );
  return { count: () => rejected };
}

async function useToken(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('civ.accessToken', t), token);
}

test('a viewer token disables operator controls and says why', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Viewer'));
  await serveTokenMode(page);
  const rejected = await rejectAsViewer(page);
  await useToken(page, 'viewer-e2e');

  await openObservatory(page, civ.id);
  const play = page.getByTestId('play-pause');
  // Until the server has answered, the token's role is unknown.
  await expect(page.getByTestId('auth-button')).toHaveText('Token set (unverified)');
  await expect(play).toBeEnabled();

  await play.click();
  await expect(page.getByTestId('auth-button')).toHaveText('Viewer token');
  await expect(play).toBeDisabled();
  await expect(page.getByTestId('step-1')).toBeDisabled();
  await expect(page.getByTestId('speed-select')).toBeDisabled();
  const note = page.locator('.playback').getByTestId('access-note');
  await expect(note).toContainText('viewer token');
  await expect(play).toHaveAttribute('aria-describedby', (await note.getAttribute('id')) ?? '');

  // The shortcuts do nothing either.
  const before = rejected.count();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await page.keyboard.press('.');
  await expectTick(page, 0);
  expect(rejected.count()).toBe(before);

  await page.getByTestId('tab-lab').click();
  await expect(page.getByTestId('reset-world')).toBeDisabled();
  await page.getByTestId('tab-snapshots').click();
  await page.getByTestId('snapshot-name').fill('viewer attempt');
  await expect(page.getByTestId('snapshot-save')).toBeDisabled();
  await expect(page.locator('.obs-bottom').getByTestId('access-note').first()).toBeVisible();

  // The verdict survives a reload: nothing is offered before the next failure.
  await page.reload();
  await expect(page.getByTestId('play-pause')).toBeDisabled();

  await page.goto('/');
  const row = page.locator(`[data-testid="civilization-row"][data-name="${civ.name}"]`);
  await expect(row.getByTestId('delete-civilization')).toBeDisabled();
  await expect(page.getByTestId('create-submit')).toBeDisabled();

  // Saving the token again forgets the verdict so it can be re-learned.
  await page.getByTestId('auth-button').click();
  await page.getByRole('button', { name: 'Save token' }).click();
  await expect(page.getByTestId('auth-button')).toHaveText('Token set (unverified)');
  await expect(page.getByTestId('create-submit')).toBeEnabled();
});

test('without a token, token-mode controls are disabled with a prompt', async ({
  page,
  request,
}) => {
  civ = await createCivilization(request, uniqueName('E2E Anonymous'));
  await serveTokenMode(page);
  await page.goto(`/civ/${civ.id}`);
  // The token prompt opens on load; dismiss it.
  await expect(page.getByRole('dialog', { name: 'Access token' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('play-pause')).toBeDisabled();
  await expect(page.locator('.playback').getByTestId('access-note')).toContainText(
    'Enter access token',
  );
});

test('an accepted control action confirms the operator token', async ({ page, request }) => {
  civ = await createCivilization(request, uniqueName('E2E Operator'));
  await serveTokenMode(page);
  await useToken(page, 'operator-e2e');
  await openObservatory(page, civ.id);
  await expect(page.getByTestId('auth-button')).toHaveText('Token set (unverified)');
  await page.getByTestId('step-1').click();
  await expectTick(page, 1);
  await expect(page.getByTestId('auth-button')).toHaveText('Operator token');
  await expect(page.getByTestId('play-pause')).toBeEnabled();
});
