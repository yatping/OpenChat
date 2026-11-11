import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateSerializedKey, hashPassword } from '@openchat/auth';
import { fromBase64Url, generateX25519KeyPair, importPublicKey, openNotification, parseGrant, toBase64Url, verifyGrant, verifyRequest, type X25519KeyPair } from '@openchat/notification-protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from '../src/background';
import { sweepOutbox } from '../src/dispatch';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const RELAY = 'https://relay.example.org';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = 'work_a';
const CONV = 'conv_a';

type Job = { type: string; idempotencyKey: string; workspaceId: string; notAfter?: string; payload: Record<string, unknown> };
type Sent = { path: string; body: Record<string, unknown>; headers: Headers };

const key = await generateSerializedKey('k1');
let queued: Job[] = [];
let relayAnswer: (path: string) => Response;
let sent: Sent[] = [];
let badSignatures = 0;

const queue = {
  send: async (job: Job) => void queued.push(job),
  sendBatch: async (jobs: { body: Job }[]) => void queued.push(...jobs.map((j) => j.body)),
} as unknown as Queue;
const withRelay = { ...env, NOTIFICATIONS_QUEUE: queue, RELAY_URL: RELAY, RELAY_ID: 'managed', RELAY_BUNDLE_IDS: 'org.example.app, org.example.other', RELAY_SIGNING_KEY: JSON.stringify({ active: key }) } as unknown as Env;
const withoutRelay = { ...env, NOTIFICATIONS_QUEUE: queue } as unknown as Env;

let counter = 0;
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string; env?: Env } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `192.0.2.${++counter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.env ?? withRelay,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function runQueue() {
  const outcomes: { job: Job; acked: boolean; delay?: number }[] = [];
  while (queued.length > 0) {
    const jobs = queued;
    queued = [];
    const messages = jobs.map((body) => {
      const outcome: (typeof outcomes)[number] = { job: body, acked: false };
      outcomes.push(outcome);
      return { id: crypto.randomUUID(), body, attempts: 1, ack: () => { outcome.acked = true; }, retry: (o?: { delaySeconds?: number }) => { if (o?.delaySeconds !== undefined) outcome.delay = o.delaySeconds; } };
    });
    await handleQueue({ queue: 'oc-local-notifications', messages } as unknown as MessageBatch, withRelay, { email: { send: () => Promise.reject(new Error('unused')) } });
  }
  return outcomes;
}

const notifications = () => sent.filter((s) => s.path === '/v1/notifications/batch').flatMap((s) => s.body.notifications as Record<string, string>[]);

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

const tokens: Record<string, string> = {};

beforeEach(async () => {
  queued = [];
  sent = [];
  badSignatures = 0;
  relayAnswer = (path) => new Response(path === '/v1/devices/unregister' ? null : '{}', { status: path === '/v1/devices/unregister' ? 204 : 202 });
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== RELAY) return real(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const headers = request.headers;
    const workspaceId = headers.get('x-workspace-id');
    const verdict = await verifyRequest(
      await importPublicKey(key.publicKey),
      { method: request.method, path: url.pathname, installationId: headers.get('x-installation-id')!, ...(workspaceId ? { workspaceId } : {}), keyId: headers.get('x-key-id')!, requestId: headers.get('x-request-id')!, timestamp: headers.get('x-timestamp')!, body: bytes },
      headers.get('x-signature')!,
    );
    if (!verdict.ok) badSignatures++;
    sent.push({ path: url.pathname, body: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>, headers });
    return relayAnswer(url.pathname);
  });

  const tables = ['notification_preferences', 'push_subscriptions', 'outbox', 'audit_log', 'conversation_events', 'messages', 'conversation_read_cursors', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_tokens', 'auth_sessions', 'workspaces', 'users', 'installation', 'failed_jobs'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', ?1, 1, 1)`).bind(ORIGIN),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, 'Acme', 'acme', 1, 1)`).bind(W),
    ...['one', 'two', 'three'].flatMap((name) => [
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${name}`, `${name}@example.com`, name, hash),
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', 1, 1)`).bind(`mem_${name}`, W, `user_${name}`, name === 'two' ? 'supervisor' : 'agent'),
    ]),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_a', ?1, 'Site', 'key_a', json_array(?2), 1, 1)`).bind(W, SITE),
    env.DB.prepare(`INSERT INTO contacts (id, workspace_id, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('cont_a', ?1, 1, 1, 1, 1)`).bind(W),
    env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at) VALUES (?1, ?2, 'site_a', 'cont_a', 1, 1, 1)`).bind(CONV, W),
  ]);
  for (const name of ['one', 'two', 'three']) {
    const login = await call('POST', '/api/v1/auth/login', { body: { email: `${name}@example.com`, password: PASSWORD, clientType: 'mobile' } });
    tokens[name] = ((await login.json()) as { accessToken: string }).accessToken;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(badSignatures).toBe(0);
});

/** Each phone's key pair, by relay subscription ID, so that a test can open what the phone would receive. */
const phones = new Map<string, X25519KeyPair>();
const newPreviewKey = async (id: string) => {
  const pair = await generateX25519KeyPair();
  phones.set(id, pair);
  return toBase64Url(pair.publicKey);
};
const subscribe = async (name: string, id = `sub_${name}`) => {
  const response = await call('POST', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens[name]!, body: { relaySubscriptionId: id, previewKey: await newPreviewKey(id) } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};
const assign = (member: string, by: string, expectedVersion = 1) => call('PATCH', `/api/v1/workspaces/${W}/conversations/${CONV}`, { token: tokens[by]!, body: { expectedVersion, assignedMemberId: member } });
const memberSays = (name: string, type: 'text' | 'internal_note' = 'text') =>
  call('POST', `/api/v1/workspaces/${W}/conversations/${CONV}/messages`, { token: tokens[name]!, body: { clientMessageId: crypto.randomUUID(), type, content: 'secret words from a member' } });

async function visitorStarts(): Promise<{ token: string; conversationId: string }> {
  const session = await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_a' } });
  const token = ((await session.json()) as { accessToken: string }).accessToken;
  const created = await call('POST', '/api/v1/widget/conversations', { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'secret words from a visitor' } });
  expect(created.status).toBe(201);
  return { token, conversationId: ((await created.json()) as { id: string }).id };
}

describe('discovery', () => {
  it('names the relay and the public key, and never the private one', async () => {
    const response = await call('GET', '/.well-known/openchat.json');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ relay: { id: 'managed', url: RELAY, bundleIds: ['org.example.app', 'org.example.other'], publicKeys: [{ id: 'k1', alg: 'Ed25519', key: key.publicKey }] } });
    expect(text).not.toContain(key.privateKey);
  });

  it('treats an unreadable signing key as no relay, and still answers', async () => {
    const response = await call('GET', '/.well-known/openchat.json', { env: { ...withRelay, RELAY_SIGNING_KEY: 'not json' } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { relay: unknown }).relay).toBeNull();
  });

  it('says there is no relay when none is configured', async () => {
    const response = await call('GET', '/.well-known/openchat.json', { env: withoutRelay });
    expect(((await response.json()) as { relay: unknown }).relay).toBeNull();
  });
});

describe('grants', () => {
  const grantFor = (name: string) => call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens[name]! });

  it('registers once, and vouches for the caller as a member of this workspace', async () => {
    const response = await grantFor('one');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { grant: string; relayUrl: string; expiresAt: string };
    expect(body.relayUrl).toBe(RELAY);
    const parsed = parseGrant(body.grant)!;
    expect(await verifyGrant(await importPublicKey(key.publicKey), parsed, 'managed')).toBe(true);
    expect(parsed.claims).toMatchObject({ iss: 'inst_test', wid: W, sub: 'mem_one' });
    expect(parsed.claims.exp - parsed.claims.iat).toBe(300);

    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register']);
    expect(sent[0]!.body).toEqual({ baseUrl: ORIGIN, publicKey: { id: 'k1', alg: 'Ed25519', key: key.publicKey } });
    expect(sent[0]!.headers.get('x-workspace-id')).toBeNull();
    expect(sent[1]!.body).toEqual({ workspaceId: W });

    await grantFor('two');
    expect(sent).toHaveLength(2);
    expect(fromBase64Url(key.publicKey)).toHaveLength(32);
  });

  it('gives a different single-use ID each time', async () => {
    const jti = async () => parseGrant(((await (await grantFor('one')).json()) as { grant: string }).grant)!.claims.jti;
    expect(await jti()).not.toBe(await jti());
  });

  it('registers again with a different relay', async () => {
    await grantFor('one');
    sent = [];
    await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one!, env: { ...withRelay, RELAY_ID: 'other' } });
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register']);
  });

  it('never tells the relay the workspace name, even after a rename', async () => {
    await grantFor('one');
    await env.DB.prepare(`UPDATE workspaces SET name = 'Renamed' WHERE id = ?1`).bind(W).run();
    await grantFor('one');
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register']);
    expect(JSON.stringify(sent.map((s) => s.body))).not.toMatch(/Acme|Renamed/);
  });

  it('answers 503 while the relay is down, and messaging carries on', async () => {
    relayAnswer = () => new Response('{}', { status: 500 });
    expect((await grantFor('one')).status).toBe(503);
    expect((await memberSays('one')).status).toBe(201);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    expect((await grantFor('one')).status).toBe(503);
    expect((await memberSays('one')).status).toBe(201);
  });

  it('registers again on the next grant after the relay erased this installation', async () => {
    await grantFor('one');
    await subscribe('one');
    // The relay is not asked again for a grant, so a refused notification is how the installation learns of it.
    relayAnswer = () => new Response('{"code":"unauthorized"}', { status: 401 });
    await visitorStarts();
    await runQueue();
    relayAnswer = () => new Response('{}', { status: 201 });
    sent = [];
    expect((await grantFor('one')).status).toBe(201);
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register']);
  });

  it('is refused with no relay configured', async () => {
    const response = await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one!, env: withoutRelay });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('push_not_configured');
  });

  it('is refused for a member removed from the workspace', async () => {
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_one'`).run();
    expect((await grantFor('one')).status).toBe(404);
  });
});

describe('subscriptions', () => {
  it('stores only the handle, and the same handle twice is one row', async () => {
    const first = await subscribe('one');
    expect(await subscribe('one')).toBe(first);
    const listed = (await (await call('GET', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens.one! })).json()) as { data: { id: string; relaySubscriptionId: string }[] };
    expect(listed.data).toMatchObject([{ id: first, relaySubscriptionId: 'sub_one', platform: 'ios' }]);
  });

  it('refuses something that is not a handle, such as a device token', async () => {
    const response = await call('POST', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens.one!, body: { relaySubscriptionId: 'a'.repeat(64), previewKey: await newPreviewKey('x') } });
    expect(response.status).toBe(400);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>())!.n).toBe(0);
  });

  it('refuses a subscription without a key, or with something that is not one', async () => {
    for (const previewKey of [undefined, 'short', 'a'.repeat(44)]) {
      const response = await call('POST', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens.one!, body: { relaySubscriptionId: 'sub_one', ...(previewKey ? { previewKey } : {}) } });
      expect(response.status).toBe(400);
    }
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>())!.n).toBe(0);
  });

  it('takes a new key for the same handle, from the same person', async () => {
    await subscribe('one');
    const before = await env.DB.prepare(`SELECT preview_key AS k FROM push_subscriptions`).first<{ k: string }>();
    await subscribe('one');
    const after = await env.DB.prepare(`SELECT preview_key AS k, COUNT(*) AS n FROM push_subscriptions`).first<{ k: string; n: number }>();
    expect(after).toMatchObject({ n: 1 });
    expect(after!.k).not.toBe(before!.k);
    expect(after!.k).toBe(toBase64Url(phones.get('sub_one')!.publicKey));
  });

  it("will not take over someone else's handle, or replace their key", async () => {
    await subscribe('one', 'sub_shared');
    const key = toBase64Url(phones.get('sub_shared')!.publicKey);
    const response = await call('POST', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens.two!, body: { relaySubscriptionId: 'sub_shared', previewKey: await newPreviewKey('attacker') } });
    expect(response.status).toBe(409);
    expect(await env.DB.prepare(`SELECT member_id AS m, preview_key AS k FROM push_subscriptions`).first<{ m: string; k: string }>()).toEqual({ m: 'mem_one', k: key });
  });

  it('keeps the newest 20 for one person', async () => {
    for (let i = 0; i < 22; i++) await subscribe('one', `sub_${i}`);
    const { results } = await env.DB.prepare(`SELECT relay_subscription_id AS s FROM push_subscriptions`).all<{ s: string }>();
    expect(results).toHaveLength(20);
    expect(results.map((r) => r.s)).not.toContain('sub_0');
  });

  it("removes one's own and tells the relay, and another person's answers 404", async () => {
    await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one! });
    const id = await subscribe('one');
    expect((await call('DELETE', `/api/v1/workspaces/${W}/push/subscriptions/${id}`, { token: tokens.two! })).status).toBe(404);
    expect(await runQueue()).toEqual([]);
    expect((await call('DELETE', `/api/v1/workspaces/${W}/push/subscriptions/${id}`, { token: tokens.one! })).status).toBe(204);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>())!.n).toBe(0);
    sent = [];
    expect((await runQueue()).every((o) => o.acked)).toBe(true);
    expect(sent).toMatchObject([{ path: '/v1/devices/unregister', body: { subscriptionId: 'sub_one' } }]);
  });

  it('finishes telling the relay from the sweep, if the isolate died', async () => {
    await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one! });
    const id = await subscribe('one');
    await call('DELETE', `/api/v1/workspaces/${W}/push/subscriptions/${id}`, { token: tokens.one! });
    queued = [];
    await env.DB.prepare(`UPDATE outbox SET dispatched_at = NULL, created_at = created_at - 120000 WHERE topic = 'push.subscription_removed'`).run();
    await sweepOutbox(withRelay, Date.now());
    expect(queued).toMatchObject([{ type: 'notification.unregister', payload: { relaySubscriptionId: 'sub_one' } }]);
  });
});

describe('preferences', () => {
  const path = `/api/v1/workspaces/${W}/notification-preferences`;
  const read = async (name: string) => ((await (await call('GET', path, { token: tokens[name]! })).json()) as { preferences: { eventType: string; enabled: boolean }[] }).preferences;

  it('starts with everything on, and belongs to one person', async () => {
    expect((await read('one')).every((p) => p.enabled)).toBe(true);
    expect((await call('PUT', path, { token: tokens.one!, body: { preferences: [{ eventType: 'new_message', channel: 'push', enabled: false }] } })).status).toBe(204);
    expect((await read('one')).find((p) => p.eventType === 'new_message')!.enabled).toBe(false);
    expect((await read('two')).find((p) => p.eventType === 'new_message')!.enabled).toBe(true);
  });

  it('replaces what was there', async () => {
    await call('PUT', path, { token: tokens.one!, body: { preferences: [{ eventType: 'new_message', channel: 'push', enabled: false }] } });
    await call('PUT', path, { token: tokens.one!, body: { preferences: [] } });
    expect((await read('one')).every((p) => p.enabled)).toBe(true);
  });

  it('refuses an event that does not exist', async () => {
    expect((await call('PUT', path, { token: tokens.one!, body: { preferences: [{ eventType: 'free_text', channel: 'push', enabled: false }] } })).status).toBe(400);
  });
});

describe('who gets a push', () => {
  beforeEach(async () => {
    await subscribe('one');
    await subscribe('two');
  });
  const recipients = () => notifications().map((n) => n.recipientId).sort();

  it('a new conversation goes to everyone with a device, carrying only IDs and ciphertext', async () => {
    const { conversationId } = await visitorStarts();
    await runQueue();
    expect(recipients()).toEqual(['mem_one', 'mem_two']);
    expect(notifications()[0]).toMatchObject({ event: 'new_conversation', workspaceId: W, conversationId });
    expect(Object.keys(notifications()[0]!).sort()).toEqual(['conversationId', 'event', 'expiresAt', 'notificationId', 'payloads', 'recipientId', 'workspaceId']);
    expect(JSON.stringify(sent.map((s) => s.body))).not.toMatch(/secret words|Acme|Visitor/);
  });

  it('encrypts for each phone, and only that phone opens it, to the workspace, sender and text', async () => {
    await subscribe('one', 'sub_one_ipad');
    await visitorStarts();
    await runQueue();
    const mine = notifications().find((n) => n.recipientId === 'mem_one') as unknown as { notificationId: string; payloads: { subscriptionId: string; ciphertext: string }[] };
    expect(mine.payloads.map((p) => p.subscriptionId).sort()).toEqual(['sub_one', 'sub_one_ipad']);
    const binding = (subscriptionId: string) => ({ installationId: 'inst_test', workspaceId: W, notificationId: mine.notificationId, subscriptionId });
    for (const payload of mine.payloads) {
      expect(await openNotification(phones.get(payload.subscriptionId)!, payload.ciphertext, binding(payload.subscriptionId))).toEqual({ v: 1, title: 'Acme', sender: 'Visitor', text: 'secret words from a visitor' });
    }
    await expect(openNotification(phones.get('sub_two')!, mine.payloads[0]!.ciphertext, binding('sub_two'))).rejects.toThrow();
    await expect(openNotification(phones.get('sub_one_ipad')!, mine.payloads.find((p) => p.subscriptionId === 'sub_one')!.ciphertext, binding('sub_one'))).rejects.toThrow();
  });

  it("names a colleague, marks a note, and says what an assignment is", async () => {
    const open = async (n: Record<string, unknown>) => {
      const { notificationId, payloads } = n as unknown as { notificationId: string; payloads: { subscriptionId: string; ciphertext: string }[] };
      return openNotification(phones.get(payloads[0]!.subscriptionId)!, payloads[0]!.ciphertext, { installationId: 'inst_test', workspaceId: W, notificationId, subscriptionId: payloads[0]!.subscriptionId });
    };
    await assign('mem_one', 'two');
    await runQueue();
    expect(await open(notifications()[0]!)).toEqual({ v: 1, title: 'Acme', sender: '', text: 'Conversation assigned to you' });
    sent = [];
    await memberSays('two');
    await memberSays('two', 'internal_note');
    await runQueue();
    const texts = await Promise.all(notifications().map(open));
    expect(texts.map((c) => `${c.sender}: ${c.text}`).sort()).toEqual(['two: Note: secret words from a member', 'two: secret words from a member']);
  });

  it('sends nothing for a phone recorded before keys existed', async () => {
    await env.DB.prepare(`UPDATE push_subscriptions SET preview_key = ''`).run();
    await visitorStarts();
    await runQueue();
    expect(sent.filter((s) => s.path === '/v1/notifications/batch')).toEqual([]);
  });

  it("a visitor's later message goes to whoever has the conversation", async () => {
    const { token, conversationId } = await visitorStarts();
    await runQueue();
    sent = [];
    await env.DB.prepare(`UPDATE conversations SET assigned_member_id = 'mem_two' WHERE id = ?1`).bind(conversationId).run();
    await call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'more' } });
    await runQueue();
    expect(notifications()).toMatchObject([{ event: 'new_message', recipientId: 'mem_two' }]);
  });

  it("a colleague's reply or note goes to whoever has the conversation, and never back to its author", async () => {
    await assign('mem_one', 'two');
    await runQueue();
    sent = [];
    await memberSays('two');
    await memberSays('two', 'internal_note');
    await runQueue();
    expect(recipients()).toEqual(['mem_one', 'mem_one']);
    expect(new Set(notifications().map((n) => n.notificationId)).size).toBe(2);
    sent = [];
    await memberSays('one');
    await runQueue();
    expect(recipients()).toEqual([]);
  });

  it('a reply in a conversation nobody has goes to nobody', async () => {
    await memberSays('one');
    await runQueue();
    expect(recipients()).toEqual([]);
  });

  it('an assignment goes to the person assigned, unless they did it themselves', async () => {
    expect((await assign('mem_one', 'two')).status).toBe(200);
    await runQueue();
    expect(notifications()).toMatchObject([{ event: 'conversation_assigned', recipientId: 'mem_one', conversationId: CONV }]);
    sent = [];
    expect((await assign('mem_two', 'two', 2)).status).toBe(200);
    await runQueue();
    expect(recipients()).toEqual([]);
  });

  it('skips an assignment that has already changed by the time it runs', async () => {
    await assign('mem_one', 'two');
    await env.DB.prepare(`UPDATE conversations SET assigned_member_id = 'mem_two' WHERE id = ?1`).bind(CONV).run();
    await runQueue();
    expect(recipients()).toEqual([]);
  });

  it('other changes to a conversation send nothing', async () => {
    await call('PATCH', `/api/v1/workspaces/${W}/conversations/${CONV}`, { token: tokens.one!, body: { expectedVersion: 1, priority: 'urgent' } });
    expect(queued).toEqual([]);
  });

  it('respects a preference, for that event only', async () => {
    await call('PUT', `/api/v1/workspaces/${W}/notification-preferences`, { token: tokens.two!, body: { preferences: [{ eventType: 'new_conversation', channel: 'push', enabled: false }] } });
    await visitorStarts();
    await runQueue();
    expect(recipients()).toEqual(['mem_one']);
  });

  it('leaves out someone suspended, deactivated, or with no device', async () => {
    await subscribe('three');
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_two'`).run();
    await env.DB.prepare(`UPDATE users SET disabled_at = 1 WHERE id = 'user_three'`).run();
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE member_id = 'mem_one'`).run();
    await visitorStarts();
    await runQueue();
    expect(recipients()).toEqual([]);
    expect(sent.filter((s) => s.path === '/v1/notifications/batch')).toEqual([]);
  });

  it('sends the same notification ID when the event runs twice', async () => {
    await visitorStarts();
    const first = [...queued];
    await runQueue();
    const ids = notifications().map((n) => n.notificationId).sort();
    sent = [];
    queued = first;
    await runQueue();
    expect(notifications().map((n) => n.notificationId).sort()).toEqual(ids);
  });

  it('splits a large workspace into chunks the relay accepts', async () => {
    const statements = [];
    const previewKey = await newPreviewKey('shared');
    for (let i = 0; i < 60; i++) {
      statements.push(env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, 'x', 'x', 1, 1)`).bind(`user_${i}`, `u${i}@example.com`));
      statements.push(env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'agent', 'active', 1, 1)`).bind(`mem_${i}`, W, `user_${i}`));
      statements.push(env.DB.prepare(`INSERT INTO push_subscriptions (id, workspace_id, member_id, relay_id, relay_subscription_id, preview_key, platform, created_at, updated_at) VALUES (?1, ?2, ?3, 'managed', ?1, ?4, 'ios', 1, 1)`).bind(`sub_${i}`, W, `mem_${i}`, previewKey));
    }
    await env.DB.batch(statements);
    await visitorStarts();
    await runQueue();
    expect(notifications()).toHaveLength(62);
    const batches = sent.filter((s) => s.path === '/v1/notifications/batch');
    expect(batches.map((b) => (b.body.notifications as unknown[]).length).sort()).toEqual([12, 50]);
    expect(batches[0]!.headers.get('x-workspace-id')).toBe(W);
  });

  it('queues nothing with no relay configured', async () => {
    await call('POST', `/api/v1/workspaces/${W}/conversations/${CONV}/messages`, { token: tokens.one!, env: withoutRelay, body: { clientMessageId: crypto.randomUUID(), type: 'text', content: 'x' } });
    expect(queued).toEqual([]);
  });
});

describe('when the relay answers badly', () => {
  beforeEach(async () => {
    await subscribe('one');
    await visitorStarts();
  });
  const settle = async () => {
    const fanout = await runQueue();
    return fanout.find((o) => o.job.type === 'notification.dispatch')!;
  };

  it('waits as long as a 429 asks', async () => {
    relayAnswer = (path) => (path === '/v1/notifications/batch' ? new Response('{"code":"rate_limited"}', { status: 429, headers: { 'retry-after': '77' } }) : new Response('{}', { status: 201 }));
    const outcome = await settle();
    expect(outcome.acked).toBe(false);
    expect(outcome.delay).toBe(77);
  });

  it('retries a server error', async () => {
    relayAnswer = (path) => (path === '/v1/notifications/batch' ? new Response('{}', { status: 502 }) : new Response('{}', { status: 201 }));
    expect((await settle()).acked).toBe(false);
  });

  it('retries a 404, which is what a relay that has gone away answers', async () => {
    relayAnswer = (path) => (path === '/v1/notifications/batch' ? new Response('<html>Not found</html>', { status: 404 }) : new Response('{}', { status: 201 }));
    expect((await settle()).acked).toBe(false);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM failed_jobs`).first<{ n: number }>())!.n).toBe(0);
  });

  it('records a request the relay calls malformed, and does not retry it', async () => {
    relayAnswer = (path) => (path === '/v1/notifications/batch' ? new Response('{"code":"malformed_request"}', { status: 400 }) : new Response('{}', { status: 201 }));
    expect((await settle()).acked).toBe(true);
    const failed = await env.DB.prepare(`SELECT job_type AS t, envelope_json AS e FROM failed_jobs`).first<{ t: string; e: string }>();
    expect(failed?.t).toBe('notification.dispatch');
    // The notification's text is message content, and failed_jobs keeps IDs only.
    const stored = JSON.parse(failed!.e) as { payload: Record<string, unknown> };
    expect(stored.payload.notifications).toBeDefined();
    expect(stored.payload).not.toHaveProperty('text');
  });

  it('registers again after a relay that lost its data, and then delivers', async () => {
    await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one! });
    let refusals = 1;
    relayAnswer = (path) => {
      if (path === '/v1/notifications/batch' && refusals-- > 0) return new Response('{"code":"workspace_not_registered"}', { status: 403 });
      return new Response('{}', { status: 202 });
    };
    const held = [...queued];
    const outcome = await settle();
    expect(outcome.acked).toBe(false);
    sent = [];
    queued = [outcome.job];
    expect(held.length).toBeGreaterThan(0);
    await runQueue();
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register', '/v1/notifications/batch']);
  });

  it('drops a job past its time without calling the relay', async () => {
    const fanout = await runQueue();
    sent = [];
    const dispatch = fanout.find((o) => o.job.type === 'notification.dispatch')!.job;
    queued = [{ ...dispatch, notAfter: new Date(Date.now() - 1000).toISOString() }];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('when someone loses access', () => {
  beforeEach(async () => {
    await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one! });
    await subscribe('one');
    sent = [];
  });
  const access = () => env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = 'mem_one'`).first<{ n: number }>();
  const changed = () => ({ v: 1, type: 'notification.unregister', id: 'job_x', idempotencyKey: 'k', workspaceId: W, occurredAt: new Date().toISOString(), payload: { memberId: 'mem_one' } }) as unknown as Job;

  it('removes the devices of someone suspended, here and at the relay', async () => {
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_one'`).run();
    queued = [changed()];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect((await access())!.n).toBe(0);
    expect(sent).toMatchObject([{ path: '/v1/devices/unregister', body: { workspaceId: W, recipientId: 'mem_one' } }]);
  });

  it('does the same when every session is gone', async () => {
    await env.DB.prepare(`UPDATE auth_sessions SET revoked_at = 1 WHERE user_id = 'user_one'`).run();
    queued = [changed()];
    await runQueue();
    expect((await access())!.n).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('leaves alone someone who still has access', async () => {
    queued = [changed()];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect((await access())!.n).toBe(1);
    expect(sent).toEqual([]);
  });

  it('retries while the relay is down, with the local rows already gone', async () => {
    relayAnswer = () => new Response('{}', { status: 503 });
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_one'`).run();
    queued = [changed()];
    expect((await runQueue())[0]!.acked).toBe(false);
    expect((await access())!.n).toBe(0);
  });

  it('does not call a relay that never heard of this installation', async () => {
    await env.DB.prepare(`UPDATE installation SET relay_registered_id = NULL`).run();
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_one'`).run();
    queued = [changed()];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect(sent).toEqual([]);
  });

  it('is queued by the change itself', async () => {
    await env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at) VALUES ('obx_x', ?1, 'member.access_changed', 'mem_one', '{}', 1)`).bind(W).run();
    queued = [];
    await sweepOutbox(withRelay, Date.now());
    expect(queued).toMatchObject([{ type: 'notification.unregister', payload: { memberId: 'mem_one' } }]);
  });
});

describe('an admin disconnecting from the relay', () => {
  beforeEach(async () => {
    await env.DB.prepare(`UPDATE users SET is_installation_admin = 1 WHERE id = 'user_two'`).run();
  });
  const status = async (name = 'two', options: { env?: Env } = {}) => call('GET', '/api/v1/admin/push', { token: tokens[name]!, ...options });
  const disconnect = (name = 'two') => call('POST', '/api/v1/admin/push/disconnect', { token: tokens[name]! });
  const reconnect = (name = 'two') => call('POST', '/api/v1/admin/push/reconnect', { token: tokens[name]! });
  const grantFor = (name: string) => call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens[name]! });
  const subscriptionCount = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>())!.n;

  it('shows the relay, whether it accepted this installation, and how many phones', async () => {
    expect(await (await status()).json()).toEqual({ state: 'connected', relay: { id: 'managed', url: RELAY }, registered: false, subscriptions: 0 });
    await grantFor('one');
    await subscribe('one');
    expect(await (await status()).json()).toMatchObject({ registered: true, subscriptions: 1 });
    expect(await (await status('two', { env: withoutRelay })).json()).toMatchObject({ state: 'not_configured', relay: null, registered: false });
  });

  it('asks the relay to erase everything, deletes the handles here, and turns push off', async () => {
    await grantFor('one');
    await subscribe('one');
    sent = [];
    const response = await disconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'disconnected', relay: { id: 'managed', url: RELAY }, registered: false, subscriptions: 0 });
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/unregister']);
    expect(sent[0]!.body).toEqual({});
    expect(sent[0]!.headers.get('x-workspace-id')).toBeNull();
    expect(await subscriptionCount()).toBe(0);
    const audit = await env.DB.prepare(`SELECT action, actor_id AS actorId, target_id AS targetId FROM audit_log WHERE action = 'relay.disconnected'`).first();
    expect(audit).toEqual({ action: 'relay.disconnected', actorId: 'user_two', targetId: 'managed' });
  });

  it('then registers nothing: no grant, no handle, no relay in discovery, and queued pushes are dropped', async () => {
    await subscribe('one');
    await visitorStarts();
    expect((await disconnect()).status).toBe(200);
    sent = [];
    const grant = await grantFor('one');
    expect(grant.status).toBe(409);
    expect(((await grant.json()) as { code: string }).code).toBe('push_not_configured');
    expect((await call('POST', `/api/v1/workspaces/${W}/push/subscriptions`, { token: tokens.one!, body: { relaySubscriptionId: 'sub_again', previewKey: await newPreviewKey('sub_again') } })).status).toBe(409);
    expect(((await (await call('GET', '/.well-known/openchat.json')).json()) as { relay: unknown }).relay).toBeNull();
    // A dispatch job queued before the disconnect.
    queued.push({ type: 'notification.dispatch', idempotencyKey: 'old', workspaceId: W, payload: { notifications: [{ workspaceId: W, event: 'new_message', recipientId: 'mem_one', conversationId: CONV, notificationId: 'ntf_old' }] } });
    const outcomes = await runQueue();
    expect(outcomes.every((o) => o.acked)).toBe(true);
    expect(sent).toEqual([]);
  });

  it('is still off when the relay cannot be reached, and repeating it finishes the erasure', async () => {
    await subscribe('one');
    relayAnswer = () => new Response('{}', { status: 500 });
    const first = await disconnect();
    expect(first.status).toBe(503);
    expect(((await first.json()) as { code: string }).code).toBe('relay_unavailable');
    expect(await (await status()).json()).toMatchObject({ state: 'disconnected', subscriptions: 0 });
    expect((await grantFor('one')).status).toBe(409);
    relayAnswer = () => new Response(null, { status: 204 });
    expect((await disconnect()).status).toBe(200);
  });

  it('treats a relay that no longer knows the installation as erased', async () => {
    relayAnswer = () => new Response('{"code":"unauthorized"}', { status: 401 });
    expect((await disconnect()).status).toBe(200);
  });

  it('reconnects: phones register the installation again on their next grant', async () => {
    await grantFor('one');
    await disconnect();
    sent = [];
    const response = await reconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'connected', registered: false });
    expect((await grantFor('one')).status).toBe(201);
    expect(sent.map((s) => s.path)).toEqual(['/v1/installations/register', '/v1/workspaces/register']);
  });

  it('applies only to that relay: moving to another one turns push on again', async () => {
    await disconnect();
    const response = await call('POST', `/api/v1/workspaces/${W}/push/grants`, { token: tokens.one!, env: { ...withRelay, RELAY_ID: 'other' } });
    expect(response.status).toBe(201);
  });

  it('is 404 for someone who is not an installation admin, and changes nothing', async () => {
    await subscribe('one');
    sent = [];
    for (const response of [await status('one'), await disconnect('one'), await reconnect('one')]) expect(response.status).toBe(404);
    expect(sent).toEqual([]);
    expect(await subscriptionCount()).toBe(1);
  });

  it('is refused with no relay configured', async () => {
    const response = await call('POST', '/api/v1/admin/push/disconnect', { token: tokens.two!, env: withoutRelay });
    expect(response.status).toBe(409);
  });
});
