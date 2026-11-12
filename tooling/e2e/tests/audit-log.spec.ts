import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { OWNER, PASSWORD, WORKSPACE_ID } from './fixtures';
import { nextIp, signIn } from './helpers';

/** Changes the E2E workspace's retention, then sets it back, so that no other test sees a difference. */
async function changeRetentionAndBack() {
  const login = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
    body: JSON.stringify({ email: OWNER.email, password: PASSWORD, clientType: 'mobile' }),
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  for (const retentionDays of [365, null]) {
    const response = await fetch(`${BASE_URL}/api/v1/admin/workspaces/${WORKSPACE_ID}/retention`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp(), authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ retentionDays }),
    });
    expect(response.status).toBe(200);
  }
}

test('an installation admin reads what was changed, in words, and filters by workspace', async ({ page }) => {
  await changeRetentionAndBack();
  await signIn(page, OWNER);
  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  const log = page.getByRole('region', { name: 'Audit log' });
  const changed = log.getByRole('listitem').filter({ hasText: 'changed how long E2E keeps closed conversations, from forever to 1 year' });
  await expect(changed.first()).toContainText(OWNER.name);
  await expect(log.getByRole('listitem').filter({ hasText: 'from 1 year to forever' }).first()).toBeVisible();

  await log.getByLabel('Show').selectOption({ label: 'Workspace E2E' });
  await expect(changed.first()).toBeVisible();
  await expect(log.getByRole('listitem').first()).toContainText('Workspace E2E');
});
