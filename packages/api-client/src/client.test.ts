import { describe, expect, expectTypeOf, it, vi } from 'vitest';
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

  it('sends and receives a file as bytes, for React Native', async () => {
    const seen: { url: string; type: string | null; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, type: new Headers(init.headers).get('content-type'), body: init.body });
      return init.method === 'GET' ? new Response(new Uint8Array([1, 2, 3])) : new Response(JSON.stringify({ id: 'att_1' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const client = createClient({ baseUrl: 'https://a.example', fetch });
    const data = new Uint8Array([9, 8]);

    expect(await client.uploadAttachmentBytes('w 1', 'c1', { filename: 'a b.png', contentType: 'image/png', data })).toEqual({ id: 'att_1' });
    expect(seen[0]).toEqual({ url: 'https://a.example/api/v1/workspaces/w%201/conversations/c1/attachments?filename=a%20b.png', type: 'image/png', body: data });

    const bytes = await client.downloadAttachmentBytes('/api/v1/workspaces/w/attachments/a1');
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
  });

  it('surfaces problem details', async () => {
    const { fetch } = stub(503, { code: 'not_initialized', title: 'Not ready', requestId: 'req_1' });
    const error = await createClient({ baseUrl: 'https://a.example', fetch }).getDiscovery().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503, code: 'not_initialized', requestId: 'req_1' });
  });
});

describe('when a token has expired', () => {
  const problem = () => new Response(JSON.stringify({ code: 'unauthorized', title: 'Sign in again' }), { status: 401 });
  const me = () => new Response(JSON.stringify({ id: 'u', email: 'e', name: 'n', memberships: [] }));

  it('refreshes once and retries with the new token', async () => {
    let token = 'old';
    const fetcher = vi.fn<typeof fetch>((_url, init) => Promise.resolve(new Headers(init?.headers).get('authorization') === 'Bearer new' ? me() : problem()));
    const client = createClient({
      baseUrl: 'https://x.test',
      fetch: fetcher,
      getAccessToken: () => token,
      onUnauthorized: () => {
        token = 'new';
        return Promise.resolve(true);
      },
    });
    expect((await client.getMe()).id).toBe('u');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(problem()));
    const onUnauthorized = vi.fn(() => Promise.resolve(true));
    await expect(createClient({ baseUrl: 'https://x.test', fetch: fetcher, onUnauthorized }).getMe()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('handles an empty success, and encodes IDs in paths', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    await createClient({ baseUrl: 'https://x.test', fetch: fetcher }).unassignPerson('u/1', 'w 2');
    expect(fetcher.mock.calls[0]![0]).toBe('https://x.test/api/v1/admin/people/u%2F1/workspaces/w%202');
  });
});
