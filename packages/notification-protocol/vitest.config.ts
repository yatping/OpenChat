import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['test/**/*.test.ts'] } },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './test/wrangler.jsonc' } })],
        test: { name: 'workerd', include: ['test/**/*.test.ts'] },
      },
    ],
  },
});
