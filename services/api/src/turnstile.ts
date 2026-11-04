/** Asks Cloudflare about a Turnstile token. A token and the secret are never logged. */
import type { TurnstileVerifier } from '@openchat/core';
import type { Env } from './env';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/** Both keys or none: one without the other could never work. */
export function turnstileFor(env: Env): TurnstileVerifier | undefined {
  const { TURNSTILE_SECRET_KEY: secret, TURNSTILE_SITE_KEY: siteKey } = env;
  if (!secret || !siteKey) return undefined;
  return {
    siteKey,
    async verify(token, ip) {
      const response = await fetch(SITEVERIFY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, response: token, ...(ip === 'unknown' ? {} : { remoteip: ip }) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Siteverify answers 400 for a bad token, with a body. Anything else without one is an outage.
      const body = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (typeof body.success !== 'boolean' || body['error-codes']?.includes('internal-error') || body['error-codes']?.includes('invalid-input-secret')) throw new Error('Turnstile could not answer');
      return body.success;
    },
  };
}
