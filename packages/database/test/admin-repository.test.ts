import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminRepository, authorizeInstallationAdmin, authorizeWorkspaceMember, listMemberships, openDatabase, repositories } from '../src/index';

// These call batches directly, with contexts that may be stale, because a decision made in JavaScript would
// pass every sequential test. A context is proof of what was true when the request was authorised.
const db = () => openDatabase(env.DB);
const auditCount = (action: string) => env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1').bind(action).first('n');

beforeEach(async () => {
  await env.DB.batch(['audit_log', 'outbox', 'websites', 'push_subscriptions', 'conversations', 'workspace_members', 'auth_sessions', 'auth_tokens', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('i', 'I', 'https://x.test', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('w1', 'One', 'one', 1, 1), ('w2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES
       ('boss', 'boss@x.test', 'Boss', 'keep', 1, 1, 1), ('lead', 'lead@x.test', 'Lead', 'keep', 0, 1, 1), ('agent', 'agent@x.test', 'Agent', 'keep', 0, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
       ('m_lead', 'w1', 'lead', 'supervisor', 'active', 1, 1), ('m_agent', 'w1', 'agent', 'agent', 'active', 1, 1)`,
    ),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('s1', 'w1', 'Shop', 'k1', 1, 1)`),
  ]);
});

const adminContext = async () => (await authorizeInstallationAdmin(db(), 'boss'))!;

describe('roles written by an older Worker', () => {
  // A migration and a deploy are not atomic, so these can appear after the migration has run.
  it.each(['owner', 'admin'])('treats %s as supervisor everywhere it is read', async (legacy) => {
    await env.DB.prepare(`UPDATE workspace_members SET role = ?1 WHERE id = 'm_lead'`).bind(legacy).run();
    const ctx = (await authorizeWorkspaceMember(db(), 'lead', 'w1'))!;
    expect(ctx.role).toBe('supervisor');
    expect((await repositories(db(), ctx).members.get('m_lead'))?.role).toBe('supervisor');
    expect((await adminRepository(db(), await adminContext()).get('lead'))?.memberships[0]?.role).toBe('supervisor');
    expect((await listMemberships(db(), 'lead'))[0]?.role).toBe('supervisor');
  });
});

describe('adminRepository', () => {
  it('gives no context to anyone but an active admin', async () => {
    expect(await authorizeInstallationAdmin(db(), 'agent')).toBeNull();
    expect(await authorizeInstallationAdmin(db(), 'boss')).not.toBeNull();
    await env.DB.prepare(`UPDATE users SET disabled_at = 1 WHERE id = 'boss'`).run();
    expect(await authorizeInstallationAdmin(db(), 'boss')).toBeNull();
  });

  // A context says what was true when the request was authorised. The role may be gone by the commit.
  it('refuses every change once the role is gone, for a context already held', async () => {
    const stale = await adminContext();
    await env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, client_type, created_at, last_used_at, expires_at) VALUES ('s', 'agent', 'h', 'mobile', 1, 1, 9999999999999)`).run();
    await env.DB.prepare(`UPDATE users SET is_installation_admin = 0 WHERE id = 'boss'`).run();
    const admin = adminRepository(db(), stale);
    expect(await admin.create({ name: 'New', email: 'new@x.test' })).toEqual({ outcome: 'forbidden' });
    expect(await admin.setAdmin('agent', true)).toEqual({ outcome: 'forbidden' });
    expect(await admin.deactivate('agent')).toEqual({ outcome: 'forbidden' });
    expect(await admin.assign('agent', 'w2', 'agent')).toEqual({ outcome: 'forbidden' });
    expect(await admin.unassign('agent', 'w1')).toEqual({ outcome: 'forbidden' });
    expect(await admin.createWorkspace({ name: 'Mine', slug: 'mine' })).toBeNull();
    expect(await admin.updateWorkspace('w1', { name: 'Taken' })).toBeNull();
    expect(await admin.createWebsite('w1', { name: 'Taken', websiteKey: 'k2', allowedOrigins: [] })).toBeNull();
    expect(await admin.updateWebsite('w1', 's1', { name: 'Taken' })).toBeNull();

    expect(await env.DB.prepare(`SELECT revoked_at AS r FROM auth_sessions WHERE id = 's'`).first('r')).toBeNull();
    expect(await env.DB.prepare(`SELECT disabled_at AS d FROM users WHERE id = 'agent'`).first('d')).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces`).first('n')).toBe(2);
    expect(await env.DB.prepare(`SELECT name FROM workspaces WHERE id = 'w1'`).first('name')).toBe('One');
    expect(await env.DB.prepare(`SELECT name FROM websites WHERE id = 's1'`).first('name')).toBe('Shop');
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM websites`).first('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log`).first('n')).toBe(0);
  });

  it('creates a workspace that nobody has joined, and records it', async () => {
    const created = await adminRepository(db(), await adminContext()).createWorkspace({ name: 'Mine', slug: 'mine' });
    expect(created).toMatchObject({ name: 'Mine', slug: 'mine' });
    expect(await authorizeWorkspaceMember(db(), 'boss', created!.id)).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?1`).bind(created!.id).first('n')).toBe(0);
    expect(await auditCount('workspace.created')).toBe(1);
  });

  it('finds a website only under its own workspace', async () => {
    const admin = adminRepository(db(), await adminContext());
    expect(await admin.updateWebsite('w2', 's1', { name: 'Stolen' })).toBeNull();
    expect(await env.DB.prepare(`SELECT name FROM websites WHERE id = 's1'`).first('name')).toBe('Shop');
    expect(await auditCount('website.updated')).toBe(0);
    expect(await admin.updateWebsite('w1', 's1', { name: 'Renamed' })).toMatchObject({ id: 's1', name: 'Renamed', websiteKey: 'k1' });
    expect(await auditCount('website.updated')).toBe(1);
    expect(await admin.listWebsites('w_missing')).toBeNull();
    expect(await admin.createWebsite('w_missing', { name: 'x', websiteKey: 'k3', allowedOrigins: [] })).toBeNull();
  });

  it('removing keeps the row, marks it removed, and takes away push subscriptions', async () => {
    await env.DB.prepare(`INSERT INTO push_subscriptions (id, workspace_id, member_id, relay_id, relay_subscription_id, platform, created_at, updated_at) VALUES ('p', 'w1', 'm_agent', 'r', 'h', 'ios', 1, 1)`).run();
    expect((await adminRepository(db(), await adminContext()).unassign('agent', 'w1')).outcome).toBe('done');
    expect(await env.DB.prepare(`SELECT status, removed_at AS r FROM workspace_members WHERE id = 'm_agent'`).first()).toMatchObject({ status: 'suspended', r: expect.any(Number) });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first('n')).toBe(0);
    expect(await authorizeWorkspaceMember(db(), 'agent', 'w1')).toBeNull();
  });
});
