import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';
const W = '/api/v1/workspaces/work_1';
const C = `${W}/conversations/conv_1`;
const testEnv = env as unknown as Env;

let counter = 0;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `203.0.113.${++counter}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

let hash = '';
const tokens: Record<string, string> = {};

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['outbox', 'conversation_read_cursors', 'conversation_events', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1)`),
    ...['owner', 'agent', 'other'].flatMap((u) => [
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${u}`, `${u}@example.com`, `The ${u}`, hash),
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, 'work_1', ?2, ?3, 'active', 1, 1)`).bind(`mem_${u}`, `user_${u}`, u === 'owner' ? 'owner' : 'agent'),
    ]),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('site_1', 'work_1', 'Site', 'key_1', 1, 1)`),
    env.DB.prepare(`INSERT INTO contacts (id, workspace_id, name, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('cont_1', 'work_1', 'Vera', 1, 1, 1, 1)`),
    env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at) VALUES ('conv_1', 'work_1', 'site_1', 'cont_1', 100, 1, 1)`),
  ]);
  for (const u of ['owner', 'agent', 'other']) {
    const response = await call('POST', '/api/v1/auth/login', undefined, { email: `${u}@example.com`, password: PASSWORD, clientType: 'mobile' });
    expect(response.status).toBe(200);
    tokens[u] = (await json<{ accessToken: string }>(response)).accessToken;
  }
});

const send = (body: Record<string, unknown>, token = tokens.agent) => call('POST', `${C}/messages`, token, { type: 'text', content: 'Hello', ...body });

describe('sending', () => {
  it('commits a reply with its outbox row, and names the sender', async () => {
    const response = await send({ clientMessageId: 'client-0001' });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ seq: 1, publicSeq: 1, visibility: 'public', type: 'text', sender: { type: 'member', id: 'mem_agent', displayName: 'The agent' }, attachments: [] });
    expect(await count('outbox')).toBe(1);
    const conversation = await json(await call('GET', C, tokens.agent));
    expect(conversation).toMatchObject({ lastMessageSeq: 1, version: 2 });
  });

  it('answers a replay with the original and 200, and writes nothing', async () => {
    const first = await json(await send({ clientMessageId: 'client-0001' }));
    const replay = await send({ clientMessageId: 'client-0001', content: 'Different' });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual(first);
    expect(await count('messages')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });

  it('gives a note no public sequence, so that a visitor cannot count notes', async () => {
    await send({ clientMessageId: 'client-0001' });
    expect(await json(await send({ clientMessageId: 'client-0002', type: 'internal_note' }))).toMatchObject({ seq: 2, publicSeq: null, visibility: 'internal' });
    expect(await json(await send({ clientMessageId: 'client-0003' }))).toMatchObject({ seq: 3, publicSeq: 2 });
  });

  it('refuses what the contract does not allow', async () => {
    expect((await send({ clientMessageId: 'short' })).status).toBe(400);
    expect((await send({ clientMessageId: 'client-0001', content: '   ' })).status).toBe(400);
    expect((await send({ clientMessageId: 'client-0001', content: 'x'.repeat(16001) })).status).toBe(400);
    expect((await send({ clientMessageId: 'client-0001', type: 'system' })).status).toBe(400);
    expect((await send({ clientMessageId: 'client-0001', visibility: 'public' })).status).toBe(400);
    expect(await count('messages')).toBe(0);
  });
});

describe('reading messages', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) await send({ clientMessageId: `client-000${i}` });
  });
  const seqs = async (query: string) => (await json<{ data: { seq: number }[] }>(await call('GET', `${C}/messages${query}`, tokens.agent))).data.map((m) => m.seq);

  it('goes forward for catch-up and backward for history, always oldest first', async () => {
    expect(await seqs('?afterSeq=3')).toEqual([4, 5]);
    expect(await seqs('?beforeSeq=4&limit=2')).toEqual([2, 3]);
    expect(await seqs('')).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses both directions at once', async () => {
    expect((await call('GET', `${C}/messages?afterSeq=1&beforeSeq=3`, tokens.agent)).status).toBe(400);
  });

  it('answers 404 for a conversation that does not exist', async () => {
    expect((await call('GET', `${W}/conversations/conv_none/messages`, tokens.agent)).status).toBe(404);
  });
});

describe('updating', () => {
  const patch = (body: Record<string, unknown>, token = tokens.agent) => call('PATCH', C, token, { expectedVersion: 1, ...body });

  it('changes status and priority, with one event each and one outbox row', async () => {
    const response = await patch({ status: 'resolved', priority: 'high' });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status: 'resolved', priority: 'high', version: 2 });
    expect((await env.DB.prepare(`SELECT event_type FROM conversation_events ORDER BY event_type`).all()).results).toEqual([{ event_type: 'priority_changed' }, { event_type: 'status_changed' }]);
    expect(await count('outbox')).toBe(1);
  });

  it('answers a stale version with 409 and the current one, and writes no event', async () => {
    await patch({ status: 'pending' });
    const stale = await patch({ status: 'resolved' });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'version_conflict', details: { currentVersion: 2 } });
    expect(await count('conversation_events')).toBe(1);
  });

  it('applies the assignment rules for an agent', async () => {
    expect((await patch({ assignedMemberId: 'mem_other' })).status).toBe(403);
    expect((await patch({ assignedMemberId: 'mem_agent' })).status).toBe(200);
    expect((await patch({ expectedVersion: 2, assignedMemberId: 'mem_other' }, tokens.other)).status).toBe(403);
    expect((await patch({ expectedVersion: 2, assignedMemberId: 'mem_other' })).status).toBe(200);
  });

  it('lets a lead assign anyone, but only to an active member', async () => {
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_other'`).run();
    const suspended = await patch({ assignedMemberId: 'mem_other' }, tokens.owner);
    expect(suspended.status).toBe(400);
    expect(await json(suspended)).toMatchObject({ code: 'invalid_assignee' });
    expect((await patch({ assignedMemberId: 'mem_none' }, tokens.owner)).status).toBe(400);
    expect((await patch({ assignedMemberId: 'mem_agent' }, tokens.owner)).status).toBe(200);
    expect(await json(await patch({ expectedVersion: 2, assignedMemberId: null }, tokens.owner))).toMatchObject({ assignedMemberId: null, version: 3 });
  });

  it('refuses an empty change', async () => {
    expect((await patch({})).status).toBe(400);
  });
});

describe('the inbox', () => {
  beforeEach(async () => {
    await env.DB.batch(
      [2, 3, 4, 5].map((n) =>
        env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, assigned_member_id, last_message_at, created_at, updated_at) VALUES (?1, 'work_1', 'site_1', 'cont_1', ?2, ?3, 1, 1)`).bind(`conv_${n}`, n % 2 ? 'mem_agent' : null, n * 100),
      ),
    );
  });
  type Page = { data: { id: string }[]; nextCursor: string | null };
  const list = async (query = '') => json<Page>(await call('GET', `${W}/conversations${query}`, tokens.agent));
  const ids = (page: Page) => page.data.map((c) => c.id);

  it('pages through newest first with no gaps or repeats', async () => {
    const first = await list('?limit=2');
    expect(ids(first)).toEqual(['conv_5', 'conv_4']);
    const second = await list(`?limit=2&cursor=${first.nextCursor}`);
    expect(ids(second)).toEqual(['conv_3', 'conv_2']);
    const third = await list(`?limit=2&cursor=${second.nextCursor}`);
    expect(ids(third)).toEqual(['conv_1']);
    expect(third.nextCursor).toBeNull();
  });

  it('filters by assignee and status', async () => {
    expect(ids(await list('?assignee=me'))).toEqual(['conv_5', 'conv_3']);
    expect(ids(await list('?assignee=none'))).toEqual(['conv_4', 'conv_2', 'conv_1']);
    expect(ids(await list('?assignee=mem_agent&limit=1'))).toEqual(['conv_5']);
    expect(ids(await list('?status=resolved'))).toEqual([]);
  });

  it('refuses a cursor from other filters, or one that is not a cursor', async () => {
    const { nextCursor } = await list('?limit=1');
    expect((await call('GET', `${W}/conversations?assignee=me&cursor=${nextCursor}`, tokens.agent)).status).toBe(400);
    expect((await call('GET', `${W}/conversations?cursor=not-a-cursor`, tokens.agent)).status).toBe(400);
  });
});

describe('read positions', () => {
  const read = (deliveredSeq: number, readSeq: number, token = tokens.agent) => call('POST', `${C}/read`, token, { deliveredSeq, readSeq });
  const lastRead = async (token = tokens.agent) => (await json<{ lastReadSeq: number }>(await call('GET', C, token))).lastReadSeq;

  beforeEach(async () => {
    for (let i = 1; i <= 3; i++) await send({ clientMessageId: `client-000${i}` });
  });

  it('moves forward only, and belongs to the reader', async () => {
    expect((await read(2, 2)).status).toBe(204);
    expect(await lastRead()).toBe(2);
    await read(1, 1);
    expect(await lastRead()).toBe(2);
    expect(await lastRead(tokens.other)).toBe(0);
  });

  it('stops at the last message, so that a wrong client cannot hide new ones', async () => {
    await read(999, 999);
    expect(await lastRead()).toBe(3);
  });

  it('answers 404 for a conversation that does not exist', async () => {
    expect((await call('POST', `${W}/conversations/conv_none/read`, tokens.agent, { deliveredSeq: 0, readSeq: 0 })).status).toBe(404);
  });
});
