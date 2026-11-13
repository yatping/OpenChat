/** The dashboard's languages. See docs/architecture/dashboard.md#languages. */
import { expect, test } from '@playwright/test';
import { nextIp, signIn } from './helpers';
import { OWNER } from './fixtures';

test.describe('languages', () => {
  test.use({ locale: 'de-DE' });

  test('speaks the browser’s language, and keeps the one chosen instead', async ({ page }) => {
    await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextIp() });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();

    await page.getByRole('combobox', { name: 'Sprache' }).selectOption('ja');
    await expect(page.getByRole('button', { name: 'サインイン' })).toBeVisible();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

    await page.getByRole('combobox', { name: '言語' }).selectOption('en');
    await signIn(page, OWNER);
    await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
  });
});
