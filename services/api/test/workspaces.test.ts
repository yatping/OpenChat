import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

const testEnv = env;
const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

let counter = 0;
const ip = () => `198.51.100.${++counter % 250}-${counter}`;

const call = (method: string, path: string, token?: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': ip(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await call('POST', '/api/v1/auth/login', undefined, { email, password, clientType: 'mobile' });
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

const tokens: Record<string, string> = {};
const W1 = '/api/v1/workspaces/work_1';
const W2 = '/api/v1/workspaces/work_2';

beforeEach(async () => {
  await env.DB.batch(['audit_log', 'websites', 'workspace_members', 'auth_sessions', 'auth_tokens', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const users = ['supervisor', 'agent', 'teammate', 'outsider'];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 2, 2)`),
    ...users.map((u) => env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${u}`, `${u}@example.com`, u, hash)),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
       ('mem_supervisor', 'work_1', 'user_supervisor', 'supervisor', 'active', 1, 1), ('mem_agent', 'work_1', 'user_agent', 'agent', 'active', 1, 1),
       ('mem_teammate', 'work_1', 'user_teammate', 'agent', 'active', 1, 1), ('mem_outsider', 'work_2', 'user_outsider', 'supervisor', 'active', 1, 1)`,
    ),
  ]);
  for (const u of users) tokens[u] = await signIn(`${u}@example.com`);
});

describe('access', () => {
  it('requires a token on every workspace route', async () => {
    for (const [method, path] of [['GET', W1], ['GET', `${W1}/members`], ['GET', `${W1}/websites`]] as const) {
      expect((await call(method, path)).status).toBe(401);
    }
  });

  it('answers a non-member exactly as for a workspace that does not exist', async () => {
    const other = await call('GET', W1, tokens.outsider);
    const missing = await call('GET', '/api/v1/workspaces/work_missing', tokens.outsider);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = async (r: Response) => {
      const body = (await r.json()) as Record<string, unknown>;
      delete body.requestId;
      return body;
    };
    expect(await strip(other)).toEqual(await strip(missing));
  });

  it('stops a suspended member at once', async () => {
    expect((await call('GET', W1, tokens.agent)).status).toBe(200);
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_agent'`).run();
    expect((await call('GET', W1, tokens.agent)).status).toBe(404);
  });
});

describe('workspaces', () => {
  it('shows a member their workspace, and has no way to change it from inside', async () => {
    expect(await (await call('GET', W1, tokens.agent)).json()).toMatchObject({ id: 'work_1', name: 'One' });
    expect((await call('PATCH', W1, tokens.supervisor, { name: 'x' })).status).toBe(404);
  });
});

describe('members', () => {
  it('lists this workspace only, with pagination', async () => {
    const first = (await (await call('GET', `${W1}/members?limit=2`, tokens.agent)).json()) as { data: { id: string }[]; nextCursor: string };
    expect(first.data).toHaveLength(2);
    const second = (await (await call('GET', `${W1}/members?limit=2&cursor=${first.nextCursor}`, tokens.agent)).json()) as { data: { id: string }[]; nextCursor: null };
    expect(second.nextCursor).toBeNull();
    const ids = [...first.data, ...second.data].map((m) => m.id).sort();
    expect(ids).toEqual(['mem_agent', 'mem_supervisor', 'mem_teammate']);
  });
});

describe('websites', () => {
  it('lists them to any member, and to nobody else', async () => {
    await env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_1', 'work_1', 'Main', 'key_1', '["https://example.org"]', 1, 1)`).run();
    const list = (await (await call('GET', `${W1}/websites`, tokens.agent)).json()) as { data: { id: string; allowedOrigins: string[] }[] };
    expect(list.data).toEqual([expect.objectContaining({ id: 'site_1', allowedOrigins: ['https://example.org'] })]);
    expect((await call('GET', `${W1}/websites`, tokens.outsider)).status).toBe(404);
    expect(((await (await call('GET', `${W2}/websites`, tokens.outsider)).json()) as { data: unknown[] }).data).toEqual([]);
  });
});
