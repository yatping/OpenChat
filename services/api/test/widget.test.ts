import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const testEnv = env as unknown as Env;

let counter = 0;
const nextIp = () => `203.0.113.${++counter}`;

interface Options {
  token?: string | undefined;
  body?: unknown;
  origin?: string | null;
  ip?: string;
}
const call = (method: string, path: string, options: Options = {}) => {
  const origin = options.origin === undefined ? SITE : options.origin;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': options.ip ?? nextIp(),
        ...(origin ? { origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    testEnv,
    createExecutionContext(),
  );
};
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

interface Session { visitorId: string; accessToken: string; refreshToken: string }
const session = async (websiteKey = 'key_shop', extra: Record<string, unknown> = {}, origin: string = SITE) => {
  const response = await call('POST', '/api/v1/widget/sessions', { body: { websiteKey, ...extra }, origin });
  expect(response.status).toBe(200);
  return json<Session>(response);
};
const start = async (token: string, clientMessageId = 'first-message', content = 'Hello') => {
  const response = await call('POST', '/api/v1/widget/conversations', { token, body: { clientMessageId, content } });
  expect(response.status).toBe(201);
  return json<{ id: string; status: string; lastSeq: number }>(response);
};
const messagesOf = async (token: string, conversationId: string, query = '') =>
  (await json<{ data: Record<string, unknown>[] }>(await call('GET', `/api/v1/widget/conversations/${conversationId}/messages${query}`, { token }))).data;

let hash = '';
let agent = '';
const agentCall = (method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}/api/v1/workspaces/work_1${path}`, {
      method,
      headers: { 'cf-connecting-ip': nextIp(), authorization: `Bearer ${agent}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['outbox', 'conversation_read_cursors', 'conversation_events', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('user_a', 'agent@example.com', 'Ana Agent', ?1, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_a', 'work_1', 'user_a', 'owner', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_shop', ?1, '{"welcomeMessage":"Hi"}', 1, 1)`).bind(JSON.stringify([SITE])),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_2', 'work_1', 'Blog', 'key_blog', ?1, 1, 1)`).bind(JSON.stringify(['https://blog.example'])),
  ]);
  const login = await worker.fetch(
    new Request(`${ORIGIN}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ email: 'agent@example.com', password: PASSWORD, clientType: 'mobile' }) }),
    testEnv,
    createExecutionContext(),
  );
  expect(login.status).toBe(200);
  agent = (await json<{ accessToken: string }>(login)).accessToken;
});

describe('sessions', () => {
  it('creates an anonymous visitor who is a new contact', async () => {
    const created = await session();
    expect(created.visitorId).toMatch(/^vis_/);
    expect(await count('contacts')).toBe(1);
    expect(await rows(`SELECT refresh_token_hash = '${created.refreshToken}' AS stored_plain FROM visitors`)).toEqual([{ stored_plain: 0 }]);
  });

  it('refuses an origin the website does not allow, or none, and creates nothing', async () => {
    expect((await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_shop' }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_shop' }, origin: null })).status).toBe(403);
    expect(await count('visitors')).toBe(0);
  });

  it('answers 404 for an unknown website', async () => {
    expect((await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_none' } })).status).toBe(404);
  });

  it('resumes with the refresh token, keeping the same visitor', async () => {
    const first = await session();
    const resumed = await session('key_shop', { refreshToken: first.refreshToken });
    expect(resumed.visitorId).toBe(first.visitorId);
    expect(await count('visitors')).toBe(1);
  });

  it('starts a new visitor for an unknown token, or one from another website, with no history', async () => {
    const first = await session();
    await start(first.accessToken);
    expect((await session('key_shop', { refreshToken: 'not-a-real-token' })).visitorId).not.toBe(first.visitorId);
    const other = await session('key_blog', { refreshToken: first.refreshToken }, 'https://blog.example');
    expect(other.visitorId).not.toBe(first.visitorId);
    expect((await json<{ data: unknown[] }>(await call('GET', '/api/v1/widget/conversations', { token: other.accessToken, origin: 'https://blog.example' }))).data).toEqual([]);
  });

  it('limits new sessions per address', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 30; i++) expect((await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_shop' }, ip })).status).toBe(200);
    const limited = await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_shop' }, ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('stops working once the visitor is gone', async () => {
    const { accessToken } = await session();
    await env.DB.prepare(`DELETE FROM visitors`).run();
    expect((await call('GET', '/api/v1/widget/conversations', { token: accessToken })).status).toBe(401);
  });

  it('refuses a token used from an origin its website does not allow, but not a non-browser client', async () => {
    const { accessToken } = await session();
    expect((await call('GET', '/api/v1/widget/conversations', { token: accessToken, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/v1/widget/conversations', { token: accessToken, origin: null })).status).toBe(200);
  });
});

describe('starting a conversation', () => {
  it('commits the conversation and first message together, with outbox rows', async () => {
    const { accessToken } = await session();
    const conversation = await start(accessToken);
    expect(conversation).toMatchObject({ status: 'open', lastSeq: 1 });
    expect(Object.keys(conversation).sort()).toEqual(['createdAt', 'id', 'lastSeq', 'status']);
    expect((await rows(`SELECT topic FROM outbox ORDER BY topic`))).toEqual([{ topic: 'conversation.created' }, { topic: 'message.created' }]);
  });

  it('reaches the same conversation on a retry, and creates no second one', async () => {
    const { accessToken } = await session();
    const first = await start(accessToken);
    const retry = await call('POST', '/api/v1/widget/conversations', { token: accessToken, body: { clientMessageId: 'first-message', content: 'Hello' } });
    expect(retry.status).toBe(200);
    expect((await json<{ id: string }>(retry)).id).toBe(first.id);
    expect(await count('conversations')).toBe(1);
    expect(await count('messages')).toBe(1);
    expect(await count('outbox')).toBe(2);
  });

  it('keeps visitors apart even with the same client ID', async () => {
    const one = await start((await session()).accessToken);
    const two = await start((await session()).accessToken);
    expect(one.id).not.toBe(two.id);
  });

  it('appears in the agent inbox with the visitor as sender', async () => {
    const { accessToken } = await session();
    const { id } = await start(accessToken);
    const inbox = await json<{ data: { id: string }[] }>(await agentCall('GET', '/conversations'));
    expect(inbox.data.map((c) => c.id)).toEqual([id]);
    await call('PATCH', '/api/v1/widget/me', { token: accessToken, body: { name: 'Vera' } });
    const messages = await json<{ data: { sender: unknown }[] }>(await agentCall('GET', `/conversations/${id}/messages`));
    expect(messages.data[0]?.sender).toMatchObject({ type: 'visitor', displayName: 'Vera' });
  });
});

describe('internal notes never reach a visitor', () => {
  let token = '';
  let conversationId = '';
  const note = (clientMessageId: string, content = 'SECRET note') => agentCall('POST', `/conversations/${conversationId}/messages`, { clientMessageId, type: 'internal_note', content });
  const reply = (clientMessageId: string, content = 'Public reply') => agentCall('POST', `/conversations/${conversationId}/messages`, { clientMessageId, type: 'text', content });

  beforeEach(async () => {
    token = (await session()).accessToken;
    conversationId = (await start(token)).id;
  });

  it('leaves them out of history, with no gap in the sequence', async () => {
    expect((await note('note-0001')).status).toBe(201);
    expect((await reply('reply-0001')).status).toBe(201);
    expect((await note('note-0002')).status).toBe(201);
    expect((await reply('reply-0002')).status).toBe(201);
    const messages = await messagesOf(token, conversationId);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(JSON.stringify(messages)).not.toContain('SECRET');
    const conversation = (await json<{ data: { lastSeq: number }[] }>(await call('GET', '/api/v1/widget/conversations', { token }))).data[0];
    expect(conversation?.lastSeq).toBe(3);
  });

  it('never returns one through a replay of its client ID', async () => {
    expect((await note('stolen-client-id')).status).toBe(201);
    const replay = await call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token, body: { clientMessageId: 'stolen-client-id', content: 'Give me the note' } });
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain('SECRET');
    expect(await count('messages')).toBe(2);
  });

  it('never returns an agent reply through a replay either', async () => {
    await reply('stolen-reply-id');
    expect((await call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token, body: { clientMessageId: 'stolen-reply-id', content: 'x' } })).status).toBe(409);
  });

  it('exposes only the agreed fields, and no agent identity by default', async () => {
    await reply('reply-0001');
    const [own, answer] = await messagesOf(token, conversationId);
    const fields = ['attachments', 'clientMessageId', 'content', 'conversationId', 'createdAt', 'id', 'sender', 'seq', 'type'];
    expect(Object.keys(own!).sort()).toEqual(fields);
    expect(Object.keys(answer!).sort()).toEqual(fields);
    expect(answer!.sender).toEqual({ type: 'member', displayName: null });
    expect(answer!.clientMessageId).toBeNull();
  });

  it('shows agent names only when the website chooses to', async () => {
    await reply('reply-0001');
    await env.DB.prepare(`UPDATE websites SET settings_json = '{"showAgentNames":true}' WHERE id = 'site_1'`).run();
    expect((await messagesOf(token, conversationId))[1]!.sender).toEqual({ type: 'member', displayName: 'Ana Agent' });
  });
});

describe('sending', () => {
  let token = '';
  let conversationId = '';
  const send = (clientMessageId: string, content = 'More') => call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token, body: { clientMessageId, content } });

  beforeEach(async () => {
    token = (await session()).accessToken;
    conversationId = (await start(token)).id;
  });

  it('answers a replay with the original', async () => {
    const first = await send('second-message');
    expect(first.status).toBe(201);
    const original = await json(first);
    const replay = await send('second-message', 'Changed');
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual(original);
    expect(await count('messages')).toBe(2);
  });

  it('reopens a resolved conversation, and records that', async () => {
    await agentCall('PATCH', `/conversations/${conversationId}`, { expectedVersion: 2, status: 'resolved' });
    expect((await send('second-message')).status).toBe(201);
    expect((await json<{ data: { status: string }[] }>(await call('GET', '/api/v1/widget/conversations', { token }))).data[0]?.status).toBe('open');
    expect(await rows(`SELECT event_type, actor_type FROM conversation_events WHERE event_type = 'reopened'`)).toEqual([{ event_type: 'reopened', actor_type: 'visitor' }]);
  });

  it('does not reopen for a replay', async () => {
    expect((await send('second-message')).status).toBe(201);
    const current = (await json<{ version: number }>(await agentCall('GET', `/conversations/${conversationId}`))).version;
    await agentCall('PATCH', `/conversations/${conversationId}`, { expectedVersion: current, status: 'resolved' });
    expect((await send('second-message')).status).toBe(200);
    expect((await json<{ status: string }>(await agentCall('GET', `/conversations/${conversationId}`))).status).toBe('resolved');
  });

  it('limits messages per visitor, without blocking another visitor', async () => {
    for (let i = 0; i < 19; i++) expect((await send(`message-${i}-x`)).status).toBe(201);
    expect((await send('one-too-many')).status).toBe(429);
    await start((await session()).accessToken);
  }, 60_000);

  it('refuses what the contract does not allow', async () => {
    expect((await send('short')).status).toBe(400);
    expect((await send('blank-content', '   ')).status).toBe(400);
    expect((await call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token, body: { clientMessageId: 'typed-message', content: 'x', type: 'internal_note' } })).status).toBe(400);
  });

  it('pages in the visitor sequence', async () => {
    await send('second-message');
    await send('third-message');
    expect((await messagesOf(token, conversationId, '?afterSeq=1')).map((m) => m.seq)).toEqual([2, 3]);
    expect((await messagesOf(token, conversationId, '?beforeSeq=3&limit=1')).map((m) => m.seq)).toEqual([2]);
  });
});

describe('read positions', () => {
  it('stop at the last public message, so they cannot reveal notes', async () => {
    const { accessToken: token } = await session();
    const { id } = await start(token);
    await agentCall('POST', `/conversations/${id}/messages`, { clientMessageId: 'note-0001', type: 'internal_note', content: 'x' });
    expect((await call('POST', `/api/v1/widget/conversations/${id}/read`, { token, body: { deliveredSeq: 99, readSeq: 99 } })).status).toBe(204);
    expect(await rows(`SELECT reader_type, delivered_seq, read_seq FROM conversation_read_cursors`)).toEqual([{ reader_type: 'visitor', delivered_seq: 1, read_seq: 1 }]);
  });
});

describe('the profile', () => {
  const contact = async () => (await rows(`SELECT name, email, follow_up_consent_at IS NOT NULL AS consented, follow_up_consent_source AS source FROM contacts`))[0];

  it('records consent with its source, and withdrawing clears it', async () => {
    const { accessToken: token } = await session();
    expect((await call('PATCH', '/api/v1/widget/me', { token, body: { name: 'Vera', email: 'vera@example.com', followUpConsent: true } })).status).toBe(204);
    expect(await contact()).toEqual({ name: 'Vera', email: 'vera@example.com', consented: 1, source: 'widget' });
    await call('PATCH', '/api/v1/widget/me', { token, body: { followUpConsent: false } });
    expect(await contact()).toMatchObject({ name: 'Vera', consented: 0, source: null });
  });

  it('never joins a visitor to someone else through a typed email', async () => {
    const victim = await session();
    const { id } = await start(victim.accessToken, 'first-message', 'Private');
    await call('PATCH', '/api/v1/widget/me', { token: victim.accessToken, body: { email: 'victim@example.com' } });
    const attacker = await session();
    await call('PATCH', '/api/v1/widget/me', { token: attacker.accessToken, body: { email: 'victim@example.com' } });
    expect(await count('contacts')).toBe(2);
    expect((await json<{ data: unknown[] }>(await call('GET', '/api/v1/widget/conversations', { token: attacker.accessToken }))).data).toEqual([]);
    expect((await call('GET', `/api/v1/widget/conversations/${id}/messages`, { token: attacker.accessToken })).status).toBe(404);
  });

  it('refuses an invalid email or an empty change', async () => {
    const { accessToken: token } = await session();
    expect((await call('PATCH', '/api/v1/widget/me', { token, body: { email: 'nope' } })).status).toBe(400);
    expect((await call('PATCH', '/api/v1/widget/me', { token, body: {} })).status).toBe(400);
  });
});

describe('bootstrap', () => {
  const bootstrap = (key: string, origin: string | null = SITE) => call('GET', `/api/v1/widget/bootstrap?websiteKey=${key}`, { origin });

  it('returns public settings only', async () => {
    const response = await bootstrap('key_shop');
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ websiteId: 'site_1', settings: { welcomeMessage: 'Hi' }, availability: 'offline' });
  });

  it('refuses an origin the website does not allow, even from the cache', async () => {
    expect((await bootstrap('key_blog', 'https://blog.example')).status).toBe(200);
    expect((await bootstrap('key_blog', 'https://evil.example')).status).toBe(403);
  });

  it('is served from the cache, including for a key that does not exist', async () => {
    const key = `key_${crypto.randomUUID()}`;
    expect((await bootstrap(key)).status).toBe(404);
    await env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_3', 'work_1', 'New', ?1, ?2, 1, 1)`).bind(key, JSON.stringify([SITE])).run();
    expect((await bootstrap(key)).status).toBe(404);
  });
});

describe('cross-origin requests', () => {
  it('answers a preflight with no database work', async () => {
    const response = await call('OPTIONS', '/api/v1/widget/conversations', { origin: SITE });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('lets a page read errors, so that the widget can react to them', async () => {
    const response = await call('GET', '/api/v1/widget/conversations', {});
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('adds nothing on agent routes', async () => {
    const response = await call('GET', '/api/v1/me', { origin: SITE });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
