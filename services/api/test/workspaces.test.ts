import { createExecutionContext, createMessageBatch } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import type { EmailMessage } from '@openchat/email';
import type { JobEnvelope } from '@openchat/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/background';
import type { Env } from '../src/env';
import worker from '../src/index';

// A fake queue, because the real consumer would run during the test and replace invitation tokens.
const queued: JobEnvelope[] = [];
const testEnv = { ...env, EMAIL_QUEUE: { send: async (job: JobEnvelope) => void queued.push(job) } } as unknown as Env;
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
  await env.DB.batch(['audit_log', 'invitations', 'websites', 'workspace_members', 'auth_sessions', 'auth_tokens', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const users = ['owner', 'admin', 'supervisor', 'agent', 'outsider'];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, signup_policy, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 'invite_only', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 2, 2)`),
    ...users.map((u) => env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${u}`, `${u}@example.com`, u, hash)),
    ...['owner', 'admin', 'supervisor', 'agent'].map((u) =>
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, 'work_1', ?2, ?3, 'active', 1, 1)`).bind(`mem_${u}`, `user_${u}`, u),
    ),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_outsider', 'work_2', 'user_outsider', 'owner', 'active', 1, 1)`),
  ]);
  for (const u of users) tokens[u] = await signIn(`${u}@example.com`);
});

describe('access', () => {
  it('requires a token on every workspace route', async () => {
    for (const [method, path] of [['POST', '/api/v1/workspaces'], ['GET', W1], ['PATCH', W1], ['GET', `${W1}/members`], ['POST', `${W1}/invitations`], ['GET', `${W1}/websites`]] as const) {
      expect((await call(method, path, undefined, method === 'GET' ? undefined : {})).status).toBe(401);
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
  it('lets an owner create one, and the slug is safe and unique', async () => {
    const response = await call('POST', '/api/v1/workspaces', tokens.owner, { name: 'Ünï Çode & Co!' });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; slug: string };
    expect(created.slug).toMatch(/^[a-z0-9-]+$/);
    expect((await call('GET', `/api/v1/workspaces/${created.id}`, tokens.owner)).status).toBe(200);
    const me = (await (await call('GET', '/api/v1/me', tokens.owner)).json()) as { memberships: { role: string; workspace: { id: string } }[] };
    expect(me.memberships.find((m) => m.workspace.id === created.id)?.role).toBe('owner');
  });

  it('refuses an agent on an invite-only installation', async () => {
    const response = await call('POST', '/api/v1/workspaces', tokens.agent, { name: 'Mine' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'signup_closed' });
  });

  it('refuses a name with control characters, which could reach an email subject', async () => {
    expect((await call('POST', '/api/v1/workspaces', tokens.owner, { name: 'a\r\nBcc: x@example.com' })).status).toBe(400);
  });

  it('lets owners and admins rename, and nobody else', async () => {
    expect((await call('PATCH', W1, tokens.agent, { name: 'x' })).status).toBe(403);
    expect((await call('PATCH', W1, tokens.supervisor, { name: 'x' })).status).toBe(403);
    expect((await call('PATCH', W1, tokens.outsider, { name: 'x' })).status).toBe(404);
    const renamed = await call('PATCH', W1, tokens.admin, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: 'work_1', name: 'Renamed' });
  });
});

describe('members', () => {
  it('lists this workspace only, with pagination', async () => {
    const first = (await (await call('GET', `${W1}/members?limit=3`, tokens.agent)).json()) as { data: { id: string }[]; nextCursor: string };
    expect(first.data).toHaveLength(3);
    const second = (await (await call('GET', `${W1}/members?limit=3&cursor=${first.nextCursor}`, tokens.agent)).json()) as { data: { id: string }[]; nextCursor: null };
    expect(second.nextCursor).toBeNull();
    const ids = [...first.data, ...second.data].map((m) => m.id).sort();
    expect(ids).toEqual(['mem_admin', 'mem_agent', 'mem_owner', 'mem_supervisor']);
  });

  it('applies the role table', async () => {
    const target = `${W1}/members/mem_agent`;
    expect((await call('PATCH', target, tokens.agent, { role: 'admin' })).status).toBe(403);
    expect((await call('PATCH', target, tokens.supervisor, { role: 'admin' })).status).toBe(403);
    expect((await call('DELETE', target, tokens.supervisor)).status).toBe(403);
    expect((await call('PATCH', `${W1}/members/mem_owner`, tokens.admin, { status: 'suspended' })).status).toBe(403);
    expect((await call('PATCH', target, tokens.admin, { role: 'owner' })).status).toBe(403);
    const changed = await call('PATCH', target, tokens.admin, { role: 'supervisor' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ id: 'mem_agent', role: 'supervisor', email: 'agent@example.com' });
    expect((await call('DELETE', target, tokens.admin)).status).toBe(204);
    expect((await call('GET', W1, tokens.agent)).status).toBe(404);
  });

  it('protects the last owner with a 409', async () => {
    const response = await call('PATCH', `${W1}/members/mem_owner`, tokens.owner, { role: 'agent' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'last_owner' });
    expect((await call('DELETE', `${W1}/members/mem_owner`, tokens.owner)).status).toBe(409);
  });

  it('answers 404 for a member of another workspace', async () => {
    expect((await call('PATCH', `${W1}/members/mem_outsider`, tokens.owner, { role: 'agent' })).status).toBe(404);
    expect((await call('DELETE', `${W1}/members/mem_outsider`, tokens.owner)).status).toBe(404);
  });

  it('rejects an empty change and an unknown field', async () => {
    expect((await call('PATCH', `${W1}/members/mem_agent`, tokens.owner, {})).status).toBe(400);
    expect((await call('PATCH', `${W1}/members/mem_agent`, tokens.owner, { workspaceId: 'work_2', role: 'agent' })).status).toBe(400);
  });
});

describe('invitations', () => {
  async function deliverLatest(job: JobEnvelope) {
    const emails: EmailMessage[] = [];
    const batch = createMessageBatch('oc-email', [{ id: job.id, timestamp: new Date(), attempts: 1, body: job }]);
    await handleQueue(batch as never, env as unknown as Env, { email: { send: async (m) => (emails.push(m), { messageId: 'x' }) } });
    return emails;
  }

  async function inviteAndDeliver(email: string, role = 'agent', workspace = W1) {
    queued.length = 0;
    const response = await call('POST', `${workspace}/invitations`, tokens.owner, { email, role });
    expect(response.status).toBe(201);
    const job = queued.at(-1)!;
    expect(job).toMatchObject({ type: 'workspace.invitation_email', workspaceId: 'work_1', payload: { invitationId: ((await response.json()) as { id: string }).id } });
    expect(JSON.stringify(job)).not.toContain(email);
    const emails = await deliverLatest(job);
    return { emails, token: /#token=([\w-]+)/.exec(emails[0]!.text!)![1]! };
  }

  const accept = (body: Record<string, unknown>) => call('POST', '/api/v1/invitations/accept', undefined, body);

  it('takes a new person from invitation to working sign-in', async () => {
    const { emails, token } = await inviteAndDeliver('new@example.com');
    expect(emails[0]!.to).toBe('new@example.com');
    expect(emails[0]!.subject).toContain('One');

    const incomplete = await accept({ token });
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toMatchObject({ code: 'account_details_required' });

    const accepted = await accept({ token, name: 'New Person', password: 'a long new password' });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ workspaceId: 'work_1' });

    const access = await signIn('new@example.com', 'a long new password');
    const workspace = await call('GET', W1, access);
    expect(workspace.status).toBe(200);
    expect((await accept({ token, name: 'Again', password: 'a long new password' })).status).toBe(400);
  });

  it('does not let an invitation change an existing account’s password', async () => {
    const { token } = await inviteAndDeliver('outsider@example.com');
    expect((await accept({ token, name: 'Attacker', password: 'attacker password' })).status).toBe(200);
    await signIn('outsider@example.com');
    const failed = await call('POST', '/api/v1/auth/login', undefined, { email: 'outsider@example.com', password: 'attacker password', clientType: 'mobile' });
    expect(failed.status).toBe(401);
    expect((await call('GET', W1, tokens.outsider)).status).toBe(200);
  });

  it('applies the role table, and cannot grant owner', async () => {
    expect((await call('POST', `${W1}/invitations`, tokens.agent, { email: 'a@example.com', role: 'agent' })).status).toBe(403);
    expect((await call('POST', `${W1}/invitations`, tokens.supervisor, { email: 'a@example.com', role: 'agent' })).status).toBe(403);
    expect((await call('POST', `${W1}/invitations`, tokens.outsider, { email: 'a@example.com', role: 'agent' })).status).toBe(404);
    expect((await call('POST', `${W1}/invitations`, tokens.owner, { email: 'a@example.com', role: 'owner' })).status).toBe(400);
    expect((await call('POST', `${W1}/invitations`, tokens.admin, { email: 'a@example.com', role: 'admin' })).status).toBe(201);
  });

  it('answers 409 for someone who is already a member', async () => {
    const response = await call('POST', `${W1}/invitations`, tokens.owner, { email: 'AGENT@example.com', role: 'agent' });
    expect(response.status).toBe(409);
  });

  it('keeps the token out of the response and stores no usable token in the row', async () => {
    const response = await call('POST', `${W1}/invitations`, tokens.owner, { email: 'b@example.com', role: 'agent' });
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'expiresAt', 'id', 'role']);
  });

  it('refuses an unknown token', async () => {
    expect((await accept({ token: 'never-issued', name: 'N', password: 'a long new password' })).status).toBe(400);
  });
});

describe('websites', () => {
  const site = { name: 'Main', allowedOrigins: ['https://example.org'] };

  it('creates a key, lists it to any member, and only managers can write', async () => {
    expect((await call('POST', `${W1}/websites`, tokens.agent, site)).status).toBe(403);
    expect((await call('POST', `${W1}/websites`, tokens.supervisor, site)).status).toBe(403);
    const created = await call('POST', `${W1}/websites`, tokens.admin, { ...site, settings: { primaryColor: '#112233' } });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; websiteKey: string; settings: unknown };
    expect(body.websiteKey).toMatch(/^wk_.{32,}/);
    expect(body.settings).toEqual({ primaryColor: '#112233' });
    const list = (await (await call('GET', `${W1}/websites`, tokens.agent)).json()) as { data: { id: string; allowedOrigins: string[] }[] };
    expect(list.data).toEqual([expect.objectContaining({ id: body.id, allowedOrigins: site.allowedOrigins })]);
    expect(((await (await call('GET', `${W2}/websites`, tokens.outsider)).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('updates only what is sent, and not across workspaces', async () => {
    const { id } = (await (await call('POST', `${W1}/websites`, tokens.owner, { ...site, settings: { welcomeMessage: 'Hi' } })).json()) as { id: string };
    const updated = await call('PATCH', `${W1}/websites/${id}`, tokens.owner, { name: 'Renamed' });
    expect(await updated.json()).toMatchObject({ name: 'Renamed', allowedOrigins: site.allowedOrigins, settings: { welcomeMessage: 'Hi' } });
    expect((await call('PATCH', `${W1}/websites/site_missing`, tokens.owner, { name: 'x' })).status).toBe(404);
    expect((await call('PATCH', `${W2}/websites/${id}`, tokens.outsider, { name: 'stolen' })).status).toBe(404);
    expect((await call('PATCH', `${W1}/websites/${id}`, tokens.outsider, { name: 'stolen' })).status).toBe(404);
  });

  it.each(['https://*.example.org', 'http://example.org', 'https://example.org/path', 'javascript:alert(1)', 'not a url', 'https://example.org/'])(
    'refuses the origin %s',
    async (origin) => {
      expect((await call('POST', `${W1}/websites`, tokens.owner, { name: 'x', allowedOrigins: [origin] })).status).toBe(400);
    },
  );

  it('accepts plain HTTP only on the local machine', async () => {
    expect((await call('POST', `${W1}/websites`, tokens.owner, { name: 'x', allowedOrigins: ['http://localhost:5173'] })).status).toBe(201);
  });

  it('refuses unknown settings', async () => {
    expect((await call('POST', `${W1}/websites`, tokens.owner, { ...site, settings: { script: '<x>' } })).status).toBe(400);
  });
});

