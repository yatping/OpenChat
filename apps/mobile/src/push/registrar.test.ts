import type { ApiClient } from '@openchat/api-client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { parseDestination, setConversationOnScreen, shouldShowInForeground } from './destination';
import { allowedRelay, createPushRegistrar, type PushConfig } from './registrar';

const RELAY = 'https://relay.example.org';
const relay = { id: 'managed', url: RELAY, bundleIds: ['org.example.app'], publicKeys: [{ id: 'k', alg: 'Ed25519' as const, key: 'x' }] };
const config: PushConfig = { enabled: true, environment: 'production', bundleId: 'org.example.app', allowedRelays: [{ id: 'managed', url: RELAY }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(options: { granted?: boolean; config?: PushConfig; relayDown?: boolean } = {}) {
  const values = new Map<string, string>();
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const state = { relayDown: options.relayDown ?? false, token: 'aa'.repeat(32), deviceUnknown: false, serverRows: new Set<string>() };
  let n = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.relayDown) throw new TypeError('Network request failed');
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/v1/devices/register')) {
      const body = calls.at(-1)!.body;
      if (body.device && state.deviceUnknown) return json({ code: 'invalid_device' }, 401);
      return json({ deviceId: 'dev_1', subscriptionId: `sub_${++n}`, ...(body.device ? {} : { deviceSecret: 'secret' }) }, 201);
    }
    if (url.endsWith('/v1/devices/token') && state.deviceUnknown) return json({ code: 'invalid_device' }, 401);
    return new Response(null, { status: 204 });
  });
  const api = {
    createPushGrant: vi.fn(async (workspaceId: string) => ({ grant: `grant-${workspaceId}`, relayUrl: RELAY, expiresAt: '' })),
    recordPushSubscription: vi.fn(async (_w: string, input: { relaySubscriptionId: string }) => {
      const id = `psub_${input.relaySubscriptionId}`;
      state.serverRows.add(id);
      return { id };
    }),
    listPushSubscriptions: vi.fn(async () => ({ data: [...state.serverRows].map((id) => ({ id })) })),
    removePushSubscription: vi.fn(async () => undefined),
  } as unknown as ApiClient;
  const registrar = createPushRegistrar({
    config: options.config ?? config,
    native: { requestPermission: async () => options.granted ?? true, deviceToken: async () => state.token, locale: () => 'en-GB' },
    secure: { get: async (k) => values.get(k) ?? null, set: async (k, v) => void values.set(k, v), remove: async (k) => void values.delete(k) },
    fetch: fetcher as unknown as typeof fetch,
  });
  const sync = (workspaceIds = ['work_a'], discovered: typeof relay | null = relay) => registrar.sync({ connectionId: 'c1', api, relay: discovered, workspaceIds });
  return { registrar, api, calls, values, state, fetcher, sync, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

describe('which relay the app will talk to', () => {
  it('accepts only one fixed at build time, for this app', () => {
    expect(allowedRelay(config, relay)).toEqual({ id: 'managed', url: RELAY });
    expect(allowedRelay(config, { ...relay, url: 'https://evil.example' })).toBeNull();
    expect(allowedRelay(config, { ...relay, id: 'other' })).toBeNull();
    expect(allowedRelay(config, { ...relay, bundleIds: ['org.other.app'] })).toBeNull();
    expect(allowedRelay(config, null)).toBeNull();
  });

  it('sends the token nowhere when the installation names another relay', async () => {
    const { sync, fetcher, registrar, api } = setup();
    await sync(['work_a'], { ...relay, url: 'https://evil.example' });
    expect(registrar.getStatus()).toBe('not_allowed');
    expect(fetcher).not.toHaveBeenCalled();
    expect(api.createPushGrant).not.toHaveBeenCalled();
  });

  it('refuses a grant that names another relay, with discovery looking fine', async () => {
    const { sync, fetcher, registrar, api } = setup();
    vi.mocked(api.createPushGrant).mockResolvedValue({ grant: 'g', relayUrl: 'https://evil.example', expiresAt: '' });
    await sync();
    expect(registrar.getStatus()).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does nothing in a build without push', async () => {
    const { sync, api, registrar } = setup({ config: { ...config, enabled: false } });
    await sync();
    expect(registrar.getStatus()).toBe('off');
    expect(api.createPushGrant).not.toHaveBeenCalled();
  });
});

describe('registering', () => {
  it('goes grant, relay, installation, and gives the installation only the handle', async () => {
    const { sync, calls, api, registrar } = setup();
    await sync();
    expect(registrar.getStatus()).toBe('on');
    expect(calls[0]!.body).toMatchObject({ grant: 'grant-work_a', platform: 'ios', apnsToken: 'aa'.repeat(32), bundleId: 'org.example.app', environment: 'production', locale: 'en-GB' });
    expect(JSON.stringify(vi.mocked(api.recordPushSubscription).mock.calls)).not.toContain('aa'.repeat(32));
    expect(vi.mocked(api.recordPushSubscription).mock.calls[0]![1]).toEqual({ relaySubscriptionId: 'sub_1', deviceLabel: 'iOS app' });
  });

  it('asks nothing of the network without permission', async () => {
    const { sync, fetcher, registrar, api } = setup({ granted: false });
    await sync();
    expect(registrar.getStatus()).toBe('denied');
    expect(fetcher).not.toHaveBeenCalled();
    expect(api.createPushGrant).not.toHaveBeenCalled();
  });

  it('covers every workspace with one device, and proves itself after the first', async () => {
    const { sync, calls } = setup();
    await sync(['work_a', 'work_b']);
    expect(calls[0]!.body.device).toBeUndefined();
    expect(calls[1]!.body.device).toEqual({ id: 'dev_1', secret: 'secret' });
  });

  it('does not register again while the installation still has the row', async () => {
    const { sync, api } = setup();
    await sync();
    await sync();
    expect(api.createPushGrant).toHaveBeenCalledTimes(1);
  });

  it('registers again after the installation removed it, as when sessions were revoked', async () => {
    const { sync, api, state } = setup();
    await sync();
    state.serverRows.clear();
    await sync();
    expect(api.createPushGrant).toHaveBeenCalledTimes(2);
  });

  it('reports failure and does not throw while the relay is down', async () => {
    const { sync, registrar } = setup({ relayDown: true });
    await expect(sync()).resolves.toBeUndefined();
    expect(registrar.getStatus()).toBe('failed');
  });
});

describe('a new token', () => {
  it('goes to the relay with the device secret, and to nobody else', async () => {
    const { sync, registrar, calls, api } = setup();
    await sync();
    calls.length = 0;
    await registrar.tokenChanged('bb'.repeat(32));
    expect(calls).toEqual([{ url: `${RELAY}/v1/devices/token`, body: { deviceId: 'dev_1', apnsToken: 'bb'.repeat(32) }, auth: 'Bearer secret' }]);
    expect(api.createPushGrant).toHaveBeenCalledTimes(1);
  });

  it('is noticed on the next start, if the listener missed it', async () => {
    const { sync, state, paths } = setup();
    await sync();
    state.token = 'cc'.repeat(32);
    await sync();
    expect(paths()).toContain('/v1/devices/token');
  });

  it('starts the device again if the relay has forgotten it', async () => {
    const { sync, state, calls } = setup();
    await sync();
    state.token = 'cc'.repeat(32);
    state.deviceUnknown = true;
    await sync();
    const last = calls.at(-1)!;
    expect(last.url).toBe(`${RELAY}/v1/devices/register`);
    expect(last.body.device).toBeUndefined();
  });
});

describe('a device the relay erased', () => {
  it('registers again as new, with the same grant, when an installation left the relay', async () => {
    const { sync, state, calls, api, registrar } = setup();
    await sync(['work_a']);
    state.deviceUnknown = true;
    await sync(['work_a', 'work_b']);
    const registers = calls.filter((c) => c.url.endsWith('/v1/devices/register')).slice(1);
    expect(registers.map((c) => c.body.device)).toEqual([{ id: 'dev_1', secret: 'secret' }, undefined]);
    expect(registers[0]!.body.grant).toBe(registers[1]!.body.grant);
    expect(api.createPushGrant).toHaveBeenCalledTimes(2);
    expect(registrar.getStatus()).toBe('on');
  });
});

describe('signing out', () => {
  it('tells the relay and the installation, and keeps no record of this connection', async () => {
    const { sync, registrar, api, calls, values } = setup();
    await sync();
    calls.length = 0;
    await registrar.forget('c1', api);
    expect(calls).toEqual([{ url: `${RELAY}/v1/devices/unregister`, body: { deviceId: 'dev_1', subscriptionId: 'sub_1' }, auth: 'Bearer secret' }]);
    expect(api.removePushSubscription).toHaveBeenCalledWith('work_a', 'psub_sub_1');
    expect([...values.keys()].filter((k) => k.includes('subscriptions'))).toEqual([]);
  });

  it('still reaches the relay with no session', async () => {
    const { sync, registrar, api, calls } = setup();
    await sync();
    calls.length = 0;
    await registrar.forget('c1', null);
    expect(calls).toHaveLength(1);
    expect(api.removePushSubscription).not.toHaveBeenCalled();
  });

  it('keeps the call for later when offline, and sends it on the next start', async () => {
    const { sync, registrar, api, state, calls, values } = setup();
    await sync();
    state.relayDown = true;
    await registrar.forget('c1', api);
    expect(values.has('push.pending')).toBe(true);
    state.relayDown = false;
    calls.length = 0;
    await sync();
    expect(calls[0]).toMatchObject({ url: `${RELAY}/v1/devices/unregister`, body: { subscriptionId: 'sub_1' } });
    expect(values.has('push.pending')).toBe(false);
  });

  it('does nothing if push was never set up', async () => {
    const { registrar, api, fetcher } = setup();
    await registrar.forget('c1', api);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('a notification', () => {
  const payload = { aps: { alert: {} }, oc: { v: 1, event: 'new_message', installationId: 'inst_a', workspaceId: 'work_a', conversationId: 'conv_a', notificationId: 'ntf_a' } };

  it('leads somewhere only if every part of it looks right', () => {
    expect(parseDestination(payload)).toEqual({ installationId: 'inst_a', workspaceId: 'work_a', conversationId: 'conv_a' });
    expect(parseDestination({})).toBeNull();
    expect(parseDestination(null)).toBeNull();
    expect(parseDestination({ oc: { ...payload.oc, v: 2 } })).toBeNull();
    expect(parseDestination({ oc: { ...payload.oc, conversationId: '../../admin' } })).toBeNull();
    expect(parseDestination({ oc: { ...payload.oc, workspaceId: 7 } })).toBeNull();
  });

  it('is hidden in the foreground only for the conversation on screen', () => {
    expect(shouldShowInForeground(payload)).toBe(true);
    setConversationOnScreen('conv_a');
    expect(shouldShowInForeground(payload)).toBe(false);
    setConversationOnScreen('conv_b');
    expect(shouldShowInForeground(payload)).toBe(true);
    setConversationOnScreen(null);
    expect(shouldShowInForeground(payload)).toBe(true);
  });
});
