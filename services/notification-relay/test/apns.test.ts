import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { ApnsRequest } from '@openchat/notification-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearProviderTokenCache, sendToApns } from '../src/apns/client';
import { classifyApnsResponse } from '../src/apns/classify';
import { decideMint, MAX_TOKEN_AGE_MS, MIN_TOKEN_AGE_MS, RENEW_TOKEN_AGE_MS, type StoredToken } from '../src/apns/provider-token';
import { runApnsSelfCheck } from '../src/apns/self-check';
import { MockApnsTransport, WorkersFetchTransport } from '../src/apns/transport';
import type { Env } from '../src/env';
import { createApp } from '../src/index';

const testEnv = env as unknown as Env & { TEST_APNS_PUBLIC_KEY: string };
const self = (exports as unknown as { default: Fetcher }).default;
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const message = { deviceToken: 'abc123', topic: 'com.example.app', headers: { 'apns-push-type': 'alert' }, body: '{}' };

beforeEach(() => clearProviderTokenCache());

describe('classifying APNs answers', () => {
  it.each([
    [200, undefined, 'delivered'],
    [410, 'Unregistered', 'remove_device'],
    [400, 'BadDeviceToken', 'remove_device'],
    [400, 'DeviceTokenNotForTopic', 'remove_device'],
    [403, 'ExpiredProviderToken', 'refresh_token'],
    [403, 'InvalidProviderToken', 'credential_error'],
    [403, 'MissingProviderToken', 'credential_error'],
    [403, 'BadCertificate', 'credential_error'],
    [429, 'TooManyRequests', 'retry'],
    [429, 'TooManyProviderTokenUpdates', 'stop_minting'],
    [500, 'InternalServerError', 'retry'],
    [503, 'ServiceUnavailable', 'retry'],
    [413, 'PayloadTooLarge', 'permanent_failure'],
    [400, 'BadTopic', 'permanent_failure'],
    [400, 'TopicDisallowed', 'permanent_failure'],
    [404, 'BadPath', 'permanent_failure'],
  ] as const)('%i %s is %s', (status, reason, action) => {
    expect(classifyApnsResponse({ status, ...(reason ? { reason } : {}) })).toBe(action);
  });
});

describe('deciding whether to mint', () => {
  const now = 10 * MAX_TOKEN_AGE_MS;
  const aged = (age: number): StoredToken => ({ token: 't', keyId: 'k', mintedAt: now - age });
  const decide = (current: StoredToken | undefined, more: { noMintUntil?: number; staleToken?: string; keyId?: string } = {}) => decideMint({ current, keyId: more.keyId ?? 'k', now, noMintUntil: more.noMintUntil ?? 0, staleToken: more.staleToken });

  it('mints when it has nothing, and reuses a young token', () => {
    expect(decide(undefined)).toBe('mint');
    expect(decide(aged(RENEW_TOKEN_AGE_MS - 1))).toBe('reuse');
  });
  it('renews at 40 minutes', () => expect(decide(aged(RENEW_TOKEN_AGE_MS))).toBe('mint'));
  it('mints when the key changed', () => expect(decide(aged(1), { keyId: 'other' })).toBe('mint'));
  it('does not replace a token under 20 minutes old, even if APNs called it expired', () => {
    expect(decide(aged(MIN_TOKEN_AGE_MS - 1), { staleToken: 't' })).toBe('reuse');
    expect(decide(aged(MIN_TOKEN_AGE_MS), { staleToken: 't' })).toBe('mint');
  });
  it('keeps a token someone else already replaced', () => expect(decide(aged(MIN_TOKEN_AGE_MS), { staleToken: 'older' })).toBe('reuse'));
  it('uses a usable token while paused, and is unavailable without one', () => {
    expect(decide(aged(RENEW_TOKEN_AGE_MS), { noMintUntil: now + 1 })).toBe('reuse');
    expect(decide(aged(MAX_TOKEN_AGE_MS), { noMintUntil: now + 1 })).toBe('unavailable');
    expect(decide(undefined, { noMintUntil: now + 1 })).toBe('unavailable');
  });
});

describe('ApnsCredential', () => {
  const stub = (name: string) => testEnv.APNS_CREDENTIAL.getByName(name);

  it('mints a token APNs can verify, with only the expected claims', async () => {
    const result = await stub('claims').getToken();
    if (!result.ok) throw new Error(result.reason);
    const [head, claims, signature] = result.token.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(head)))).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(claims))) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['iat', 'iss']);
    expect(parsed.iss).toBe('TEAM123456');
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(testEnv.TEST_APNS_PUBLIC_KEY), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  });

  it('gives concurrent callers one token', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => stub('concurrent').getToken()));
    expect(new Set(results.map((r) => (r.ok ? r.token : r.reason))).size).toBe(1);
  });

  it('keeps its token after eviction', async () => {
    const first = await stub('evicted').getToken();
    const stored = await runInDurableObject(stub('evicted'), (_instance, state) => state.storage.get<{ current: { token: string } }>('state'));
    expect(first.ok && stored?.current.token === first.token).toBe(true);
  });

  it('stops minting when told to', async () => {
    await stub('paused').pauseMinting();
    expect(await stub('paused').getToken()).toEqual({ ok: false, reason: 'minting_paused' });
  });
});

describe('sending', () => {
  const unconfigured: Env = { ...testEnv };
  delete unconfigured.APNS_PRIVATE_KEY;

  it('sends the token to the device path with the topic and the provider token', async () => {
    const transport = new MockApnsTransport([{ status: 200, apnsId: 'id' }]);
    const outcome = await sendToApns(testEnv, transport, message);
    expect(outcome.action).toBe('delivered');
    const request = transport.requests[0] as ApnsRequest;
    expect(request).toMatchObject({ host: 'api.push.apple.com', token: 'abc123', body: '{}' });
    expect(request.headers).toMatchObject({ 'apns-topic': 'com.example.app', 'apns-push-type': 'alert' });
    expect(request.headers.authorization).toMatch(/^bearer ey/);
  });

  it('uses the sandbox host when told to', async () => {
    const transport = new MockApnsTransport();
    await sendToApns({ ...testEnv, APNS_ENVIRONMENT: 'sandbox' }, transport, message);
    expect(transport.requests[0]?.host).toBe('api.sandbox.push.apple.com');
  });

  it('retries once on an expired token', async () => {
    const transport = new MockApnsTransport([{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }]);
    expect((await sendToApns(testEnv, transport, message)).action).toBe('delivered');
    expect(transport.requests).toHaveLength(2);
  });

  it('calls it a credential error if a retried token is also refused, and removes no device', async () => {
    const transport = new MockApnsTransport([{ status: 403, reason: 'ExpiredProviderToken' }]);
    expect((await sendToApns(testEnv, transport, message)).action).toBe('credential_error');
    expect(transport.requests).toHaveLength(2);
  });

  it('treats a network failure as retryable, and never exposes the error', async () => {
    const outcome = await sendToApns(testEnv, new MockApnsTransport([new Error('Network connection lost')]), message);
    expect(outcome).toEqual({ action: 'retry', failure: 'network' });
  });

  it('pauses minting on TooManyProviderTokenUpdates', async () => {
    const custom = { ...testEnv, APNS_KEY_ID: 'KEYPAUSED1' };
    expect((await sendToApns(custom, new MockApnsTransport([{ status: 429, reason: 'TooManyProviderTokenUpdates' }]), message)).action).toBe('stop_minting');
    const id = `${custom.APNS_TEAM_ID}:${custom.APNS_KEY_ID}`;
    const state = await runInDurableObject(testEnv.APNS_CREDENTIAL.getByName(id), (_instance, durable) => durable.storage.get<{ noMintUntil: number }>('state'));
    expect(state?.noMintUntil).toBeGreaterThan(Date.now());
  });

  it('sends nothing without a key', async () => {
    const custom = { ...unconfigured, APNS_KEY_ID: 'KEYNONE123' };
    const transport = new MockApnsTransport();
    expect(await sendToApns(custom, transport, message)).toEqual({ action: 'credential_error', failure: 'not_configured' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('WorkersFetchTransport', () => {
  it('posts to the device path and reads the reason', async () => {
    const calls: [string, RequestInit][] = [];
    const transport = new WorkersFetchTransport(async (input, init) => {
      calls.push([String(input), init as RequestInit]);
      return new Response(JSON.stringify({ reason: 'Unregistered', timestamp: 5 }), { status: 410, headers: { 'apns-id': 'the-id' } });
    });
    expect(await transport.send({ host: 'api.push.apple.com', token: 'abc', headers: { a: 'b' }, body: '{}' })).toEqual({ status: 410, apnsId: 'the-id', reason: 'Unregistered', timestamp: 5 });
    expect(calls[0]?.[0]).toBe('https://api.push.apple.com/3/device/abc');
    expect(calls[0]?.[1]).toMatchObject({ method: 'POST', headers: { a: 'b' }, body: '{}' });
  });

  it('survives an empty or unreadable body', async () => {
    const answer = (body: string | null) => new WorkersFetchTransport(async () => new Response(body, { status: 200 })).send({ host: 'api.push.apple.com', token: 'a', headers: {}, body: '' });
    expect(await answer(null)).toEqual({ status: 200 });
    expect(await answer('not json')).toEqual({ status: 200 });
  });
});

describe('self-check', () => {
  it('is healthy only on BadDeviceToken, and targets no real device', async () => {
    const transport = new MockApnsTransport([{ status: 400, reason: 'BadDeviceToken' }]);
    expect(await runApnsSelfCheck(testEnv, transport)).toMatchObject({ outcome: 'ok', status: 400, reason: 'BadDeviceToken' });
    expect(transport.requests[0]?.token).toBe('0'.repeat(64));
    expect(transport.requests[0]?.headers).toMatchObject({ 'apns-topic': 'com.example.app', 'apns-expiration': '0' });
  });

  it.each([
    [{ status: 403, reason: 'InvalidProviderToken' }, 'credential_error'],
    [{ status: 400, reason: 'TopicDisallowed' }, 'unexpected'],
    [{ status: 200 }, 'unexpected'],
    [new Error('Network connection lost'), 'unreachable'],
  ] as const)('reports %o as %s', async (answer, outcome) => {
    expect((await runApnsSelfCheck(testEnv, new MockApnsTransport([answer]))).outcome).toBe(outcome);
  });

  it('does nothing when not configured', async () => {
    const withoutTopic: Env = { ...testEnv };
    delete withoutTopic.APNS_SELF_CHECK_TOPIC;
    const transport = new MockApnsTransport();
    expect(await runApnsSelfCheck(withoutTopic, transport)).toEqual({ outcome: 'not_configured' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('the operator route', () => {
  const path = 'https://relay.example/v1/operator/apns-check';
  const app = createApp(() => new MockApnsTransport([{ status: 400, reason: 'BadDeviceToken' }]));
  const post = (authorization?: string, environment: Env = testEnv) => app.request(path, { method: 'POST', headers: authorization ? { authorization } : {} }, environment);

  it('answers the operator', async () => {
    const response = await post('Bearer test-operator-token');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'ok' });
  });

  it.each([[undefined], ['Bearer wrong'], ['test-operator-token']])('is 404 for %s', async (authorization) => {
    expect((await post(authorization)).status).toBe(404);
  });

  it('is 404 for everyone when no operator token is set', async () => {
    const withoutToken: Env = { ...testEnv };
    delete withoutToken.RELAY_OPERATOR_TOKEN;
    expect((await post('Bearer undefined', withoutToken)).status).toBe(404);
  });

  it('never reveals the key or the provider token', async () => {
    const text = await (await post('Bearer test-operator-token')).text();
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toMatch(/ey[A-Za-z0-9_-]{10,}/);
  });

  it('is deployed behind the same check', async () => {
    expect((await self.fetch(path, { method: 'POST' })).status).toBe(404);
  });
});
