import { describe, expect, it, vi } from 'vitest';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { checkCompatibility, fetchDiscovery, normalizeInstallationUrl } from './discovery';
import { createConnectionManager, type ManagerDeps } from './manager';
import { createSession, refreshTokenKey } from './session';

const memorySecure = () => {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
    remove: async (key: string) => void values.delete(key),
  };
};
const memoryRegistry = () => {
  let value: string | null = null;
  return { load: async () => value, save: async (next: string) => void (value = next) };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

const discovery = (name: string, overrides = {}) => ({ installationId: 'inst_same', name, api: { versions: ['v1'], minor: 0 }, realtime: { protocolVersions: [1] }, relay: null, auth: { signup: 'invite_only' as const }, ...overrides });

/** A fake installation. Two of these use identical IDs for everything, which real ones are free to do. */
function installation(name: string) {
  const state = { refreshCount: 0, revoked: false, loggedOut: 0, discovery: discovery(name), meCalls: [] as string[], current: `${name}-refresh-0` };
  const handle = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/.well-known/openchat.json') return json(state.discovery);
    if (path === '/api/v1/auth/login') {
      const body = JSON.parse(String(init?.body)) as { password: string; clientType: string };
      if (body.password !== 'right') return json({ code: 'invalid_credentials', title: 'Wrong' }, 401);
      expect(body.clientType).toBe('mobile');
      return json({ accessToken: `${name}-access`, accessTokenExpiresAt: inAnHour(), refreshToken: state.current });
    }
    if (path === '/api/v1/auth/refresh') {
      if (state.revoked) return json({ code: 'unauthorized', title: 'No' }, 401);
      state.refreshCount++;
      state.current = `${name}-refresh-${state.refreshCount}`;
      return json({ accessToken: `${name}-access-${state.refreshCount}`, accessTokenExpiresAt: inAnHour(), refreshToken: state.current });
    }
    if (path === '/api/v1/auth/logout') {
      state.loggedOut++;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v1/me') {
      const token = new Headers(init?.headers).get('authorization') ?? '';
      state.meCalls.push(token);
      if (state.revoked) return json({ code: 'unauthorized', title: 'No' }, 401);
      return json({ id: 'user_same', email: `${name}@example.com`, name, memberships: [{ workspace: { id: 'work_same', name, slug: name, createdAt: '' }, role: 'owner' }] });
    }
    return json({ code: 'not_found', title: 'No' }, 404);
  };
  return { state, handle };
}

function setup() {
  const a = installation('alpha');
  const b = installation('beta');
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://a.example') return a.handle(url.pathname, init);
    if (url.origin === 'https://b.example') return b.handle(url.pathname, init);
    throw new TypeError('Network request failed');
  });
  const secure = memorySecure();
  const registry = memoryRegistry();
  const wipeFiles = vi.fn(async () => undefined);
  let next = 0;
  const deps: ManagerDeps = { registry, secure, fetch: fetcher as typeof globalThis.fetch, newId: () => `local-${++next}`, clientLabel: 'iPhone', wipeFiles };
  return { a, b, secure, registry, wipeFiles, fetcher, deps, manager: createConnectionManager(deps) };
}

const sign = (manager: ReturnType<typeof setup>['manager'], baseUrl: string, name: string, password = 'right') => manager.signIn(baseUrl, discovery(name), { email: `${name}@example.com`, password });

describe('the address of an installation', () => {
  const normalize = (input: string, allowLocalHttp = false) => normalizeInstallationUrl(input, { allowLocalHttp });

  it.each([
    ['chat.example.com', 'https://chat.example.com'],
    ['  https://Chat.Example.com/  ', 'https://chat.example.com'],
    ['https://x.workers.dev', 'https://x.workers.dev'],
    ['chat.example.com:8443', 'https://chat.example.com:8443'],
  ])('reads %j', (input, baseUrl) => {
    expect(normalize(input)).toEqual({ ok: true, baseUrl });
  });

  it.each(['', 'not a url', 'https://user:pw@example.com', 'https://example.com/path', 'https://example.com?x=1', 'ftp://example.com'])('refuses %j', (input) => {
    expect(normalize(input)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses plain HTTP, except for a development server on this machine', () => {
    expect(normalize('http://chat.example.com')).toEqual({ ok: false, reason: 'insecure' });
    expect(normalize('http://localhost:8787')).toEqual({ ok: false, reason: 'insecure' });
    expect(normalize('http://localhost:8787', true)).toEqual({ ok: true, baseUrl: 'http://localhost:8787' });
    expect(normalize('http://chat.example.com', true)).toEqual({ ok: false, reason: 'insecure' });
  });
});

describe('compatibility', () => {
  it.each([
    [['v1'], 0, 'compatible'],
    [['v1', 'v2'], 9, 'compatible'],
    [['v2'], 0, 'update_app'],
    [['v0'], 0, 'update_installation'],
    [[], 0, 'update_installation'],
  ])('versions %j and minor %i is %s', (versions, minor, expected) => {
    expect(checkCompatibility({ api: { versions, minor } })).toBe(expected);
  });

  it('tells a site that is not OpenChat from one that cannot be reached', async () => {
    const respond = (response: Response) => (async () => response) as typeof globalThis.fetch;
    await expect(fetchDiscovery('https://x', respond(new Response('<html>', { status: 200 })))).resolves.toEqual({ ok: false, reason: 'not_openchat' });
    await expect(fetchDiscovery('https://x', respond(json({ hello: 1 })))).resolves.toEqual({ ok: false, reason: 'not_openchat' });
    await expect(fetchDiscovery('https://x', respond(new Response('', { status: 404 })))).resolves.toEqual({ ok: false, reason: 'not_openchat' });
    await expect(fetchDiscovery('https://x', (async () => { throw new TypeError('offline'); }) as typeof globalThis.fetch)).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('two installations with colliding IDs', () => {
  it('keeps them apart: separate connections, tokens, and requests', async () => {
    const { manager, a, b, secure } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    const second = await sign(manager, 'https://b.example', 'beta');
    if (!first.ok || !second.ok) throw new Error('Could not sign in');
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(manager.getState().connections.map((c) => [c.installationId, c.userId, c.workspaceId])).toEqual([['inst_same', 'user_same', 'work_same'], ['inst_same', 'user_same', 'work_same']]);
    expect(secure.values.get(refreshTokenKey(first.connectionId))).toBe('alpha-refresh-0');
    expect(secure.values.get(refreshTokenKey(second.connectionId))).toBe('beta-refresh-0');

    a.state.meCalls.length = 0;
    b.state.meCalls.length = 0;
    await manager.session(first.connectionId).client.getMe();
    await manager.session(second.connectionId).client.getMe();
    expect(a.state.meCalls).toEqual(['Bearer alpha-access']);
    expect(b.state.meCalls).toEqual(['Bearer beta-access']);
  });

  it('signing out of one wipes it, and leaves the other working', async () => {
    const { manager, a, b, secure, wipeFiles } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    const second = await sign(manager, 'https://b.example', 'beta');
    if (!first.ok || !second.ok) throw new Error('Could not sign in');
    await manager.signOut(first.connectionId);

    expect(a.state.loggedOut).toBe(1);
    expect(b.state.loggedOut).toBe(0);
    expect(secure.values.has(refreshTokenKey(first.connectionId))).toBe(false);
    expect(secure.values.has(refreshTokenKey(second.connectionId))).toBe(true);
    expect(wipeFiles.mock.calls).toEqual([[first.connectionId]]);
    expect(manager.getState().connections.map((c) => c.id)).toEqual([second.connectionId]);
    expect(manager.getState().activeId).toBe(second.connectionId);
    await expect(manager.session(second.connectionId).client.getMe()).resolves.toMatchObject({ email: 'beta@example.com' });
    expect(() => manager.session(first.connectionId)).toThrow('Unknown connection');
    expect(a.state.discovery.name).toBe('alpha');
  });

  it('wipes this device even when the installation cannot be reached', async () => {
    const { manager, secure, fetcher } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    if (!first.ok) throw new Error('Could not sign in');
    fetcher.mockImplementation(async () => { throw new TypeError('offline'); });
    await manager.signOut(first.connectionId);
    expect(secure.values.size).toBe(0);
    expect(manager.getState()).toMatchObject({ connections: [], activeId: null });
  });

  it('gives the same user on the same installation one connection, not two', async () => {
    const { manager } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    const again = await sign(manager, 'https://a.example', 'alpha');
    expect(again).toEqual(first);
    expect(manager.getState().connections).toHaveLength(1);
  });

  it('remembers connections across a restart, and never stores a token outside the keychain', async () => {
    const { manager, deps, registry } = setup();
    await manager.start();
    await sign(manager, 'https://a.example', 'alpha');
    await sign(manager, 'https://b.example', 'beta');
    const saved = (await registry.load())!;
    expect(saved).not.toMatch(/access|refresh/);
    const restarted = createConnectionManager(deps);
    await restarted.start();
    expect(restarted.getState().connections.map((c) => c.installationName)).toEqual(['alpha', 'beta']);
    expect(restarted.getState().activeId).toBe(manager.getState().activeId);
  });
});

describe('signing in', () => {
  it('reports a wrong password, leaves nothing behind, and does not try to refresh', async () => {
    const { manager, secure, a } = setup();
    await manager.start();
    await expect(sign(manager, 'https://a.example', 'alpha', 'wrong')).resolves.toEqual({ ok: false, reason: 'wrong_credentials' });
    expect(secure.values.size).toBe(0);
    expect(manager.getState().connections).toEqual([]);
    expect(a.state.refreshCount).toBe(0);
  });

  it('leaves nothing behind when the keychain refuses the token', async () => {
    const { manager, deps, secure } = setup();
    await manager.start();
    secure.set = async () => { throw new Error('keychain'); };
    deps.secure = secure;
    const failing = createConnectionManager(deps);
    await failing.start();
    await expect(sign(failing, 'https://a.example', 'alpha')).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(failing.getState().connections).toEqual([]);
    expect(() => failing.session('local-1')).toThrow('Unknown connection');
  });

  it('reports a network failure as that', async () => {
    const { manager } = setup();
    await manager.start();
    await expect(sign(manager, 'https://down.example', 'x')).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('when a session ends mid-use', () => {
  it('marks only that connection expired, removes its token, and signing in again restores it', async () => {
    const { manager, a, secure } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    const second = await sign(manager, 'https://b.example', 'beta');
    if (!first.ok || !second.ok) throw new Error('Could not sign in');

    a.state.revoked = true;
    await expect(manager.session(first.connectionId).client.getMe()).rejects.toMatchObject({ status: 401 });
    expect(manager.getState().connections.map((c) => c.expired)).toEqual([true, false]);
    expect(secure.values.has(refreshTokenKey(first.connectionId))).toBe(false);

    a.state.revoked = false;
    const again = await sign(manager, 'https://a.example', 'alpha');
    expect(again).toEqual(first);
    expect(manager.getState().connections.map((c) => c.expired)).toEqual([false, false]);
    await expect(manager.session(first.connectionId).client.getMe()).resolves.toMatchObject({ email: 'alpha@example.com' });
  });

  it('notices at start that a connection has no credential', async () => {
    const { manager, deps, secure } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    if (!first.ok) throw new Error('Could not sign in');
    secure.values.clear();
    const restarted = createConnectionManager(deps);
    await restarted.start();
    expect(restarted.getState().connections[0]?.expired).toBe(true);
  });

  it('shows an upgrade message when an installation moves on, and keeps the last answer when offline', async () => {
    const { manager, a, fetcher } = setup();
    await manager.start();
    const first = await sign(manager, 'https://a.example', 'alpha');
    if (!first.ok) throw new Error('Could not sign in');
    a.state.discovery = discovery('alpha', { api: { versions: ['v2'], minor: 0 } });
    await manager.recheck(first.connectionId);
    expect(manager.getState().connections[0]?.compatibility).toBe('update_app');
    fetcher.mockImplementation(async () => { throw new TypeError('offline'); });
    await manager.recheck(first.connectionId);
    expect(manager.getState().connections[0]?.compatibility).toBe('update_app');
  });
});

describe('refreshing', () => {
  const start = () => {
    const secure = memorySecure();
    secure.values.set(refreshTokenKey('c1'), 'token-0');
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((JSON.parse(String(init?.body)) as { refreshToken: string }).refreshToken);
      await gate;
      return json({ accessToken: 'new', accessTokenExpiresAt: inAnHour(), refreshToken: `token-${seen.length}` });
    }) as typeof globalThis.fetch;
    const onExpired = vi.fn();
    return { secure, seen, release, onExpired, session: createSession({ connectionId: 'c1', baseUrl: 'https://x', secure, fetch: fetcher, onExpired }) };
  };

  it('never overlaps, because presenting a refresh token twice revokes the session', async () => {
    const { session, seen, release, secure } = start();
    const all = Promise.all([session.getAccessToken(), session.getAccessToken(), session.refresh()]);
    release();
    await expect(all).resolves.toEqual(['new', 'new', true]);
    expect(seen).toEqual(['token-0']);
    expect(secure.values.get(refreshTokenKey('c1'))).toBe('token-1');
  });

  it('treats being offline as offline, not as signed out', async () => {
    const secure = memorySecure();
    secure.values.set(refreshTokenKey('c1'), 'token-0');
    const onExpired = vi.fn();
    const session = createSession({ connectionId: 'c1', baseUrl: 'https://x', secure, fetch: (async () => { throw new TypeError('offline'); }) as typeof globalThis.fetch, onExpired });
    await expect(session.refresh()).resolves.toBe(false);
    expect(onExpired).not.toHaveBeenCalled();
    expect(secure.values.get(refreshTokenKey('c1'))).toBe('token-0');
  });

  it('does not save a token that arrives after a wipe', async () => {
    const { session, release, secure } = start();
    const pending = session.refresh();
    await session.wipe();
    release();
    await expect(pending).resolves.toBe(false);
    expect(secure.values.has(refreshTokenKey('c1'))).toBe(false);
  });
});
