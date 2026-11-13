import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const get = (environment: Partial<Env>) =>
  worker.fetch(new Request('https://chat.example.com/.well-known/security.txt'), { ...env, ...environment } as unknown as Env, createExecutionContext());

describe('/.well-known/security.txt', () => {
  it('does not exist until the operator sets a contact', async () => {
    expect((await get({})).status).toBe(404);
    expect((await get({ SECURITY_CONTACT: 'not a contact' })).status).toBe(404);
  });

  it('names the operator as plain text, at its own address', async () => {
    const response = await get({ SECURITY_CONTACT: 'mailto:security@example.com', SECURITY_POLICY: 'https://example.com/disclosure' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await response.text();
    expect(text).toContain('Contact: mailto:security@example.com\n');
    expect(text).toContain('Policy: https://example.com/disclosure\n');
    expect(text).toContain('Canonical: https://chat.example.com/.well-known/security.txt\n');
    expect(text).toMatch(/^Expires: \d{4}-\d\d-\d\dT00:00:00Z$/m);
  });
});
