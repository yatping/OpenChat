import { expect, test } from '@playwright/test';
import { OWNER } from './fixtures';
import { signIn } from './helpers';

test('an installation admin sets how long a workspace keeps closed conversations', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await signIn(page, OWNER);
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  const retention = page.getByRole('region', { name: 'Retention' });
  const select = retention.getByLabel('Keep closed conversations');
  await expect(select).toHaveValue('');
  await select.selectOption('90');
  await retention.getByRole('button', { name: 'Save retention' }).click();
  await expect(retention.getByRole('button', { name: 'Save retention' })).toBeDisabled();

  await page.reload();
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await expect(select).toHaveValue('90');

  // Back to keeping everything, so that no other test meets a sweep.
  await select.selectOption('');
  await retention.getByRole('button', { name: 'Save retention' }).click();
  await expect(retention.getByRole('button', { name: 'Save retention' })).toBeDisabled();
  await expect(select).toHaveValue('');
});
