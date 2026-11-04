import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const PASSWORD = 'correct horse battery';
const W = '/api/v1/workspaces/work_1';
const testEnv = env as unknown as Env;
const C = `${W}/contacts/cont_1`;
const CONV = `${W}/conversations/conv_1`;

let counter = 0;
async function call(method: string, path: string, token: string | null, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${++counter}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

let hash = '';
let owner = '';
let agent = '';
const login = async (email: string) => (await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', null, { email, password: PASSWORD, clientType: 'mobile' }))).accessToken;
const createTag = async (name: string) => json<{ id: string; name: string }>(await call('POST', `${W}/tags`, agent, { name }));
const conversation = async () => json<{ version: number; updatedAt: string; tags: { id: string; name: string }[]; contactName: string | null; contactEmail: string | null }>(await call('GET', CONV, agent));

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['outbox', 'conversation_events', 'conversation_tags', 'tags', 'conversations', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('user_o', 'owner@example.com', 'Owner', ?1, 1, 1), ('user_a', 'agent@example.com', 'Agent', ?1, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_o', 'work_1', 'user_o', 'owner', 'active', 1, 1), ('mem_a', 'work_1', 'user_a', 'agent', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_1', 1, 1)`),
    env.DB.prepare(`INSERT INTO contacts (id, workspace_id, name, email, phone, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('cont_1', 'work_1', 'Ann', 'ann@example.com', '123', 1000, 2000, 1, 1)`),
    env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at) VALUES ('conv_1', 'work_1', 'site_1', 'cont_1', 1, 1, 1)`),
    env.DB.prepare(`INSERT INTO tags (id, workspace_id, name, created_at) VALUES ('tag_foreign', 'work_2', 'theirs', 1)`),
  ]);
  owner = await login('owner@example.com');
  agent = await login('agent@example.com');
});

describe('contacts', () => {
  it('reads, with times as dates, and shows on the conversation', async () => {
    expect(await json(await call('GET', C, agent))).toEqual({ id: 'cont_1', name: 'Ann', email: 'ann@example.com', phone: '123', firstSeenAt: new Date(1000).toISOString(), lastSeenAt: new Date(2000).toISOString() });
    expect(await conversation()).toMatchObject({ contactName: 'Ann', contactEmail: 'ann@example.com', tags: [] });
  });

  it('changes only what is named, and null clears', async () => {
    expect(await json(await call('PATCH', C, agent, { name: 'Anna' }))).toMatchObject({ name: 'Anna', email: 'ann@example.com', phone: '123' });
    expect(await json(await call('PATCH', C, agent, { email: null, phone: '456' }))).toMatchObject({ name: 'Anna', email: null, phone: '456' });
    expect((await conversation()).contactName).toBe('Anna');
  });

  it('refuses nothing to change, a bad email, and control characters', async () => {
    expect((await call('PATCH', C, agent, {})).status).toBe(400);
    expect((await call('PATCH', C, agent, { email: 'not an email' })).status).toBe(400);
    expect((await call('PATCH', C, agent, { name: 'a\u0000b' })).status).toBe(400);
    expect((await call('PATCH', C, agent, { phone: 'a\nb' })).status).toBe(400);
  });

  it('answers 404 for an unknown contact', async () => {
    expect((await call('GET', `${W}/contacts/cont_none`, agent)).status).toBe(404);
    expect((await call('PATCH', `${W}/contacts/cont_none`, agent, { name: 'x' })).status).toBe(404);
  });
});

describe('tags', () => {
  it('creates once, whatever the capitals, and lists by name', async () => {
    const first = await call('POST', `${W}/tags`, agent, { name: 'Refund' });
    expect(first.status).toBe(201);
    const { id } = await json<{ id: string }>(first);
    const again = await call('POST', `${W}/tags`, agent, { name: 'REFUND' });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ id, name: 'Refund' });
    await createTag('Billing');
    expect((await json<{ data: { name: string }[] }>(await call('GET', `${W}/tags`, agent))).data.map((t) => t.name)).toEqual(['Billing', 'Refund']);
  });

  it('stops at the limit, while the existing name still works', async () => {
    await env.DB.batch(Array.from({ length: 500 }, (_, n) => env.DB.prepare(`INSERT INTO tags (id, workspace_id, name, created_at) VALUES (?1, 'work_1', ?2, 1)`).bind(`tag_${n}`, `t${n}`)));
    const refused = await call('POST', `${W}/tags`, agent, { name: 'one too many' });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({ code: 'tag_limit' });
    expect((await call('POST', `${W}/tags`, agent, { name: 't1' })).status).toBe(200);
  });

  it('only managers delete, which takes it off conversations', async () => {
    const tag = await createTag('Refund');
    await call('PUT', `${CONV}/tags`, agent, { tagIds: [tag.id] });
    expect((await call('DELETE', `${W}/tags/${tag.id}`, agent)).status).toBe(403);
    expect((await conversation()).tags).toHaveLength(1);
    expect((await call('DELETE', `${W}/tags/${tag.id}`, owner)).status).toBe(204);
    expect((await conversation()).tags).toEqual([]);
    expect((await call('DELETE', `${W}/tags/${tag.id}`, owner)).status).toBe(404);
  });
});

describe('tags on a conversation', () => {
  it('replaces the set, repeats nothing, and does not move the version', async () => {
    const [a, b] = [await createTag('A'), await createTag('B')];
    const { version } = await conversation();
    expect((await call('PUT', `${CONV}/tags`, agent, { tagIds: [a.id, a.id] })).status).toBe(204);
    expect((await conversation()).tags).toEqual([a]);
    expect((await call('PUT', `${CONV}/tags`, agent, { tagIds: [b.id] })).status).toBe(204);
    const after = await conversation();
    expect(after.tags).toEqual([b]);
    expect(after.version).toBe(version);
    expect((await call('PUT', `${CONV}/tags`, agent, { tagIds: [] })).status).toBe(204);
    expect((await conversation()).tags).toEqual([]);
  });

  it('moves the update time, so that catching up finds it', async () => {
    const before = await conversation();
    await call('PUT', `${CONV}/tags`, agent, { tagIds: [] });
    expect((await conversation()).updatedAt > before.updatedAt).toBe(true);
  });

  it("refuses a tag from another workspace, and leaves everything as it was", async () => {
    const mine = await createTag('Mine');
    await call('PUT', `${CONV}/tags`, agent, { tagIds: [mine.id] });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox`).first<{ n: number }>();
    const refused = await call('PUT', `${CONV}/tags`, agent, { tagIds: ['tag_foreign', mine.id] });
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ code: 'unknown_tag' });
    expect((await conversation()).tags).toEqual([mine]);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox`).first<{ n: number }>()).toEqual(before);
    expect(await env.DB.prepare(`SELECT tag_id FROM conversation_tags WHERE tag_id = 'tag_foreign'`).first()).toBeNull();
  });

  it('answers 404 for an unknown conversation, even with no tags', async () => {
    expect((await call('PUT', `${W}/conversations/conv_none/tags`, agent, { tagIds: [] })).status).toBe(404);
  });

  it('records who changed them, and announces it', async () => {
    const tag = await createTag('Refund');
    await call('PUT', `${CONV}/tags`, agent, { tagIds: [tag.id] });
    const event = await env.DB.prepare(`SELECT actor_id AS actor, metadata_json AS meta FROM conversation_events WHERE event_type = 'tags_changed'`).first<{ actor: string; meta: string }>();
    expect(event?.actor).toBe('mem_a');
    expect(JSON.parse(event!.meta)).toEqual({ tagIds: [tag.id] });
    // Dispatched by then, because this test waits for work after the response.
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE topic = 'conversation.updated' AND dispatched_at IS NOT NULL`).first()).toEqual({ n: 1 });
  });
});
