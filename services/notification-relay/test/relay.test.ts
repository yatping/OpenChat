import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const self = (exports as unknown as { default: Fetcher }).default;

describe('relay', () => {
  it('reports health', async () => {
    const response = await self.fetch('https://relay.example/health');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('refuses an unsigned notification', async () => {
    const response = await self.fetch('https://relay.example/v1/notifications/send', { method: 'POST', body: '{}' });
    expect(response.status).toBe(400);
  });
});
