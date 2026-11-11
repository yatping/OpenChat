import { env } from 'cloudflare:workers';
import { importPrivateKey, signGrant, signRequest, toBase64Url } from '@openchat/notification-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, tokenLookup } from '../src/devices/crypto';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { clearKeyCache } from '../src/requests/verify';

const testEnv = env as unknown as Env;
let counter = 0;
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
const app = createApp();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

interface Installation { id: string; privateKey: CryptoKey; workspaceId: string }

async function newInstallation(): Promise<Installation> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer));
  const pkcs8 = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer));
  const id = unique('inst');
  const workspaceId = unique('work');
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO installations (id, base_url, created_at) VALUES (?, ?, 0)').bind(id, `https://${id}.example.org`),
    testEnv.DB.prepare('INSERT INTO installation_keys (installation_id, key_id, public_key, created_at) VALUES (?, ?, ?, 0)').bind(id, 'k1', raw),
    testEnv.DB.prepare('INSERT INTO workspaces (installation_id, workspace_id, updated_at) VALUES (?, ?, 0)').bind(id, workspaceId),
  ]);
  return { id, privateKey: await importPrivateKey(pkcs8), workspaceId };
}

const grantFor = (i: Installation, overrides: { sub?: string; aud?: string; wid?: string; jti?: string; iat?: number; exp?: number } = {}) => {
  const iat = overrides.iat ?? nowSeconds();
  return signGrant(i.privateKey, 'k1', { iss: i.id, aud: overrides.aud ?? 'relay-test', wid: overrides.wid ?? i.workspaceId, sub: overrides.sub ?? 'mem_a', jti: overrides.jti ?? crypto.randomUUID(), iat, exp: overrides.exp ?? iat + 300 });
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}, environment: Env = testEnv) => app.request(path, { method: 'POST', headers: { 'cf-connecting-ip': unique('ip'), ...headers }, body: JSON.stringify(body) }, environment);

const registerBody = (grant: string, more: object = {}) => ({ grant, platform: 'ios', apnsToken: randomToken(), bundleId: 'com.example.app', environment: 'production', ...more });

interface Registered { deviceId: string; deviceSecret?: string; subscriptionId: string }
async function register(grant: string, more: object = {}): Promise<Registered> {
  const response = await post('/v1/devices/register', registerBody(grant, more));
  expect(response.status).toBe(201);
  return response.json();
}

const subscriptionsOf = async (deviceId: string) => (await testEnv.DB.prepare('SELECT id, workspace_id AS workspaceId, recipient_id AS recipientId FROM subscriptions WHERE device_id = ?').bind(deviceId).all<{ id: string; workspaceId: string; recipientId: string }>()).results;

async function signedPost(i: Installation, path: string, body: unknown, workspaceId?: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const requestId = crypto.randomUUID();
  const timestamp = String(nowSeconds());
  const signature = await signRequest(i.privateKey, { method: 'POST', path, installationId: i.id, ...(workspaceId ? { workspaceId } : {}), keyId: 'k1', requestId, timestamp, body: bytes });
  return app.request(path, { method: 'POST', headers: { 'x-installation-id': i.id, 'x-key-id': 'k1', 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-signature': signature, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }, body: bytes }, testEnv);
}

beforeEach(() => clearKeyCache());

describe('registering a device', () => {
  it('returns a device, a secret once, and a subscription', async () => {
    const i = await newInstallation();
    const registered = await register(await grantFor(i));
    expect(registered.deviceId).toMatch(/^dev_/);
    expect(registered.deviceSecret).toBeTruthy();
    expect(registered.subscriptionId).toMatch(/^sub_/);
    expect(await subscriptionsOf(registered.deviceId)).toEqual([{ id: registered.subscriptionId, workspaceId: i.workspaceId, recipientId: 'mem_a' }]);
  });

  it('stores the token encrypted, and the secret hashed', async () => {
    const i = await newInstallation();
    const token = randomToken();
    const { deviceId, deviceSecret } = await register(await grantFor(i), { apnsToken: token.toUpperCase() });
    const row = await testEnv.DB.prepare('SELECT apns_token AS stored, secret_hash AS hash, token_lookup AS lookup FROM devices WHERE id = ?').bind(deviceId).first<{ stored: string; hash: string; lookup: string }>();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(deviceSecret);
    expect(await decryptToken(testEnv.RELAY_TOKEN_KEY!, 'com.example.app', row!.stored)).toBe(token);
  });

  it('never returns the token', async () => {
    const i = await newInstallation();
    const token = randomToken();
    const response = await post('/v1/devices/register', registerBody(await grantFor(i), { apnsToken: token }));
    expect(await response.text()).not.toContain(token);
  });

  it('gives several devices to one member', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i));
    const b = await register(await grantFor(i));
    expect(a.deviceId).not.toBe(b.deviceId);
    const rows = await testEnv.DB.prepare('SELECT count(*) AS n FROM subscriptions WHERE installation_id = ? AND recipient_id = ?').bind(i.id, 'mem_a').first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('keeps one device on two installations with the same workspace ID', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    await testEnv.DB.prepare('INSERT INTO workspaces (installation_id, workspace_id, updated_at) VALUES (?, ?, 0)').bind(b.id, a.workspaceId).run();
    const first = await register(await grantFor(a));
    const second = await register(await grantFor(b, { wid: a.workspaceId }), { device: { id: first.deviceId, secret: first.deviceSecret } });
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect(await subscriptionsOf(first.deviceId)).toHaveLength(2);
  });
});

describe('the device limit', () => {
  const limited: Env = { ...testEnv, RELAY_DEVICES_PER_INSTALLATION: '2' };
  const registerUnder = async (environment: Env, i: Installation, more: object = {}) => post('/v1/devices/register', registerBody(await grantFor(i), more), {}, environment);

  it('refuses a device past the limit, and still lets a device it has come back', async () => {
    const i = await newInstallation();
    const first = (await (await registerUnder(limited, i)).json()) as Registered;
    expect((await registerUnder(limited, i, { apnsToken: randomToken() })).status).toBe(201);
    const refused = await registerUnder(limited, i);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'device_limit_reached' });
    const again = await registerUnder(limited, i, { device: { id: first.deviceId, secret: first.deviceSecret } });
    expect(again.status).toBe(201);
  });

  it('counts each installation separately, and can be raised for one', async () => {
    const full = await newInstallation();
    const other = await newInstallation();
    const raised: Env = { ...limited, RELAY_LIMIT_OVERRIDES: { [full.id]: { devicesPerInstallation: 3 } } };
    for (let n = 0; n < 2; n++) expect((await registerUnder(limited, full)).status).toBe(201);
    expect((await registerUnder(limited, other)).status).toBe(201);
    expect((await registerUnder(raised, full)).status).toBe(201);
    expect((await registerUnder(raised, full)).status).toBe(403);
  });

  it('still says when the workspace is the reason', async () => {
    const i = await newInstallation();
    const response = await registerUnder(limited, i, {});
    expect(response.status).toBe(201);
    const gone = await post('/v1/devices/register', registerBody(await grantFor(i, { wid: 'work_gone' })), {}, limited);
    expect(await gone.json()).toMatchObject({ code: 'workspace_not_registered' });
  });
});

describe('grants at the relay', () => {
  it('refuses a reused grant', async () => {
    const i = await newInstallation();
    const grant = await grantFor(i);
    await register(grant);
    const again = await post('/v1/devices/register', registerBody(grant));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: 'invalid_grant' });
  });

  it('allows the same grant ID on another installation', async () => {
    const jti = crypto.randomUUID();
    await register(await grantFor(await newInstallation(), { jti }));
    await register(await grantFor(await newInstallation(), { jti }));
  });

  it('does not spend a grant on a request refused for another reason', async () => {
    const i = await newInstallation();
    const grant = await grantFor(i);
    expect((await post('/v1/devices/register', registerBody(grant, { bundleId: 'com.other.app' }))).status).toBe(422);
    await register(grant);
  });

  it.each([
    ['the wrong audience', { aud: 'another-relay' }],
    ['an expired grant', { iat: nowSeconds() - 400, exp: nowSeconds() - 100 }],
    ['a lifetime over 5 minutes', { iat: nowSeconds(), exp: nowSeconds() + 301 }],
  ])('refuses %s', async (_name, overrides) => {
    const response = await post('/v1/devices/register', registerBody(await grantFor(await newInstallation(), overrides)));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses a grant signed by another key, and an unknown installation, alike', async () => {
    const i = await newInstallation();
    const stranger = await newInstallation();
    const forged = await post('/v1/devices/register', registerBody(await signGrant(stranger.privateKey, 'k1', { iss: i.id, aud: 'relay-test', wid: i.workspaceId, sub: 'mem_a', jti: 'x', iat: nowSeconds(), exp: nowSeconds() + 300 })));
    const unknown = await post('/v1/devices/register', registerBody(await signGrant(i.privateKey, 'k1', { iss: 'inst_none', aud: 'relay-test', wid: i.workspaceId, sub: 'mem_a', jti: 'x', iat: nowSeconds(), exp: nowSeconds() + 300 })));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual(await unknown.json());
  });

  it('refuses a grant for a workspace of another installation', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    const response = await post('/v1/devices/register', registerBody(await grantFor(a, { wid: b.workspaceId })));
    expect(response.status).toBe(403);
    expect(await testEnv.DB.prepare('SELECT 1 FROM subscriptions WHERE workspace_id = ?').bind(b.workspaceId).first()).toBeNull();
  });

  it('refuses a revoked workspace, in SQL', async () => {
    const i = await newInstallation();
    await testEnv.DB.prepare(`UPDATE workspaces SET status = 'revoked' WHERE installation_id = ?`).bind(i.id).run();
    expect((await post('/v1/devices/register', registerBody(await grantFor(i)))).status).toBe(403);
  });

  it('refuses a revoked installation key', async () => {
    const i = await newInstallation();
    await testEnv.DB.prepare(`UPDATE installation_keys SET status = 'revoked' WHERE installation_id = ?`).bind(i.id).run();
    expect((await post('/v1/devices/register', registerBody(await grantFor(i)))).status).toBe(401);
  });
});

describe('what a device may submit', () => {
  it.each([
    ['a bundle this relay has no key for', { bundleId: 'com.other.app' }, 422],
    ['the other environment', { environment: 'sandbox' }, 422],
    ['an unknown field', { message: 'hello' }, 400],
    ['a language, which the relay no longer keeps', { locale: 'en-GB' }, 400],
    ['a short token', { apnsToken: 'abcd' }, 400],
    ['a token that is not hex', { apnsToken: 'z'.repeat(64) }, 400],
    ['another platform', { platform: 'android' }, 400],
  ])('refuses %s', async (_name, more, status) => {
    expect((await post('/v1/devices/register', registerBody(await grantFor(await newInstallation()), more))).status).toBe(status);
  });

  it('accepts a second configured bundle', async () => {
    await register(await grantFor(await newInstallation()), { bundleId: 'com.example.other' });
  });

  it('answers 503 and stores nothing without a token key', async () => {
    const noKey: Env = { ...testEnv };
    delete noKey.RELAY_TOKEN_KEY;
    expect((await post('/v1/devices/register', registerBody('x'), {}, noKey)).status).toBe(503);
  });

  it('limits registration per IP', async () => {
    const i = await newInstallation();
    const answers: number[] = [];
    for (let n = 0; n < 70; n++) answers.push((await post('/v1/devices/register', registerBody('not-a-grant'), { 'cf-connecting-ip': `one-address-${i.id}` })).status);
    expect(answers).toContain(429);
  });
});

describe('a device that returns', () => {
  it('keeps its ID with its secret, and adds no secret to the answer', async () => {
    const i = await newInstallation();
    const first = await register(await grantFor(i));
    const second = await register(await grantFor(i), { device: { id: first.deviceId, secret: first.deviceSecret } });
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.deviceSecret).toBeUndefined();
    expect(second.subscriptionId).toBe(first.subscriptionId);
  });

  it('refuses a wrong secret, and an unknown device, alike', async () => {
    const i = await newInstallation();
    const first = await register(await grantFor(i));
    const wrong = await post('/v1/devices/register', registerBody(await grantFor(i), { device: { id: first.deviceId, secret: 'wrong' } }));
    const unknown = await post('/v1/devices/register', registerBody(await grantFor(i), { device: { id: 'dev_none', secret: 'wrong' } }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('gives a new member a new subscription ID, and stops pushing to the old one', async () => {
    const i = await newInstallation();
    const first = await register(await grantFor(i, { sub: 'mem_old' }));
    const second = await register(await grantFor(i, { sub: 'mem_new' }), { device: { id: first.deviceId, secret: first.deviceSecret } });
    expect(second.subscriptionId).not.toBe(first.subscriptionId);
    expect(await subscriptionsOf(first.deviceId)).toEqual([{ id: second.subscriptionId, workspaceId: i.workspaceId, recipientId: 'mem_new' }]);
  });

  it('after a reinstall with no secret, gets a new secret and loses the earlier user\'s subscriptions', async () => {
    const i = await newInstallation();
    const token = randomToken();
    const first = await register(await grantFor(i, { sub: 'mem_old' }), { apnsToken: token });
    const other = await newInstallation();
    await register(await grantFor(other, { sub: 'mem_other' }), { apnsToken: token });
    const after = await subscriptionsOf(first.deviceId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ recipientId: 'mem_other', workspaceId: other.workspaceId });
    const old = await post('/v1/devices/token', { deviceId: first.deviceId, apnsToken: randomToken() }, { authorization: `Bearer ${first.deviceSecret}` });
    expect(old.status).toBe(401);
  });

  it('keeps the same token on two apps apart', async () => {
    const i = await newInstallation();
    const token = randomToken();
    const a = await register(await grantFor(i), { apnsToken: token });
    const b = await register(await grantFor(i), { apnsToken: token, bundleId: 'com.example.other' });
    expect(a.deviceId).not.toBe(b.deviceId);
    expect(await subscriptionsOf(a.deviceId)).toHaveLength(1);
  });
});

describe('token rotation', () => {
  it('updates the token for every subscription at once', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    const first = await register(await grantFor(a));
    await register(await grantFor(b), { device: { id: first.deviceId, secret: first.deviceSecret } });
    const token = randomToken();
    expect((await post('/v1/devices/token', { deviceId: first.deviceId, apnsToken: token }, { authorization: `Bearer ${first.deviceSecret}` })).status).toBe(204);
    const row = await testEnv.DB.prepare('SELECT apns_token AS stored FROM devices WHERE id = ?').bind(first.deviceId).first<{ stored: string }>();
    expect(await decryptToken(testEnv.RELAY_TOKEN_KEY!, 'com.example.app', row!.stored)).toBe(token);
    expect(await subscriptionsOf(first.deviceId)).toHaveLength(2);
  });

  it('removes another device row holding that token', async () => {
    const i = await newInstallation();
    const token = randomToken();
    const stale = await register(await grantFor(i, { sub: 'mem_stale' }), { apnsToken: token });
    const current = await register(await grantFor(i, { sub: 'mem_current' }));
    expect((await post('/v1/devices/token', { deviceId: current.deviceId, apnsToken: token }, { authorization: `Bearer ${current.deviceSecret}` })).status).toBe(204);
    expect(await subscriptionsOf(stale.deviceId)).toEqual([]);
    expect(await testEnv.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind(stale.deviceId).first()).toBeNull();
  });

  it.each([[undefined], ['Bearer wrong']])('refuses authorization %s', async (authorization) => {
    const first = await register(await grantFor(await newInstallation()));
    expect((await post('/v1/devices/token', { deviceId: first.deviceId, apnsToken: randomToken() }, authorization ? { authorization } : {})).status).toBe(401);
  });

  it('cannot change another device with its own secret', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i));
    const b = await register(await grantFor(i));
    expect((await post('/v1/devices/token', { deviceId: b.deviceId, apnsToken: randomToken() }, { authorization: `Bearer ${a.deviceSecret}` })).status).toBe(401);
  });
});

describe('unregistering', () => {
  it('lets a device remove its own subscription, repeatably', async () => {
    const first = await register(await grantFor(await newInstallation()));
    const send = () => post('/v1/devices/unregister', { deviceId: first.deviceId, subscriptionId: first.subscriptionId }, { authorization: `Bearer ${first.deviceSecret}` });
    expect((await send()).status).toBe(204);
    expect(await subscriptionsOf(first.deviceId)).toEqual([]);
    expect((await send()).status).toBe(204);
  });

  it('does not let a device remove another device\'s subscription', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i));
    const b = await register(await grantFor(i));
    expect((await post('/v1/devices/unregister', { deviceId: a.deviceId, subscriptionId: b.subscriptionId }, { authorization: `Bearer ${a.deviceSecret}` })).status).toBe(204);
    expect(await subscriptionsOf(b.deviceId)).toHaveLength(1);
  });

  it('lets an installation remove a member from every device', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i, { sub: 'mem_gone' }));
    const b = await register(await grantFor(i, { sub: 'mem_gone' }));
    const kept = await register(await grantFor(i, { sub: 'mem_kept' }));
    expect((await signedPost(i, '/v1/devices/unregister', { workspaceId: i.workspaceId, recipientId: 'mem_gone' })).status).toBe(204);
    expect(await subscriptionsOf(a.deviceId)).toEqual([]);
    expect(await subscriptionsOf(b.deviceId)).toEqual([]);
    expect(await subscriptionsOf(kept.deviceId)).toHaveLength(1);
  });

  it('lets an installation remove one subscription', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i));
    expect((await signedPost(i, '/v1/devices/unregister', { subscriptionId: a.subscriptionId })).status).toBe(204);
    expect(await subscriptionsOf(a.deviceId)).toEqual([]);
  });

  it('does not let an installation remove another\'s, even with the same IDs', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    await testEnv.DB.prepare('INSERT INTO workspaces (installation_id, workspace_id, updated_at) VALUES (?, ?, 0)').bind(b.id, a.workspaceId).run();
    const victim = await register(await grantFor(a, { sub: 'mem_same' }));
    expect((await signedPost(b, '/v1/devices/unregister', { subscriptionId: victim.subscriptionId })).status).toBe(204);
    expect((await signedPost(b, '/v1/devices/unregister', { workspaceId: a.workspaceId, recipientId: 'mem_same' })).status).toBe(204);
    expect(await subscriptionsOf(victim.deviceId)).toHaveLength(1);
  });

  it('refuses a bad signature, an unsigned request, and a wrong secret', async () => {
    const first = await register(await grantFor(await newInstallation()));
    expect((await post('/v1/devices/unregister', { subscriptionId: first.subscriptionId })).status).toBe(400);
    expect((await post('/v1/devices/unregister', { deviceId: first.deviceId, subscriptionId: first.subscriptionId }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect(await subscriptionsOf(first.deviceId)).toHaveLength(1);
  });

  it('removes subscriptions when a workspace is revoked', async () => {
    const i = await newInstallation();
    const a = await register(await grantFor(i));
    expect((await signedPost(i, '/v1/workspaces/revoke', { workspaceId: i.workspaceId }, i.workspaceId)).status).toBe(204);
    expect(await subscriptionsOf(a.deviceId)).toEqual([]);
  });
});

describe('token encryption', () => {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

  it('round trips, and differs each time', async () => {
    const a = await encryptToken(key, 'app', 'abc');
    expect(a).not.toBe(await encryptToken(key, 'app', 'abc'));
    expect(await decryptToken(key, 'app', a)).toBe('abc');
  });
  it('cannot be read with another key or as another app', async () => {
    const a = await encryptToken(key, 'app', 'abc');
    await expect(decryptToken(key, 'other', a)).rejects.toThrow();
    await expect(decryptToken(toBase64Url(crypto.getRandomValues(new Uint8Array(32))), 'app', a)).rejects.toThrow();
  });
  it('gives a stable lookup per app and key', async () => {
    expect(await tokenLookup(key, 'app', 'abc')).toBe(await tokenLookup(key, 'app', 'abc'));
    expect(await tokenLookup(key, 'app', 'abc')).not.toBe(await tokenLookup(key, 'other', 'abc'));
  });
});

describe('what the relay stores about devices', () => {
  it('has no column that could hold content or personal data', async () => {
    for (const table of ['devices', 'subscriptions']) {
      const columns = await testEnv.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
      expect(columns.results.length).toBeGreaterThan(3);
      for (const column of columns.results) expect(column.name).not.toMatch(/message|content|email|body|text|note|^name$/);
    }
  });
});
