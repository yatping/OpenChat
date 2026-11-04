import { defineConfig, devices } from '@playwright/test';

export const BASE_URL = 'http://localhost:8799';

// The tests share one local Worker and one workspace hub, so they run one at a time.
export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  // The widget tests serve a page from a public-looking address, and Chromium otherwise refuses it the local Worker.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } } }],
  webServer: {
    command: 'pnpm exec tsx start-server.ts',
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
