import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Generated per run, so that no private key is committed, even a test one.
const { privateKey, publicKey } = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
// The parser ignores PEM armour, so plain base64 is enough here. The real .p8 form was tested on a deployment.
const APNS_PRIVATE_KEY = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
const TEST_APNS_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', publicKey)).toString('base64');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.template.jsonc' },
      miniflare: {
        bindings: { APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567', APNS_PRIVATE_KEY, APNS_SELF_CHECK_TOPIC: 'com.example.app', RELAY_OPERATOR_TOKEN: 'test-operator-token', TEST_APNS_PUBLIC_KEY },
      },
    }),
  ],
});
