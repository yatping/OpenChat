import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Generated per run, so that no private key is committed, even a test one.
const { privateKey, publicKey } = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
const encode = async (format: 'pkcs8' | 'raw', key: CryptoKey) => Buffer.from(await crypto.subtle.exportKey(format, key) as ArrayBuffer).toString('base64url');
const AUTH_SIGNING_KEY = JSON.stringify({
  active: { kid: 'test', privateKey: await encode('pkcs8', privateKey), publicKey: await encode('raw', publicKey) },
});

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.template.jsonc' },
      miniflare: { bindings: { AUTH_SIGNING_KEY, TEST_MIGRATIONS: await readD1Migrations('../../packages/database/migrations') } },
    }),
  ],
  // These tests use real scrypt, on purpose, and some hash over 20 times. CI runners are much slower than laptops.
  test: { setupFiles: ['./test/setup.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
}));
