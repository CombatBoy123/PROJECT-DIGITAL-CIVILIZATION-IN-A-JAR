import { expect, test } from '@playwright/test';
import { deleteCivilization, expectTick, uniqueName } from './helpers';

test.describe('civilizations', () => {
  test('create from the UI, open the observatory, then delete with typed confirmation', async ({
    page,
    request,
  }) => {
    const name = uniqueName('E2E Genesis');
    let created: { id: string; name: string } | null = null;
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Civilizations' })).toBeVisible();

      await page.getByTestId('field-name').fill(name);
      await page.getByTestId('field-population').fill('24');
      // Client-side validation from the shared schema.
      await page.getByTestId('field-seed').fill('not a valid seed!');
      await page.getByTestId('create-submit').click();
      await expect(page.locator('.field-error').first()).toBeVisible();
      await page.getByTestId('field-seed').fill('');

      await page.getByText('Advanced parameters').click();
      await expect(page.getByTestId('field-daysPerSeason')).toHaveValue('7');
      await page.getByTestId('create-submit').click();

      await expect(page).toHaveURL(/\/civ\/[0-9a-f-]{36}$/);
      const id = page.url().split('/civ/')[1] ?? '';
      created = { id, name };

      await expect(page.getByTestId('civ-name')).toHaveText(name);
      await expect(page.getByTestId('status-pill').first()).toHaveAttribute(
        'data-status',
        'paused',
      );
      // The server generated a seed and the UI shows it.
      await expect(page.getByTestId('civ-seed')).toContainText(/seed \S+/);
      await expectTick(page, 0);
      await expect(page.getByTestId('citizen-count')).toHaveAttribute('data-total', '24');
      // Soft: a missing renderer is reported without skipping the deletion flow below.
      await expect.soft(page.locator('.obs-map canvas')).toBeVisible();

      // Delete from the home page.
      await page.goto('/');
      const row = page.locator(`[data-testid="civilization-row"][data-name="${name}"]`);
      await expect(row).toBeVisible();
      await row.getByTestId('delete-civilization').click();
      const dialog = page.getByTestId('delete-dialog');
      await expect(dialog.getByTestId('confirm-submit')).toBeDisabled();
      await dialog.getByTestId('confirm-input').fill(`${name}x`);
      await expect(dialog.getByTestId('confirm-submit')).toBeDisabled();
      await dialog.getByTestId('confirm-input').fill(name);
      await dialog.getByTestId('confirm-submit').click();
      await expect(row).toHaveCount(0);
      created = null;
    } finally {
      await deleteCivilization(request, created);
    }
  });
});
