import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';

describe('/.well-known/security.txt', () => {
  const securityApp = createApp();
  const get = (environment: Partial<Env>) => securityApp.request('https://relay.example.org/.well-known/security.txt', {}, { ...env, ...environment } as unknown as Env);

  it('does not exist until the operator sets a contact', async () => {
    expect((await get({})).status).toBe(404);
  });

  it('names the relay operator', async () => {
    const response = await get({ SECURITY_CONTACT: 'https://github.com/yatping/OpenChat/security/advisories/new' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('notification relay');
    expect(text).toContain('Contact: https://github.com/yatping/OpenChat/security/advisories/new\n');
    expect(text).toContain('Canonical: https://relay.example.org/.well-known/security.txt\n');
  });
});
