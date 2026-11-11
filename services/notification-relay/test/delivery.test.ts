import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { importPrivateKey, NOTIFICATION_EVENTS, NOTIFICATION_SEALED_LENGTH, signRequest, toBase64Url, type ApnsResponse } from '@openchat/notification-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearProviderTokenCache } from '../src/apns/client';
import { MockApnsTransport } from '../src/apns/transport';
import { backoffSeconds, deliver, type DeliveryMessage, handleDeliveryBatch } from '../src/delivery/consumer';
import { composePush, locKey } from '../src/delivery/payload';
import { deleteOldNotifications, notificationBody } from '../src/delivery/routes';
import { encryptToken, newOpaqueId, tokenLookup } from '../src/devices/crypto';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { DEFAULT_LIMITS } from '../src/limits';
import { clearKeyCache } from '../src/requests/verify';

const testEnv = env as unknown as Env;
let counter = 0;
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
const app = createApp();
const randomToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Captures what would be queued. */
function capturing(): { environment: Env; sent: { body: DeliveryMessage; options?: { delaySeconds?: number } }[] } {
  const sent: { body: DeliveryMessage; options?: { delaySeconds?: number } }[] = [];
  const queue = { send: async (body: DeliveryMessage, options?: { delaySeconds?: number }) => { sent.push({ body, ...(options ? { options } : {}) }); } } as unknown as Env['DELIVERY_QUEUE'];
  return { environment: { ...testEnv, DELIVERY_QUEUE: queue }, sent };
}

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

async function addDevice(i: Installation, recipientId: string, more: { muted?: number; token?: string; bundleId?: string } = {}) {
  const deviceId = newOpaqueId('dev');
  const token = more.token ?? randomToken();
  const bundleId = more.bundleId ?? 'com.example.app';
  const key = testEnv.RELAY_TOKEN_KEY!;
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO devices (id, secret_hash, platform, bundle_id, environment, apns_token, token_lookup, created_at, updated_at) VALUES (?, 'x', 'ios', ?, 'production', ?, ?, 0, 0)`)
      .bind(deviceId, bundleId, await encryptToken(key, bundleId, token), await tokenLookup(key, bundleId, token)),
    testEnv.DB.prepare('INSERT INTO subscriptions (id, device_id, installation_id, workspace_id, recipient_id, muted, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)').bind(newOpaqueId('sub'), deviceId, i.id, i.workspaceId, recipientId, more.muted ?? 0),
  ]);
  return { deviceId, token };
}

/** A stand-in for a sealed notification. The relay never decrypts, so only the size matters to it. */
const sealed = (fill = 'A') => fill.repeat(NOTIFICATION_SEALED_LENGTH);
const item = (i: Installation, more: Record<string, unknown> = {}) => ({ workspaceId: i.workspaceId, event: 'new_message', recipientId: 'mem_a', conversationId: 'conv_a', notificationId: unique('ntf'), payloads: [{ subscriptionId: 'sub_none', ciphertext: sealed() }], ...more });

/** One distinct ciphertext for each of the recipient's subscriptions, as the installation would send. */
async function payloadsFor(i: Installation, recipientId: string) {
  const rows = await testEnv.DB.prepare('SELECT id FROM subscriptions WHERE installation_id = ? AND workspace_id = ? AND recipient_id = ? ORDER BY id').bind(i.id, i.workspaceId, recipientId).all<{ id: string }>();
  const letters = 'BCDEFGHIJKLMNOPQRSTUVWXYZ';
  return rows.results.length > 0 ? rows.results.map((row, n) => ({ subscriptionId: row.id, ciphertext: sealed(letters[n % letters.length]) })) : [{ subscriptionId: 'sub_none', ciphertext: sealed() }];
}

async function signedRequest(i: Installation, path: string, body: unknown, environment: Env, method = 'POST', requestId: string = crypto.randomUUID(), workspaceId: string | undefined = i.workspaceId) {
  const bytes = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signRequest(i.privateKey, { method, path, installationId: i.id, ...(workspaceId ? { workspaceId } : {}), keyId: 'k1', requestId, timestamp, body: bytes });
  return app.request(path, { method, headers: { 'x-installation-id': i.id, 'x-key-id': 'k1', 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-signature': signature, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}) }, ...(method === 'GET' ? {} : { body: bytes }) }, environment);
}

async function queued(i: Installation, more: Record<string, unknown> = {}) {
  const context = capturing();
  const payloads = await payloadsFor(i, (more.recipientId as string | undefined) ?? 'mem_a');
  const response = await signedRequest(i, '/v1/notifications/send', item(i, { payloads, ...more }), context.environment);
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as { id: string };
  return { ...context, id: accepted.id, message: context.sent[0]!.body };
}

const recordOf = (id: string) => testEnv.DB.prepare('SELECT status, delivered, invalid_token AS invalid, failed, muted, processed_attempt AS attempt FROM notifications WHERE id = ?').bind(id).first<{ status: string; delivered: number; invalid: number; failed: number; muted: number; attempt: number }>();

beforeEach(() => {
  clearKeyCache();
  clearProviderTokenCache();
});

describe('sending', () => {
  it('commits, then queues, and answers 202', async () => {
    const i = await newInstallation();
    const { id, sent } = await queued(i);
    expect(await recordOf(id)).toMatchObject({ status: 'queued' });
    expect(sent[0]?.body).toEqual({ id, installationId: i.id, attempt: 1, payloads: { sub_none: sealed() } });
  });

  it('keeps the record when queueing fails, and a retry queues it', async () => {
    const i = await newInstallation();
    const failing: Env = { ...testEnv, DELIVERY_QUEUE: { send: async () => { throw new Error('queue down'); } } as unknown as Env['DELIVERY_QUEUE'] };
    const body = item(i);
    await expect(signedRequest(i, '/v1/notifications/send', body, failing).then((r) => r.status)).resolves.toBe(500);
    const context = capturing();
    const retried = await signedRequest(i, '/v1/notifications/send', body, context.environment);
    expect(await retried.json()).toMatchObject({ status: 'duplicate' });
    expect(context.sent).toHaveLength(1);
  });

  it('answers a duplicate with the original ID, and does not queue finished work', async () => {
    const i = await newInstallation();
    const body = item(i);
    const context = capturing();
    const first = (await (await signedRequest(i, '/v1/notifications/send', body, context.environment)).json()) as { id: string };
    await testEnv.DB.prepare(`UPDATE notifications SET status = 'completed' WHERE id = ?`).bind(first.id).run();
    const second = await (await signedRequest(i, '/v1/notifications/send', body, context.environment)).json();
    expect(second).toEqual({ id: first.id, notificationId: body.notificationId, status: 'duplicate' });
    expect(context.sent).toHaveLength(1);
  });

  it('lets two installations use the same notification ID', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    const notificationId = unique('ntf');
    const first = await queued(a, { notificationId });
    const second = await queued(b, { notificationId });
    expect(first.id).not.toBe(second.id);
  });

  it.each([
    ['message text', { body: 'Hello, my card number is...' }],
    ['a title', { title: 'Your bank' }],
    ['a free-form field in metadata', { metadata: { websiteId: 'site_a', note: 'hello' } }],
    ['an event not on the list', { event: 'custom' }],
    ['a recipient with spaces', { recipientId: 'Ann Smith' }],
    ['a date that is not one', { expiresAt: 'tomorrow' }],
    ['no payloads', { payloads: [] }],
    ['more than 20 payloads', { payloads: Array.from({ length: 21 }, (_, n) => ({ subscriptionId: `sub_${n}`, ciphertext: sealed() })) }],
    ['a ciphertext of another size', { payloads: [{ subscriptionId: 'sub_a', ciphertext: 'A'.repeat(NOTIFICATION_SEALED_LENGTH - 1) }] }],
    ['a ciphertext that is not base64url', { payloads: [{ subscriptionId: 'sub_a', ciphertext: `${'A'.repeat(NOTIFICATION_SEALED_LENGTH - 1)}=` }] }],
    ['two payloads for one subscription', { payloads: [{ subscriptionId: 'sub_a', ciphertext: sealed() }, { subscriptionId: 'sub_a', ciphertext: sealed('B') }] }],
    ['readable text beside a payload', { payloads: [{ subscriptionId: 'sub_a', ciphertext: sealed(), text: 'hello' }] }],
  ])('refuses %s, because the schema is closed', async (_name, more) => {
    const i = await newInstallation();
    const context = capturing();
    expect((await signedRequest(i, '/v1/notifications/send', item(i, more), context.environment)).status).toBe(400);
    expect(context.sent).toHaveLength(0);
  });

  it('allows a website ID in metadata', () => {
    expect(notificationBody.safeParse({ workspaceId: 'w', event: 'mention', recipientId: 'r', conversationId: 'c', notificationId: 'n', payloads: [{ subscriptionId: 's', ciphertext: sealed() }], metadata: { websiteId: 'site_a' } }).success).toBe(true);
  });

  it('refuses a workspace that does not match the header, is revoked, or is another installation\'s', async () => {
    const i = await newInstallation();
    const other = await newInstallation();
    const { environment } = capturing();
    expect((await signedRequest(i, '/v1/notifications/send', item(i, { workspaceId: other.workspaceId }), environment)).status).toBe(400);
    expect((await signedRequest(i, '/v1/notifications/send', item(i, { workspaceId: other.workspaceId }), environment, 'POST', crypto.randomUUID(), other.workspaceId)).status).toBe(403);
    await testEnv.DB.prepare(`UPDATE workspaces SET status = 'revoked' WHERE installation_id = ?`).bind(i.id).run();
    expect((await signedRequest(i, '/v1/notifications/send', item(i), environment)).status).toBe(403);
  });

  it('refuses a replayed request', async () => {
    const i = await newInstallation();
    const { environment } = capturing();
    const requestId = crypto.randomUUID();
    const body = item(i);
    expect((await signedRequest(i, '/v1/notifications/send', body, environment, 'POST', requestId)).status).toBe(202);
    expect((await signedRequest(i, '/v1/notifications/send', body, environment, 'POST', requestId)).status).toBe(409);
  });

  it('never keeps a lifetime beyond a day', async () => {
    const i = await newInstallation();
    const { id } = await queued(i, { expiresAt: '2099-01-01T00:00:00Z' });
    const row = await testEnv.DB.prepare('SELECT expires_at AS e FROM notifications WHERE id = ?').bind(id).first<{ e: number }>();
    expect(row!.e).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
  });
});

describe('batch', () => {
  it('answers per item', async () => {
    const i = await newInstallation();
    const a = item(i);
    const context = capturing();
    await signedRequest(i, '/v1/notifications/send', a, context.environment);
    const response = await signedRequest(i, '/v1/notifications/batch', { notifications: [a, item(i, { recipientId: 'mem_b' })] }, context.environment);
    expect(response.status).toBe(202);
    const { results } = (await response.json()) as { results: { status: string }[] };
    expect(results.map((r) => r.status)).toEqual(['duplicate', 'queued']);
  });

  it('refuses over 100, an empty list, another workspace, and an unknown field', async () => {
    const i = await newInstallation();
    const { environment } = capturing();
    const send = async (notifications: unknown[]) => (await signedRequest(i, '/v1/notifications/batch', { notifications }, environment)).status;
    expect(await send(Array.from({ length: 101 }, (_, n) => item(i, { recipientId: `mem_${n}` })))).toBe(400);
    expect(await send([])).toBe(400);
    expect(await send([item(i, { workspaceId: 'work_other' })])).toBe(400);
    expect(await send([item(i, { text: 'hello' })])).toBe(400);
  });
});

describe('quotas', () => {
  const quotaGuard = (i: Installation) => testEnv.RELAY_GUARD.getByName(i.id);

  it('limits one recipient, and leaves others alone', async () => {
    const i = await newInstallation();
    const { environment } = capturing();
    for (let n = 0; n < 30; n++) expect((await signedRequest(i, '/v1/notifications/send', item(i), environment)).status).toBe(202);
    const refused = await signedRequest(i, '/v1/notifications/send', item(i), environment);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await signedRequest(i, '/v1/notifications/send', item(i, { recipientId: 'mem_b' }), environment)).status).toBe(202);
  });

  it('limits an installation, and takes nothing when refused', async () => {
    const i = await newInstallation();
    const guard = quotaGuard(i);
    await guard.takeNotificationQuota(['mem_a']);
    await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec(`UPDATE quotas SET tokens = 0, updated_at = ? WHERE name = 'installation'`, Date.now()));
    expect(await guard.takeNotificationQuota(['mem_new'])).toMatchObject({ ok: false });
    const count = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM quotas WHERE name = 'recipient:mem_new'`).one().n);
    expect(count).toBe(0);
  });

  it('charges a batch for each recipient it names', async () => {
    const i = await newInstallation();
    expect(await quotaGuard(i).takeNotificationQuota(Array.from({ length: 31 }, () => 'mem_a'))).toMatchObject({ ok: false });
    expect(await quotaGuard(i).takeNotificationQuota(Array.from({ length: 30 }, () => 'mem_a'))).toEqual({ ok: true });
  });

  it('forgets recipient quotas after 10 minutes, and other rows after a day idle, so the alarm can stop', async () => {
    const i = await newInstallation();
    const guard = quotaGuard(i);
    await guard.takeNotificationQuota(['mem_a']);
    const names = (state: DurableObjectState) => state.storage.sql.exec<{ name: string }>('SELECT name FROM quotas ORDER BY name').toArray().map((r) => r.name);
    const left = await runInDurableObject(guard, async (instance, state) => {
      state.storage.sql.exec('UPDATE quotas SET updated_at = ?', Date.now() - 60 * 60_000);
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      const afterAnHour = names(state);
      state.storage.sql.exec('UPDATE quotas SET updated_at = 1');
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      return { afterAnHour, afterADay: names(state) };
    });
    expect(left.afterAnHour).toEqual([expect.stringMatching(/^day:/), 'installation']);
    expect(left.afterADay).toEqual([]);
  });

  const limits = { ...DEFAULT_LIMITS, notificationsPerDay: 3 };

  it('counts a UTC day, and says to come back at midnight', async () => {
    const guard = quotaGuard(await newInstallation());
    expect(await guard.takeNotificationQuota(['mem_a', 'mem_b'], limits)).toEqual({ ok: true });
    expect(await guard.takeNotificationQuota(['mem_a'], limits)).toEqual({ ok: true });
    const refused = await guard.takeNotificationQuota(['mem_c'], limits);
    const now = Date.now();
    const toMidnight = Math.ceil((Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1) - now) / 1000);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(toMidnight - 2);
    expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(toMidnight + 2);
  });

  it('turns a limit off with 0', async () => {
    const guard = quotaGuard(await newInstallation());
    const off = { ...DEFAULT_LIMITS, notificationsPerDay: 0, notificationBurst: 0, recipientBurst: 0 };
    expect(await guard.takeNotificationQuota(Array.from({ length: 400 }, () => 'mem_a'), off)).toEqual({ ok: true });
  });

  it('applies the Worker variables, and raises them for one installation', async () => {
    const limited = await newInstallation();
    const raised = await newInstallation();
    const { environment } = capturing();
    const configured: Env = { ...environment, RELAY_NOTIFICATIONS_PER_DAY: '2', RELAY_LIMIT_OVERRIDES: JSON.stringify({ [raised.id]: { notificationsPerDay: 5 } }) };
    const send = (i: Installation) => signedRequest(i, '/v1/notifications/send', item(i), configured);
    for (let n = 0; n < 2; n++) expect((await send(limited)).status).toBe(202);
    const refused = await send(limited);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    for (let n = 0; n < 5; n++) expect((await send(raised)).status).toBe(202);
    expect((await send(raised)).status).toBe(429);
  });
});

describe('status', () => {
  it('reports counts, and nothing about devices', async () => {
    const i = await newInstallation();
    const { token } = await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i);
    await deliver(environment, new MockApnsTransport([{ status: 200 }]), message);
    const response = await signedRequest(i, `/v1/notifications/${id}`, undefined, environment, 'GET', crypto.randomUUID(), undefined);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ id, status: 'completed', outcomes: { delivered: 1, invalidToken: 0, failed: 0, muted: 0 } });
    expect(text).not.toContain(token);
    expect(text).not.toContain('dev_');
  });

  it('answers 404 to another installation', async () => {
    const i = await newInstallation();
    const other = await newInstallation();
    const { id, environment } = await queued(i);
    expect((await signedRequest(other, `/v1/notifications/${id}`, undefined, environment, 'GET', crypto.randomUUID(), undefined)).status).toBe(404);
  });
});

describe('the payload', () => {
  const input = { event: 'new_message' as const, installationId: 'inst_a', workspaceId: 'work_a', conversationId: 'conv_a', notificationId: 'ntf_a', subscriptionId: 'sub_a', c: sealed(), expiresAt: 1_800_000_000_000 };

  it('holds no readable text: a phrase key, opaque IDs, and this phone\'s ciphertext', async () => {
    const push = await composePush(input);
    expect(JSON.parse(push.body)).toEqual({
      aps: { alert: { 'loc-key': 'OC_NEW_MESSAGE' }, sound: 'default', 'thread-id': expect.stringMatching(/^[0-9a-f]{32}$/), 'mutable-content': 1 },
      oc: { v: 1, event: 'new_message', installationId: 'inst_a', workspaceId: 'work_a', conversationId: 'conv_a', notificationId: 'ntf_a', subscriptionId: 'sub_a', c: sealed() },
    });
  });

  it('fits well within the 4 KB APNs limit', async () => {
    expect(new TextEncoder().encode((await composePush(input)).body).length).toBeLessThan(1024);
  });

  it('sets the headers APNs needs', async () => {
    const { headers } = await composePush(input);
    expect(headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': '1800000000' });
    expect(headers['apns-collapse-id']!.length).toBeLessThanOrEqual(64);
    expect(headers['apns-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('keeps conversations on two installations apart, and is stable across retries', async () => {
    const a = await composePush(input);
    expect((await composePush(input)).headers['apns-id']).toBe(a.headers['apns-id']);
    const other = await composePush({ ...input, installationId: 'inst_b' });
    expect(other.headers['apns-collapse-id']).not.toBe(a.headers['apns-collapse-id']);
    expect(JSON.parse(other.body).aps['thread-id']).not.toBe(JSON.parse(a.body).aps['thread-id']);
  });

  it('has a phrase key for every event', () => {
    expect(NOTIFICATION_EVENTS.map(locKey)).toEqual(['OC_NEW_CONVERSATION', 'OC_NEW_MESSAGE', 'OC_CONVERSATION_ASSIGNED', 'OC_CONVERSATION_TRANSFERRED', 'OC_MENTION', 'OC_CONVERSATION_UPDATED']);
  });
});

describe('delivering', () => {
  it('reaches each of a member\'s devices, and no one else\'s', async () => {
    const i = await newInstallation();
    const a = await addDevice(i, 'mem_a');
    const b = await addDevice(i, 'mem_a');
    const other = await addDevice(i, 'mem_other');
    const { id, environment, message } = await queued(i);
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    expect(transport.requests.map((r) => r.token).sort()).toEqual([a.token, b.token].sort());
    expect(transport.requests.map((r) => r.token)).not.toContain(other.token);
    expect(await recordOf(id)).toMatchObject({ status: 'completed', delivered: 2, attempt: 1 });
  });

  it('keeps one member on two installations apart, even with the same IDs', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    await testEnv.DB.prepare('UPDATE workspaces SET workspace_id = ? WHERE installation_id = ?').bind(a.workspaceId, b.id).run();
    const sameB = { ...b, workspaceId: a.workspaceId };
    const onA = await addDevice(a, 'mem_same');
    const onB = await addDevice(sameB, 'mem_same');
    const { environment, message } = await queued(a, { recipientId: 'mem_same' });
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    expect(transport.requests.map((r) => r.token)).toEqual([onA.token]);
    expect(transport.requests.map((r) => r.token)).not.toContain(onB.token);
  });

  it('sends each phone only its own ciphertext', async () => {
    const i = await newInstallation();
    const a = await addDevice(i, 'mem_a');
    const b = await addDevice(i, 'mem_a');
    const { environment, message } = await queued(i);
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    expect(transport.requests.map((r) => r.token).sort()).toEqual([a.token, b.token].sort());
    const all = Object.values(message.payloads!);
    expect(new Set(all).size).toBe(2);
    for (const request of transport.requests) {
      const oc = JSON.parse(request.body).oc as { subscriptionId: string; c: string };
      expect(oc.c).toBe(message.payloads![oc.subscriptionId]);
      for (const other of all.filter((value) => value !== oc.c)) expect(request.body).not.toContain(other);
    }
  });

  it('sends nothing to a phone the installation sent no ciphertext for', async () => {
    const i = await newInstallation();
    const a = await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i);
    const b = await addDevice(i, 'mem_a');
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    expect(transport.requests.map((r) => r.token)).toEqual([a.token]);
    expect(transport.requests.map((r) => r.token)).not.toContain(b.token);
    expect(await recordOf(id)).toMatchObject({ status: 'completed', delivered: 1 });
  });

  it('records no devices for a message queued without ciphertext', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i);
    const transport = new MockApnsTransport();
    const older: DeliveryMessage = { id: message.id, installationId: message.installationId, attempt: message.attempt };
    await deliver(environment, transport, older);
    expect(transport.requests).toHaveLength(0);
    expect(await recordOf(id)).toMatchObject({ status: 'no_devices' });
  });

  it('uses the device\'s bundle as the topic', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a', { bundleId: 'com.example.other' });
    const { environment, message } = await queued(i);
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    expect(transport.requests[0]?.headers['apns-topic']).toBe('com.example.other');
  });

  it('records no devices', async () => {
    const i = await newInstallation();
    const { id, environment, message } = await queued(i);
    await deliver(environment, new MockApnsTransport(), message);
    expect(await recordOf(id)).toMatchObject({ status: 'no_devices' });
  });

  it('skips and counts a muted device', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a', { muted: 1 });
    const { id, environment, message } = await queued(i);
    const transport = new MockApnsTransport();
    await deliver(environment, transport, message);
    expect(transport.requests).toHaveLength(0);
    expect(await recordOf(id)).toMatchObject({ status: 'completed', muted: 1 });
  });

  it('sends nothing for a revoked workspace', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a');
    const { environment, message } = await queued(i);
    await testEnv.DB.prepare(`UPDATE workspaces SET status = 'revoked' WHERE installation_id = ?`).bind(i.id).run();
    const transport = new MockApnsTransport();
    await deliver(environment, transport, message);
    expect(transport.requests).toHaveLength(0);
  });

  it('never exceeds 6 connections', async () => {
    const i = await newInstallation();
    for (let n = 0; n < 15; n++) await addDevice(i, 'mem_a');
    const { environment, message } = await queued(i);
    let open = 0;
    let peak = 0;
    const transport = { send: async () => { peak = Math.max(peak, ++open); await new Promise((r) => setTimeout(r, 5)); open--; return { status: 200 }; } };
    await deliver(environment, transport, message);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('counts a repeat of the same attempt once, and sends nothing', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i);
    const transport = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, transport, message);
    await deliver(environment, transport, message);
    expect(transport.requests).toHaveLength(1);
    expect(await recordOf(id)).toMatchObject({ delivered: 1 });
  });

  it('does nothing for a message naming another installation', async () => {
    const i = await newInstallation();
    const other = await newInstallation();
    await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i);
    const transport = new MockApnsTransport();
    await deliver(environment, transport, { ...message, installationId: other.id });
    expect(transport.requests).toHaveLength(0);
    expect(await recordOf(id)).toMatchObject({ status: 'queued' });
  });
});

describe('each answer from APNs', () => {
  const removed: [string, ApnsResponse][] = [['410 Unregistered', { status: 410, reason: 'Unregistered' }], ['BadDeviceToken', { status: 400, reason: 'BadDeviceToken' }], ['DeviceTokenNotForTopic', { status: 400, reason: 'DeviceTokenNotForTopic' }]];
  it.each(removed)('%s removes the device', async (_name, answer) => {
    const i = await newInstallation();
    const { deviceId } = await addDevice(i, 'mem_a');
    const { id, environment, message, sent } = await queued(i);
    await deliver(environment, new MockApnsTransport([answer]), message);
    expect(await testEnv.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind(deviceId).first()).toBeNull();
    expect(await testEnv.DB.prepare('SELECT 1 FROM subscriptions WHERE device_id = ?').bind(deviceId).first()).toBeNull();
    expect(await recordOf(id)).toMatchObject({ status: 'completed', invalid: 1 });
    expect(sent).toHaveLength(1);
  });

  const retried: [string, ApnsResponse | Error][] = [['InvalidProviderToken', { status: 403, reason: 'InvalidProviderToken' }], ['TooManyRequests', { status: 429, reason: 'TooManyRequests' }], ['InternalServerError', { status: 500, reason: 'InternalServerError' }], ['ServiceUnavailable', { status: 503, reason: 'ServiceUnavailable' }], ['a lost connection', new Error('Network connection lost')]];
  it.each(retried)('%s keeps the device and retries later', async (_name, answer) => {
    const i = await newInstallation();
    const { deviceId } = await addDevice(i, 'mem_a');
    const { id, environment, message, sent } = await queued(i);
    await deliver(environment, new MockApnsTransport([answer]), message);
    expect(await testEnv.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind(deviceId).first()).not.toBeNull();
    expect(await recordOf(id)).toMatchObject({ status: 'delivering', attempt: 1 });
    expect(sent[1]).toMatchObject({ body: { id, attempt: 2, deviceIds: [deviceId] }, options: { delaySeconds: 30 } });
  });

  it('retries only the devices still outstanding, then finishes', async () => {
    const i = await newInstallation();
    const a = await addDevice(i, 'mem_a');
    const b = await addDevice(i, 'mem_a');
    const { id, environment, message, sent } = await queued(i);
    const first: MockApnsTransport = { requests: [], send: async (r: { token: string }) => (r.token === a.token ? { status: 200 } : { status: 503 }) } as unknown as MockApnsTransport;
    await deliver(environment, first, message);
    expect(sent[1]?.body.deviceIds).toEqual([b.deviceId]);
    // Only the outstanding phone's ciphertext goes into the retry.
    expect(Object.values(sent[1]!.body.payloads!)).toHaveLength(1);
    const second = new MockApnsTransport([{ status: 200 }]);
    await deliver(environment, second, sent[1]!.body);
    expect(second.requests.map((r) => r.token)).toEqual([b.token]);
    expect(await recordOf(id)).toMatchObject({ status: 'completed', delivered: 2, attempt: 2 });
  });

  it('413 PayloadTooLarge is a permanent failure, and keeps the device', async () => {
    const i = await newInstallation();
    const { deviceId } = await addDevice(i, 'mem_a');
    const { id, environment, message, sent } = await queued(i);
    await deliver(environment, new MockApnsTransport([{ status: 413, reason: 'PayloadTooLarge' }]), message);
    expect(await recordOf(id)).toMatchObject({ status: 'completed', failed: 1 });
    expect(await testEnv.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind(deviceId).first()).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('gives up at expiry, without removing the device', async () => {
    const i = await newInstallation();
    const { deviceId } = await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i, { expiresAt: new Date(Date.now() + 10_000).toISOString() });
    await deliver(environment, new MockApnsTransport([{ status: 503 }]), message);
    expect(await recordOf(id)).toMatchObject({ status: 'expired', failed: 1 });
    expect(await testEnv.DB.prepare('SELECT 1 FROM devices WHERE id = ?').bind(deviceId).first()).not.toBeNull();
  });

  it('sends nothing once expired', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a');
    const { id, environment, message } = await queued(i, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const transport = new MockApnsTransport();
    await deliver(environment, transport, message);
    expect(transport.requests).toHaveLength(0);
    expect(await recordOf(id)).toMatchObject({ status: 'expired' });
  });

  it('backs off longer, up to a limit', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoffSeconds)).toEqual([30, 60, 120, 300, 600, 900, 900, 900]);
  });
});

describe('the queue handler', () => {
  const batchOf = (bodies: DeliveryMessage[]) => {
    const log: string[] = [];
    const messages = bodies.map((body, n) => ({ body, id: String(n), attempts: 1, timestamp: new Date(), ack: () => log.push(`ack:${n}`), retry: () => log.push(`retry:${n}`) }));
    return { batch: { messages, queue: 'x', ackAll: () => undefined, retryAll: () => undefined } as unknown as MessageBatch<DeliveryMessage>, log };
  };

  it('acknowledges finished work', async () => {
    const i = await newInstallation();
    const { environment, message } = await queued(i);
    const { batch, log } = batchOf([message]);
    await handleDeliveryBatch(batch, environment, new MockApnsTransport());
    expect(log).toEqual(['ack:0']);
  });

  it('retries a failure explicitly, and carries on with the others', async () => {
    const i = await newInstallation();
    await addDevice(i, 'mem_a');
    const { environment, message } = await queued(i);
    const brokenDb: Env = { ...environment, DB: { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database };
    const { batch, log } = batchOf([message, message]);
    await handleDeliveryBatch(batch, brokenDb, new MockApnsTransport());
    expect(log).toEqual(['retry:0', 'retry:1']);
  });
});

describe('what the relay keeps', () => {
  it('removes records after 30 days, and keeps newer ones', async () => {
    const i = await newInstallation();
    const old = await queued(i);
    const recent = await queued(i);
    await testEnv.DB.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').bind(Date.now() - 31 * 24 * 60 * 60_000, old.id).run();
    await deleteOldNotifications(testEnv.DB, Date.now());
    expect(await recordOf(old.id)).toBeNull();
    expect(await recordOf(recent.id)).not.toBeNull();
  });

  it('has no column that could hold content or personal data', async () => {
    const columns = await testEnv.DB.prepare(`SELECT name FROM pragma_table_info('notifications')`).all<{ name: string }>();
    expect(columns.results.length).toBeGreaterThan(5);
    for (const column of columns.results) expect(column.name).not.toMatch(/message|content|email|body|text|note|title|^name$/);
  });
});
