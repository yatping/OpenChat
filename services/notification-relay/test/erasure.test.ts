import { env } from 'cloudflare:workers';
import { importPrivateKey, signGrant, signRequest, toBase64Url } from '@openchat/notification-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { deleteOrphanDevices, ORPHAN_DEVICE_TTL_MS } from '../src/requests/store';
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

const grantFor = (i: Installation) => {
  const iat = nowSeconds();
  return signGrant(i.privateKey, 'k1', { iss: i.id, aud: 'relay-test', wid: i.workspaceId, sub: 'mem_a', jti: crypto.randomUUID(), iat, exp: iat + 300 });
};

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { 'cf-connecting-ip': unique('ip'), ...headers }, body: JSON.stringify(body) }, testEnv);

async function register(grant: string, device?: { id: string; secret: string }) {
  const response = await post('/v1/devices/register', { grant, platform: 'ios', apnsToken: randomToken(), bundleId: 'com.example.app', environment: 'production', locale: 'en-GB', ...(device ? { device } : {}) });
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceId: string; deviceSecret?: string; subscriptionId: string };
}

async function signedPost(i: Installation, path: string, body: unknown, options: { workspaceId?: string; raw?: string } = {}) {
  const bytes = new TextEncoder().encode(options.raw ?? JSON.stringify(body));
  const requestId = crypto.randomUUID();
  const timestamp = String(nowSeconds());
  const { workspaceId } = options;
  const signature = await signRequest(i.privateKey, { method: 'POST', path, installationId: i.id, ...(workspaceId ? { workspaceId } : {}), keyId: 'k1', requestId, timestamp, body: bytes });
  return app.request(path, { method: 'POST', headers: { 'x-installation-id': i.id, 'x-key-id': 'k1', 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-signature': signature, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }, body: bytes }, testEnv);
}

const count = async (sql: string, ...values: unknown[]) => (await testEnv.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).bind(...values).first<{ n: number }>())!.n;

async function held(i: Installation) {
  return {
    installations: await count('installations WHERE id = ?', i.id),
    keys: await count('installation_keys WHERE installation_id = ?', i.id),
    workspaces: await count('workspaces WHERE installation_id = ?', i.id),
    subscriptions: await count('subscriptions WHERE installation_id = ?', i.id),
    notifications: await count('notifications WHERE installation_id = ?', i.id),
  };
}
const nothing = { installations: 0, keys: 0, workspaces: 0, subscriptions: 0, notifications: 0 };

/** One installation with a device and a delivery record, and another sharing that device. */
async function populated() {
  const leaving = await newInstallation();
  const staying = await newInstallation();
  const shared = await register(await grantFor(leaving));
  await register(await grantFor(staying), { id: shared.deviceId, secret: shared.deviceSecret! });
  const only = await register(await grantFor(leaving));
  const sent = await signedPost(leaving, '/v1/notifications/send', { workspaceId: leaving.workspaceId, event: 'new_message', recipientId: 'mem_a', conversationId: 'conv_1', notificationId: unique('ntf') }, { workspaceId: leaving.workspaceId });
  expect(sent.status).toBe(202);
  return { leaving, staying, shared, only };
}

const deviceExists = async (id: string) => (await count('devices WHERE id = ?', id)) === 1;

beforeEach(() => clearKeyCache());

describe('an installation unregistering', () => {
  it('erases everything about it, and its devices that nothing else uses', async () => {
    const { leaving, staying, shared, only } = await populated();
    expect((await held(leaving)).notifications).toBe(1);

    const response = await signedPost(leaving, '/v1/installations/unregister', {});
    expect(response.status).toBe(204);
    expect(await held(leaving)).toEqual(nothing);
    expect(await deviceExists(only.deviceId)).toBe(false);
    // Another installation still uses this device, and keeps its subscription.
    expect(await deviceExists(shared.deviceId)).toBe(true);
    expect((await held(staying)).subscriptions).toBe(1);
  });

  it('cannot send afterwards, and repeating it answers 401', async () => {
    const { leaving } = await populated();
    expect((await signedPost(leaving, '/v1/installations/unregister', {})).status).toBe(204);
    expect((await signedPost(leaving, '/v1/installations/unregister', {})).status).toBe(401);
    const sent = await signedPost(leaving, '/v1/notifications/send', { workspaceId: leaving.workspaceId, event: 'new_message', recipientId: 'mem_a', conversationId: 'conv_1', notificationId: unique('ntf') }, { workspaceId: leaving.workspaceId });
    expect(sent.status).toBe(401);
  });

  it('cannot be asked for by another installation, or for a workspace', async () => {
    const { leaving, staying } = await populated();
    const forged = { ...staying, id: leaving.id };
    expect((await signedPost(forged, '/v1/installations/unregister', {})).status).toBe(401);
    expect((await signedPost(leaving, '/v1/installations/unregister', {}, { workspaceId: leaving.workspaceId })).status).toBe(400);
    expect((await held(leaving)).installations).toBe(1);
  });

  it('takes no body fields', async () => {
    const { leaving } = await populated();
    expect((await signedPost(leaving, '/v1/installations/unregister', { reason: 'leaving' })).status).toBe(400);
    expect((await signedPost(leaving, '/v1/installations/unregister', null, { raw: 'not json' })).status).toBe(400);
    expect((await held(leaving)).installations).toBe(1);
  });
});

describe('the operator erasing an installation', () => {
  const erase = (body: unknown, authorization = 'Bearer test-operator-token') => app.request('/v1/operator/erase', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) }, testEnv);

  it('erases it, and says what went', async () => {
    const { leaving, only } = await populated();
    const response = await erase({ installationId: leaving.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installation: true, workspaces: 1, subscriptions: 2, notifications: 1 });
    expect(await held(leaving)).toEqual(nothing);
    expect(await deviceExists(only.deviceId)).toBe(false);
  });

  it('answers the same for an installation it never had', async () => {
    const response = await erase({ installationId: unique('inst') });
    expect(await response.json()).toEqual({ installation: false, workspaces: 0, subscriptions: 0, devices: expect.any(Number), notifications: 0 });
  });

  it('is 404 without the operator token, and 400 for a bad body', async () => {
    const { leaving } = await populated();
    expect((await erase({ installationId: leaving.id }, 'Bearer wrong')).status).toBe(404);
    expect((await erase({ installationId: "x'; DROP TABLE devices" })).status).toBe(400);
    expect((await erase({ installationId: leaving.id, more: 1 })).status).toBe(400);
    expect((await held(leaving)).installations).toBe(1);
  });
});

describe('devices that signed out of everything', () => {
  it('are deleted once unused for a week', async () => {
    const i = await newInstallation();
    const device = await register(await grantFor(i));
    await testEnv.DB.prepare('DELETE FROM subscriptions WHERE device_id = ?').bind(device.deviceId).run();
    await deleteOrphanDevices(testEnv.DB, Date.now());
    expect(await deviceExists(device.deviceId)).toBe(true);
    await deleteOrphanDevices(testEnv.DB, Date.now() + ORPHAN_DEVICE_TTL_MS + 1);
    expect(await deviceExists(device.deviceId)).toBe(false);
  });

  it('are kept while subscribed, however old', async () => {
    const i = await newInstallation();
    const device = await register(await grantFor(i));
    await deleteOrphanDevices(testEnv.DB, Date.now() + 10 * ORPHAN_DEVICE_TTL_MS);
    expect(await deviceExists(device.deviceId)).toBe(true);
  });
});
