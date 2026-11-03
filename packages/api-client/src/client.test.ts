import { describe, expect, expectTypeOf, it } from 'vitest';
import { ApiError, createClient, type DiscoveryResponse, type HealthResponse } from './index';

const stub = (status: number, body: unknown) => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('api client', () => {
  it('derives types from the contract', () => {
    expectTypeOf<HealthResponse>().toEqualTypeOf<{ status: 'ok' }>();
    expectTypeOf<DiscoveryResponse['installationId']>().toEqualTypeOf<string>();
    expectTypeOf<DiscoveryResponse['auth']['signup']>().toEqualTypeOf<'invite_only' | 'open'>();
  });

  it('calls the installation it is bound to, with the token', async () => {
    const { calls, fetch } = stub(200, { status: 'ok' });
    const client = createClient({ baseUrl: 'https://a.example/', getAccessToken: () => 'tok', fetch });
    expect(await client.getHealth()).toEqual({ status: 'ok' });
    expect(calls[0]?.url).toBe('https://a.example/health');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok');
  });

  it('surfaces problem details', async () => {
    const { fetch } = stub(503, { code: 'not_initialized', title: 'Not ready', requestId: 'req_1' });
    const error = await createClient({ baseUrl: 'https://a.example', fetch }).getDiscovery().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: 'not_initialized', requestId: 'req_1' });
  });
});
