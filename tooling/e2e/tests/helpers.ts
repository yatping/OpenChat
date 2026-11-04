import { expect, type Page } from '@playwright/test';
import { PASSWORD } from './fixtures';

let ips = 0;
/** Its own address each time, so that sign-in limits never decide a result here. */
export const nextIp = () => `198.51.100.${++ips % 250}`;

export async function signIn(page: Page, who: { email: string }) {
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': nextIp() });
  await page.goto('/');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('region', { name: 'Conversations' })).toBeVisible();
}
