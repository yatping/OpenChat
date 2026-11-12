import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';
const LOG = '/api/v1/admin/audit-log';
const testEnv = env as unknown as Env;

let counter = 0;
const request = (method: string, path: string, token?: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `198.51.100.${++counter % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

interface Entry {
  id: string;
  createdAt: string;
  action: string;
  actor: { type: string; id: string | null; name: string | null };
  workspace: { id: string; name: string } | null;
  target: { type: string; id: string; name: string | null } | null;
  metadata: Record<string, unknown>;
}

const tokens: Record<string, string> = {};
let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['audit_log', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const audit = (id: string, at: number, workspace: string | null, actorType: string, actor: string | null, action: string, targetType: string | null, target: string | null, metadata: string) =>
    env.DB.prepare(`INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(
      id,
      workspace,
      actorType,
      actor,
      action,
      targetType,
      target,
      metadata,
      at,
    );
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES ('user_boss', 'boss@example.com', 'Boss', ?1, 1, 1, 1), ('user_ann', 'ann@example.com', 'Ann Agent', ?1, 0, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_ann', 'work_1', 'user_ann', 'supervisor', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_1', 1, 1)`),
    audit('aud_1', 1000, null, 'user', 'user_boss', 'person.created', 'user', 'user_ann', '{}'),
    audit('aud_2', 2000, 'work_1', 'user', 'user_boss', 'person.assigned', 'user', 'user_ann', '{"role":"supervisor"}'),
    audit('aud_3', 3000, 'work_1', 'user', 'user_boss', 'website.created', 'website', 'site_1', '{}'),
    audit('aud_4', 4000, 'work_1', 'user', 'user_boss', 'contact.erased', 'contact', 'cont_gone', '{}'),
    audit('aud_5', 5000, 'work_1', 'system', null, 'conversations.expired', 'workspace', 'work_1', '{"conversations":3,"retentionDays":30}'),
    audit('aud_6', 6000, 'work_2', 'user', 'user_boss', 'person.unassigned', 'member', 'mem_ann', '{"nested":{"x":1},"kept":true}'),
  ]);
  for (const who of ['boss', 'ann']) {
    const response = await request('POST', '/api/v1/auth/login', undefined, { email: `${who}@example.com`, password: PASSWORD, clientType: 'mobile' });
    tokens[who] = ((await response.json()) as { accessToken: string }).accessToken;
  }
});

const list = async (query = '') => {
  const response = await request('GET', `${LOG}${query}`, tokens.boss);
  expect(response.status).toBe(200);
  return (await response.json()) as { data: Entry[]; nextCursor: string | null };
};

describe('the audit log', () => {
  it('lists every entry newest first, with names for people, workspaces and websites', async () => {
    const { data, nextCursor } = await list();
    expect(nextCursor).toBeNull();
    expect(data.map((e) => e.id)).toEqual(['aud_6', 'aud_5', 'aud_4', 'aud_3', 'aud_2', 'aud_1']);
    expect(data.find((e) => e.id === 'aud_2')).toEqual({
      id: 'aud_2',
      createdAt: new Date(2000).toISOString(),
      action: 'person.assigned',
      actor: { type: 'user', id: 'user_boss', name: 'Boss' },
      workspace: { id: 'work_1', name: 'One' },
      target: { type: 'user', id: 'user_ann', name: 'Ann Agent' },
      metadata: { role: 'supervisor' },
    });
    expect(data.find((e) => e.id === 'aud_3')?.target).toEqual({ type: 'website', id: 'site_1', name: 'Shop' });
    expect(data.find((e) => e.id === 'aud_6')?.target).toEqual({ type: 'member', id: 'mem_ann', name: 'Ann Agent' });
    expect(data.find((e) => e.id === 'aud_1')?.workspace).toBeNull();
  });

  it('never names a contact, and shows the system as the actor of a sweep', async () => {
    const { data } = await list();
    expect(data.find((e) => e.id === 'aud_4')?.target).toEqual({ type: 'contact', id: 'cont_gone', name: null });
    expect(data.find((e) => e.id === 'aud_5')).toMatchObject({ actor: { type: 'system', id: null, name: null }, metadata: { conversations: 3, retentionDays: 30 } });
  });

  it('shows only flat metadata', async () => {
    expect((await list()).data[0]?.metadata).toEqual({ kept: true });
  });

  it('pages, and filters by workspace', async () => {
    const first = await list('?limit=4');
    expect(first.data.map((e) => e.id)).toEqual(['aud_6', 'aud_5', 'aud_4', 'aud_3']);
    const second = await list(`?limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect([second.data.map((e) => e.id), second.nextCursor]).toEqual([['aud_2', 'aud_1'], null]);

    const one = await list('?workspaceId=work_1&limit=2');
    expect(one.data.map((e) => e.id)).toEqual(['aud_5', 'aud_4']);
    const rest = await list(`?workspaceId=work_1&limit=2&cursor=${encodeURIComponent(one.nextCursor!)}`);
    expect(rest.data.map((e) => e.id)).toEqual(['aud_3', 'aud_2']);
    expect((await list('?workspaceId=work_nope')).data).toEqual([]);
  });

  it('records what an admin does through the API', async () => {
    expect((await request('POST', '/api/v1/admin/workspaces', tokens.boss, { name: 'Three' })).status).toBe(201);
    const [latest] = (await list()).data;
    expect(latest).toMatchObject({ action: 'workspace.created', actor: { name: 'Boss' }, workspace: { name: 'Three' }, target: { type: 'workspace', name: 'Three' } });
  });

  it('is not there for anyone but an installation admin', async () => {
    expect((await request('GET', LOG, tokens.ann)).status).toBe(404);
    expect((await request('GET', `${LOG}?workspaceId=work_1`, tokens.ann)).status).toBe(404);
  });
});
