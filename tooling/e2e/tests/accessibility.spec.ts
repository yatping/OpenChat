/**
 * Automated accessibility checks: axe-core against WCAG 2.2 A and AA on each screen, in light and dark. Axe finds
 * about a third of real problems, so docs/architecture/accessibility.md lists what was checked by hand too.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { OWNER, SITE_ORIGIN, STYLED_WEBSITE_KEY, WEBSITE_KEY } from './fixtures';
import { nextIp, signIn } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(page: Page, include?: string) {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  if (include) builder.include(include);
  const { violations } = await builder.analyze();
  return violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5), help: v.help }));
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('the sign-in and password pages', async ({ page }) => {
      await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextIp() });
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await page.goto('/forgot-password');
      await expect(page.getByRole('heading').first()).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

    test('the inbox, with a conversation open', async ({ page }) => {
      await signIn(page, OWNER);
      const first = page.getByRole('region', { name: 'Conversations' }).getByRole('button').first();
      if (await first.isVisible()) await first.click();
      expect(await violations(page)).toEqual([]);
    });

    // Each waits for something only the loaded screen has. The dashboard keeps a socket open, so the network is never idle.
    const sections = { websites: (p: Page) => p.getByRole('heading', { name: 'Shop' }), members: (p: Page) => p.getByRole('listitem').filter({ hasText: OWNER.email }), email: (p: Page) => p.getByRole('region', { name: 'Follow-up emails' }) };
    for (const [section, loaded] of Object.entries(sections)) {
      test(`the ${section} section`, async ({ page }) => {
        await signIn(page, OWNER);
        await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: section, exact: true }).click();
        await expect(loaded(page).first()).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    }

    const admin = { People: (p: Page) => p.getByRole('listitem').filter({ hasText: OWNER.email }), Workspaces: (p: Page) => p.getByRole('region', { name: 'Retention' }), 'Failed jobs': (p: Page) => p.getByRole('region', { name: 'Failed jobs' }).getByRole('listitem').or(p.getByText('No failed jobs.')), 'Audit log': (p: Page) => p.getByRole('region', { name: 'Audit log' }).getByRole('listitem').or(p.getByText('Nothing recorded yet.')) };
    for (const [name, loaded] of Object.entries(admin)) {
      test(`the ${name} page`, async ({ page }) => {
        await signIn(page, OWNER);
        await page.getByRole('button', { name, exact: true }).click();
        await expect(loaded(page).first()).toBeVisible();
        expect(await violations(page)).toEqual([]);
      });
    }

    for (const [name, key] of [['plain', WEBSITE_KEY], ['styled, asking for an email first', STYLED_WEBSITE_KEY]] as const) {
      test(`the widget, ${name}`, async ({ browser }) => {
        const context = await browser.newContext({ colorScheme: scheme, extraHTTPHeaders: { 'cf-connecting-ip': nextIp() } });
        await context.route(`${SITE_ORIGIN}/**`, (route) =>
          route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><title>Shop</title></head><body><main><h1>Shop</h1></main><script src="${BASE_URL}/widget/widget.js" data-website-key="${key}" async></script></body></html>` }),
        );
        const page = await context.newPage();
        await page.goto(`${SITE_ORIGIN}/`);
        const launcher = page.locator('#openchat-widget .oc-launcher');
        await expect(launcher).toBeVisible();
        expect(await violations(page, '#openchat-widget')).toEqual([]);
        await launcher.click();
        await expect(page.getByRole('dialog', { name: 'Chat' })).toBeVisible();
        // Contrast is only meaningful once the panel has faded in.
        await page.waitForFunction(() => (document.getElementById('openchat-widget')?.shadowRoot?.getAnimations() ?? []).every((a) => a.playState === 'finished'));
        expect(await violations(page, '#openchat-widget')).toEqual([]);
        await context.close();
      });
    }
  });
}

// WCAG 1.4.10: at 320 CSS pixels wide, which is 1280 at 400% zoom, nothing scrolls sideways.
test('every dashboard screen fits 320 pixels without scrolling sideways', async ({ page }) => {
  await signIn(page, OWNER);
  await page.setViewportSize({ width: 320, height: 700 });
  const fits = async (screen: string) => expect(await page.evaluate(() => document.documentElement.scrollWidth), screen).toBeLessThanOrEqual(320);
  await expect(page.getByRole('main')).toBeVisible();
  await fits('inbox');
  for (const section of ['websites', 'members', 'email']) {
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: section, exact: true }).click();
    await page.waitForTimeout(500);
    await fits(section);
  }
  for (const name of ['People', 'Workspaces', 'Failed jobs', 'Audit log']) {
    await page.getByRole('navigation', { name: 'Administration' }).getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(500);
    await fits(name);
  }
});
