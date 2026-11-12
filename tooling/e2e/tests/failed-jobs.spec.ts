import { expect, test } from '@playwright/test';
import { OWNER } from './fixtures';
import { signIn } from './helpers';

test('an installation admin replays a failed job, and dismisses one that cannot be replayed', async ({ page }) => {
  await signIn(page, OWNER);
  await page.getByRole('button', { name: 'Failed jobs', exact: true }).click();
  const jobs = page.getByRole('region', { name: 'Failed jobs' });
  await expect(jobs).toBeVisible();

  const check = jobs.getByRole('listitem', { name: 'Check follow-up rules' });
  await expect(check).toContainText('Workspace E2E');
  await check.getByRole('button', { name: 'Replay' }).click();
  await expect(check).toContainText('Replayed');
  await expect(check.getByRole('button', { name: 'Replay' })).toBeHidden();

  const stale = jobs.getByRole('listitem', { name: 'Follow-up email' });
  await expect(stale).toContainText('cannot be replayed');
  await expect(stale.getByRole('button', { name: 'Replay' })).toBeHidden();
  await stale.getByRole('button', { name: 'Dismiss' }).click();
  await expect(stale).toBeHidden();
});
