import { createExecutionContext, createMessageBatch } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import type { EmailMessage } from '@openchat/email';
import type { JobEnvelope } from '@openchat/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/background';
import type { Env } from '../src/env';
import worker from '../src/index';

const queued: JobEnvelope[] = [];
const testEnv = { ...env, EMAIL_QUEUE: { send: async (job: JobEnvelope) => void queued.push(job) } } as unknown as Env;
const ORIGIN = 'https://example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const PEOPLE = '/api/v1/admin/people';

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

let counter = 0;
const call = (method: string, path: string, token?: string, body?: unknown, origin?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `198.51.100.${++counter % 250}-${counter}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

const login = (email: string, password = PASSWORD) => call('POST', '/api/v1/auth/login', undefined, { email, password, clientType: 'mobile' });
async function signIn(email: string): Promise<string> {
  const response = await login(email);
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

interface Person {
  id: string;
  isInstallationAdmin: boolean;
  deactivated: boolean;
  memberships: { memberId: string; workspaceId: string; role: string; status: string }[];
}
const person = async (response: Response, status = 200) => {
  expect(response.status).toBe(status);
  return (await response.json()) as Person;
};
const code = async (response: Response) => ((await response.json()) as { code: string }).code;
const auditActions = async () => (await env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'person.%' OR action LIKE 'workspace.%' OR action LIKE 'website.%' ORDER BY created_at, id`).all<{ action: string }>()).results.map((r) => r.action);

const tokens: Record<string, string> = {};

beforeEach(async () => {
  queued.length = 0;
  await env.DB.batch(['audit_log', 'outbox', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'invitations', 'workspace_members', 'auth_sessions', 'auth_tokens', 'workspaces', 'users', 'installation'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  const users = ['boss', 'owner', 'agent', 'outsider'];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', 'https://example.com', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 1, 1)`),
    ...users.map((u) => env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)`).bind(`user_${u}`, `${u}@example.com`, u, hash, u === 'boss' ? 1 : 0)),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
       ('mem_owner', 'work_1', 'user_owner', 'supervisor', 'active', 1, 1), ('mem_agent', 'work_1', 'user_agent', 'agent', 'active', 1, 1),
       ('mem_outsider', 'work_2', 'user_outsider', 'supervisor', 'active', 1, 1)`,
    ),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_1', ?1, 1, 1)`).bind(JSON.stringify([SITE])),
    env.DB.prepare(`UPDATE websites SET settings_json = '{"showAgentNames":true}'`),
  ]);
  for (const u of users) tokens[u] = await signIn(`${u}@example.com`);
});

/** A visitor's conversation in work_1, with one reply from the agent. */
async function conversationWithReply() {
  const session = (await (await call('POST', '/api/v1/widget/sessions', undefined, { websiteKey: 'key_1' }, SITE)).json()) as { accessToken: string };
  const conversation = (await (await call('POST', '/api/v1/widget/conversations', session.accessToken, { clientMessageId: 'visitor-first', content: 'Hello' }, SITE)).json()) as { id: string };
  const path = `/api/v1/workspaces/work_1/conversations/${conversation.id}`;
  expect((await call('POST', `${path}/messages`, tokens.agent, { clientMessageId: 'agent-reply', type: 'text', content: 'Hi there' })).status).toBe(201);
  return { path, visitor: session.accessToken, visitorPath: `/api/v1/widget/conversations/${conversation.id}` };
}
interface Sender { type: string; displayName: string | null; removed?: boolean }
const agentSender = async (path: string, token: string | undefined = tokens.owner) => {
  const { data } = (await (await call('GET', `${path}/messages`, token)).json()) as { data: { sender: Sender }[] };
  return data.find((message) => message.sender.type === 'member')!.sender;
};

describe('who can reach the admin routes', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', PEOPLE],
    ['POST', PEOPLE, { name: 'New', email: 'new@example.com' }],
    ['PATCH', `${PEOPLE}/user_agent`, { isInstallationAdmin: true }],
    ['POST', `${PEOPLE}/user_agent/deactivate`],
    ['POST', `${PEOPLE}/user_agent/reactivate`],
    ['PUT', `${PEOPLE}/user_agent/workspaces/work_2`, { role: 'agent' }],
    ['DELETE', `${PEOPLE}/user_agent/workspaces/work_1`],
    ['GET', '/api/v1/admin/workspaces'],
    ['POST', '/api/v1/admin/workspaces', { name: 'New' }],
    ['PATCH', '/api/v1/admin/workspaces/work_1', { name: 'New' }],
    ['GET', '/api/v1/admin/workspaces/work_1/websites'],
    ['POST', '/api/v1/admin/workspaces/work_1/websites', { name: 'New', allowedOrigins: [] }],
    ['PATCH', '/api/v1/admin/workspaces/work_1/websites/site_1', { name: 'New' }],
  ];

  it('needs a token', async () => {
    for (const [method, path, body] of routes) expect((await call(method, path, undefined, body)).status).toBe(401);
  });

  it('answers 404 to anyone else, including a supervisor, and changes nothing', async () => {
    for (const token of [tokens.agent, tokens.owner]) {
      for (const [method, path, body] of routes) expect((await call(method, path, token, body)).status).toBe(404);
    }
    expect(await env.DB.prepare(`SELECT disabled_at FROM users WHERE id = 'user_agent'`).first('disabled_at')).toBeNull();
    expect(await auditActions()).toEqual([]);
  });

  it('stops working as soon as the role is gone, for a token already issued', async () => {
    expect((await call('GET', PEOPLE, tokens.boss)).status).toBe(200);
    await env.DB.prepare(`UPDATE users SET is_installation_admin = 0 WHERE id = 'user_boss'`).run();
    expect((await call('GET', PEOPLE, tokens.boss)).status).toBe(404);
  });

  it('tells a signed-in user whether they are an admin', async () => {
    expect(await (await call('GET', '/api/v1/me', tokens.boss)).json()).toMatchObject({ isInstallationAdmin: true });
    expect(await (await call('GET', '/api/v1/me', tokens.agent)).json()).toMatchObject({ isInstallationAdmin: false });
  });
});

describe('what an admin can see', () => {
  it('lists everyone with their workspaces, across the installation, and pages', async () => {
    const page = (await (await call('GET', `${PEOPLE}?limit=2`, tokens.boss)).json()) as { data: Person[]; nextCursor: string };
    expect(page.data).toHaveLength(2);
    const rest = (await (await call('GET', `${PEOPLE}?limit=10&cursor=${page.nextCursor}`, tokens.boss)).json()) as { data: Person[] };
    const all = [...page.data, ...rest.data];
    expect(all.map((p) => p.id).sort()).toEqual(['user_agent', 'user_boss', 'user_outsider', 'user_owner']);
    expect(all.find((p) => p.id === 'user_agent')?.memberships).toEqual([{ memberId: 'mem_agent', workspaceId: 'work_1', workspaceName: 'One', role: 'agent', status: 'active' }]);
    expect(all.find((p) => p.id === 'user_boss')).toMatchObject({ isInstallationAdmin: true, memberships: [] });
  });

  it('has no way into a workspace without joining it, and joining is audited', async () => {
    const { path } = await conversationWithReply();
    expect((await call('GET', '/api/v1/workspaces/work_1', tokens.boss)).status).toBe(404);
    expect((await call('GET', `${path}/messages`, tokens.boss)).status).toBe(404);
    await person(await call('PUT', `${PEOPLE}/user_boss/workspaces/work_1`, tokens.boss, { role: 'agent' }));
    expect((await call('GET', `${path}/messages`, tokens.boss)).status).toBe(200);
    expect(await auditActions()).toEqual(['person.assigned']);
  });

});

describe('managing workspaces and websites', () => {
  const ADMIN_WORKSPACES = '/api/v1/admin/workspaces';

  it('creates a workspace that nobody has joined, so that an admin still has no way in', async () => {
    const created = await call('POST', ADMIN_WORKSPACES, tokens.boss, { name: 'Ünï Çode & Co!' });
    expect(created.status).toBe(201);
    const { id, slug } = (await created.json()) as { id: string; slug: string };
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect((await call('GET', `/api/v1/workspaces/${id}`, tokens.boss)).status).toBe(404);
    const me = (await (await call('GET', '/api/v1/me', tokens.boss)).json()) as { memberships: unknown[] };
    expect(me.memberships).toEqual([]);
    expect(await auditActions()).toEqual(['workspace.created']);
  });

  it('refuses a workspace name with control characters, which could reach an email subject', async () => {
    expect((await call('POST', ADMIN_WORKSPACES, tokens.boss, { name: 'a\r\nBcc: x@example.com' })).status).toBe(400);
  });

  it('renames a workspace without joining it, and gives 404 for an unknown one', async () => {
    const renamed = await call('PATCH', `${ADMIN_WORKSPACES}/work_1`, tokens.boss, { name: 'Renamed' });
    expect(await renamed.json()).toMatchObject({ id: 'work_1', name: 'Renamed' });
    expect((await call('PATCH', `${ADMIN_WORKSPACES}/work_none`, tokens.boss, { name: 'x' })).status).toBe(404);
    expect(await auditActions()).toEqual(['workspace.updated']);
  });

  it('manages websites without joining, and members see the result', async () => {
    const created = await call('POST', `${ADMIN_WORKSPACES}/work_1/websites`, tokens.boss, { name: 'Blog', allowedOrigins: ['https://blog.example.org'], settings: { welcomeMessage: 'Hi' } });
    expect(created.status).toBe(201);
    const { id, websiteKey } = (await created.json()) as { id: string; websiteKey: string };
    expect(websiteKey).toMatch(/^wk_.{32,}/);

    const updated = await call('PATCH', `${ADMIN_WORKSPACES}/work_1/websites/${id}`, tokens.boss, { name: 'Renamed' });
    expect(await updated.json()).toMatchObject({ name: 'Renamed', allowedOrigins: ['https://blog.example.org'], settings: { welcomeMessage: 'Hi' } });
    expect((await call('PATCH', `${ADMIN_WORKSPACES}/work_1/websites/site_none`, tokens.boss, { name: 'x' })).status).toBe(404);
    expect((await call('PATCH', `${ADMIN_WORKSPACES}/work_2/websites/${id}`, tokens.boss, { name: 'x' })).status).toBe(404);

    const forAdmin = (await (await call('GET', `${ADMIN_WORKSPACES}/work_1/websites`, tokens.boss)).json()) as { data: { id: string }[] };
    expect(forAdmin.data.map((w) => w.id)).toContain(id);
    const forAgent = (await (await call('GET', '/api/v1/workspaces/work_1/websites', tokens.agent)).json()) as { data: { id: string; name: string }[] };
    expect(forAgent.data.find((w) => w.id === id)?.name).toBe('Renamed');
    expect((await call('GET', `${ADMIN_WORKSPACES}/work_none/websites`, tokens.boss)).status).toBe(404);
    expect(await auditActions()).toEqual(['website.created', 'website.updated']);
  });

  it.each(['https://*.example.org', 'http://example.org', 'https://example.org/path', 'javascript:alert(1)', 'not a url', 'https://example.org/'])('refuses the origin %s', async (origin) => {
    expect((await call('POST', `${ADMIN_WORKSPACES}/work_1/websites`, tokens.boss, { name: 'x', allowedOrigins: [origin] })).status).toBe(400);
  });

  it('accepts plain HTTP only on the local machine, and refuses unknown settings', async () => {
    expect((await call('POST', `${ADMIN_WORKSPACES}/work_1/websites`, tokens.boss, { name: 'x', allowedOrigins: ['http://localhost:5173'] })).status).toBe(201);
    expect((await call('POST', `${ADMIN_WORKSPACES}/work_1/websites`, tokens.boss, { name: 'x', allowedOrigins: [], settings: { script: '<x>' } })).status).toBe(400);
  });

  it('sets the widget language, from the languages the widget speaks', async () => {
    const updated = await call('PATCH', `${ADMIN_WORKSPACES}/work_1/websites/site_1`, tokens.boss, { settings: { language: 'zh-Hant' } });
    expect([updated.status, ((await updated.json()) as { settings: { language?: string } }).settings.language]).toEqual([200, 'zh-Hant']);
    const bootstrap = await call('GET', '/api/v1/widget/bootstrap?websiteKey=key_1', undefined, undefined, SITE);
    expect(((await bootstrap.json()) as { settings: { language?: string } }).settings.language).toBe('zh-Hant');
    for (const language of ['xx', 'zh', 'EN']) {
      expect([language, (await call('PATCH', `${ADMIN_WORKSPACES}/work_1/websites/site_1`, tokens.boss, { settings: { language } })).status]).toEqual([language, 400]);
    }
  });

  it('has no routes left inside a workspace for what moved here', async () => {
    const W = '/api/v1/workspaces/work_1';
    for (const [method, path, body] of [
      ['POST', '/api/v1/workspaces', { name: 'x' }],
      ['PATCH', W, { name: 'x' }],
      ['POST', `${W}/websites`, { name: 'x', allowedOrigins: [] }],
      ['PATCH', `${W}/websites/site_1`, { name: 'x' }],
      ['PATCH', `${W}/members/mem_agent`, { role: 'agent' }],
      ['DELETE', `${W}/members/mem_agent`],
      ['POST', `${W}/invitations`, { email: 'x@example.com', role: 'agent' }],
      ['POST', '/api/v1/invitations/accept', { token: 'x' }],
    ] as const) {
      expect([method, path, (await call(method, path, tokens.boss, body)).status]).toEqual([method, path, 404]);
    }
  });
});

describe('adding someone', () => {
  it('creates an account that cannot sign in until they follow the emailed link', async () => {
    const created = await person(await call('POST', PEOPLE, tokens.boss, { name: 'New Person', email: 'new@example.com' }), 201);
    expect(created).toMatchObject({ deactivated: false, isInstallationAdmin: false, memberships: [] });
    expect((await login('new@example.com')).status).toBe(401);

    const job = queued.at(-1)!;
    expect(JSON.stringify(job)).not.toContain('token');
    const emails: EmailMessage[] = [];
    const batch = createMessageBatch('oc-email', [{ id: job.id, timestamp: new Date(), attempts: 1, body: job }]);
    await handleQueue(batch as never, env as unknown as Env, { email: { send: async (m) => (emails.push(m), { messageId: 'x' }) } });
    expect(emails[0]).toMatchObject({ to: 'new@example.com' });
    expect(emails[0]!.text).toContain('seven days');
    const token = /#token=([^\s]+)/.exec(emails[0]!.text ?? '')![1]!;

    expect((await call('POST', '/api/v1/auth/password-reset/confirm', undefined, { token, password: PASSWORD })).status).toBe(204);
    expect((await login('new@example.com')).status).toBe(200);
  });

  it('refuses an address that has an account, in any case', async () => {
    const response = await call('POST', PEOPLE, tokens.boss, { name: 'Twin', email: 'AGENT@example.com' });
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('email_taken');
    expect(queued).toEqual([]);
  });
});

describe('assigning to a workspace', () => {
  it('takes effect at once, with no invitation, and only for that workspace', async () => {
    expect((await call('GET', '/api/v1/workspaces/work_2', tokens.agent)).status).toBe(404);
    const assigned = await person(await call('PUT', `${PEOPLE}/user_agent/workspaces/work_2`, tokens.boss, { role: 'supervisor' }));
    expect(assigned.memberships.map((m) => [m.workspaceId, m.role])).toEqual(expect.arrayContaining([['work_1', 'agent'], ['work_2', 'supervisor']]));
    expect((await call('GET', '/api/v1/workspaces/work_2', tokens.agent)).status).toBe(200);
  });

  it('has only the workspace roles, and a workspace may end up with nobody in it', async () => {
    for (const role of ['owner', 'admin']) expect((await call('PUT', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss, { role })).status).toBe(400);
    await person(await call('DELETE', `${PEOPLE}/user_owner/workspaces/work_1`, tokens.boss));
    await person(await call('DELETE', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss));
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'work_1' AND status = 'active'`).first('n')).toBe(0);
  });

  it('gives 404 for someone or somewhere unknown', async () => {
    expect((await call('PUT', `${PEOPLE}/user_none/workspaces/work_1`, tokens.boss, { role: 'agent' })).status).toBe(404);
    expect((await call('PUT', `${PEOPLE}/user_agent/workspaces/work_none`, tokens.boss, { role: 'agent' })).status).toBe(404);
    expect((await call('DELETE', `${PEOPLE}/user_agent/workspaces/work_2`, tokens.boss)).status).toBe(404);
  });

  it('refuses someone deactivated', async () => {
    await person(await call('POST', `${PEOPLE}/user_agent/deactivate`, tokens.boss));
    const response = await call('PUT', `${PEOPLE}/user_agent/workspaces/work_2`, tokens.boss, { role: 'agent' });
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('person_deactivated');
  });
});

describe('removing from a workspace', () => {
  it('ends access, keeps their name on messages, and shows the team they were removed', async () => {
    const { path, visitor, visitorPath } = await conversationWithReply();
    await env.DB.prepare(`UPDATE conversations SET assigned_member_id = 'mem_agent'`).run();
    expect(await agentSender(path)).toEqual({ type: 'member', id: 'mem_agent', displayName: 'agent' });

    await person(await call('DELETE', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss));

    expect((await call('GET', '/api/v1/workspaces/work_1', tokens.agent)).status).toBe(404);
    expect(await agentSender(path)).toEqual({ type: 'member', id: 'mem_agent', displayName: 'agent', removed: true });
    expect(await env.DB.prepare(`SELECT assigned_member_id AS a FROM conversations`).first('a')).toBeNull();
    const members = (await (await call('GET', '/api/v1/workspaces/work_1/members', tokens.owner)).json()) as { data: { id: string; status: string }[] };
    expect(members.data.find((m) => m.id === 'mem_agent')?.status).toBe('removed');

    // The visitor still sees who answered, and nothing about the team.
    const seen = (await (await call('GET', `${visitorPath}/messages`, visitor, undefined, SITE)).json()) as { data: { sender: Sender }[] };
    expect(seen.data.find((message) => message.sender.type === 'member')?.sender).toEqual({ type: 'member', displayName: 'agent' });
  });

  it('does not count as assignable', async () => {
    const { path } = await conversationWithReply();
    await person(await call('DELETE', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss));
    const { version } = (await (await call('GET', path, tokens.owner)).json()) as { version: number };
    expect((await call('PATCH', path, tokens.owner, { assignedMemberId: 'mem_agent', expectedVersion: version })).status).not.toBe(200);
  });

  it('can be undone by an admin assigning them, with the same member and name', async () => {
    const { path } = await conversationWithReply();
    await person(await call('DELETE', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss));
    const assigned = await person(await call('PUT', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss, { role: 'supervisor' }));
    expect(assigned.memberships).toEqual([expect.objectContaining({ memberId: 'mem_agent', role: 'supervisor', status: 'active' })]);
    expect((await call('GET', '/api/v1/workspaces/work_1', tokens.agent)).status).toBe(200);
    expect(await agentSender(path)).toEqual({ type: 'member', id: 'mem_agent', displayName: 'agent' });
  });

  it('can bring back someone suspended before suspending was removed', async () => {
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_agent'`).run();
    const assigned = await person(await call('PUT', `${PEOPLE}/user_agent/workspaces/work_1`, tokens.boss, { role: 'agent' }));
    expect(assigned.memberships).toEqual([expect.objectContaining({ memberId: 'mem_agent', status: 'active' })]);
  });
});

describe('deactivating and reactivating', () => {
  it('ends every way in, keeps the name on messages, and restores everything as it was', async () => {
    const { path } = await conversationWithReply();
    await env.DB.prepare(`UPDATE conversations SET assigned_member_id = 'mem_agent'`).run();
    await env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ('pending', 'user_agent', 'password_reset', 9999999999999)`).run();

    const off = await person(await call('POST', `${PEOPLE}/user_agent/deactivate`, tokens.boss));
    expect(off.deactivated).toBe(true);
    expect((await call('GET', '/api/v1/me', tokens.agent)).status).toBe(401);
    expect((await login('agent@example.com')).status).toBe(401);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM auth_tokens`).first('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT assigned_member_id AS a FROM conversations`).first('a')).toBeNull();
    expect(await agentSender(path)).toEqual({ type: 'member', id: 'mem_agent', displayName: 'agent', removed: true });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE topic = 'member.access_changed' AND aggregate_id = 'mem_agent'`).first('n')).toBeGreaterThan(0);

    const on = await person(await call('POST', `${PEOPLE}/user_agent/reactivate`, tokens.boss));
    expect(on.deactivated).toBe(false);
    expect(on.memberships).toEqual([expect.objectContaining({ memberId: 'mem_agent', role: 'agent', status: 'active' })]);
    const token = await signIn('agent@example.com');
    expect((await call('GET', '/api/v1/workspaces/work_1', token)).status).toBe(200);
    expect(await agentSender(path)).toEqual({ type: 'member', id: 'mem_agent', displayName: 'agent' });
    expect(await auditActions()).toEqual(['person.deactivated', 'person.reactivated']);
  });

  it('does not let someone deactivated get a reset link', async () => {
    await person(await call('POST', `${PEOPLE}/user_agent/deactivate`, tokens.boss));
    queued.length = 0;
    expect((await call('POST', '/api/v1/auth/password-reset/request', undefined, { email: 'agent@example.com' })).status).toBeLessThan(300);
    expect(queued).toEqual([]);
  });

  it('refuses yourself', async () => {
    const response = await call('POST', `${PEOPLE}/user_boss/deactivate`, tokens.boss);
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('cannot_deactivate_self');
    expect((await call('GET', '/api/v1/me', tokens.boss)).status).toBe(200);
  });

  it('gives 404 for an unknown person', async () => {
    expect((await call('POST', `${PEOPLE}/user_none/deactivate`, tokens.boss)).status).toBe(404);
    expect((await call('POST', `${PEOPLE}/user_none/reactivate`, tokens.boss)).status).toBe(404);
  });
});

describe('the admin role itself', () => {
  it('can be granted, and the last active admin cannot give it up', async () => {
    const alone = await call('PATCH', `${PEOPLE}/user_boss`, tokens.boss, { isInstallationAdmin: false });
    expect(alone.status).toBe(409);
    expect(await code(alone)).toBe('last_admin');

    expect((await person(await call('PATCH', `${PEOPLE}/user_agent`, tokens.boss, { isInstallationAdmin: true }))).isInstallationAdmin).toBe(true);
    expect((await call('GET', PEOPLE, tokens.agent)).status).toBe(200);
    expect((await person(await call('PATCH', `${PEOPLE}/user_boss`, tokens.boss, { isInstallationAdmin: false }))).isInstallationAdmin).toBe(false);
    expect((await call('GET', PEOPLE, tokens.boss)).status).toBe(404);
  });

  it('does not count a deactivated admin as the one who remains', async () => {
    await person(await call('PATCH', `${PEOPLE}/user_agent`, tokens.boss, { isInstallationAdmin: true }));
    await person(await call('POST', `${PEOPLE}/user_agent/deactivate`, tokens.boss));
    expect((await call('PATCH', `${PEOPLE}/user_boss`, tokens.boss, { isInstallationAdmin: false })).status).toBe(409);
  });
});
