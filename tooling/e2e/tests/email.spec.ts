import { expect, test } from '@playwright/test';
import { OWNER } from './fixtures';
import { signIn } from './helpers';

test('a supervisor can keep an address from being emailed', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'email' }).click();
  const address = `blocked-${Date.now()}@example.com`;
  const list = page.getByRole('region', { name: 'Addresses not to email' });
  await list.getByLabel('Email address').fill(address);
  await list.getByRole('button', { name: 'Add' }).click();
  const row = list.getByRole('listitem').filter({ hasText: address });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toBeHidden();
});

test('a supervisor can add, turn off, and delete a follow-up rule', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'email' }).click();
  const panel = page.getByRole('region', { name: 'Follow-up emails' });
  const name = `Rule ${Date.now()}`;
  await panel.getByLabel('Rule name').fill(name);
  await panel.getByLabel('After minutes').fill('120');
  await panel.getByRole('button', { name: 'Add rule' }).click();
  const row = panel.getByRole('listitem').filter({ hasText: `${name}, after 2 hours` });
  await expect(row.getByRole('checkbox')).toBeChecked();
  await row.getByRole('checkbox').click();
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toBeHidden();
});
