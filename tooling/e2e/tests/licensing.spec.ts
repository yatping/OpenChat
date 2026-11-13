/** The AGPL source offer and the third-party notices. See docs/operations/licensing.md. */
import { expect, test } from '@playwright/test';
import { nextIp, signIn } from './helpers';
import { OWNER } from './fixtures';

test('the sign-in page and the dashboard offer the source and the notices', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextIp() });
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', /^https:\/\/github\.com\/yatping\/OpenChat/);
  await expect(footer.getByRole('link', { name: 'Third-party licences' })).toHaveAttribute('href', '/third-party-licenses.txt');
  await signIn(page, OWNER);
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Source code' })).toBeVisible();
});

test('serves the notices for the dashboard and the widget, but not the build output they come from', async ({ request }) => {
  const dashboard = await request.get('/third-party-licenses.txt');
  expect(dashboard.status()).toBe(200);
  expect(await dashboard.text()).toMatch(/^react-dom \d/m);
  const widget = await request.get('/widget/third-party-licenses.txt');
  expect(widget.status()).toBe(200);
  expect(await widget.text()).toMatch(/^preact \d[\s\S]*MIT License/m);
  // An unknown path gets the dashboard page, so the JSON must not come back.
  expect(await (await request.get('/.vite/license.json')).text()).not.toContain('"identifier"');
});
