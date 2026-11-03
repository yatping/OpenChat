import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { acceptInvitation, authorizeWorkspaceMember, createWorkspace, deleteAccount, inspectInvitation, openDatabase, prepareInvitationEmail, repositories, type WorkspaceContext } from '../src/index';

// These call batches directly, with contexts that may be stale, because a decision made in JavaScript would
// pass every sequential test. A context is proof of what was true when the request was authorised.
const db = () => openDatabase(env.DB);
const context = async (user: string, workspace = 'w1') => (await authorizeWorkspaceMember(db(), user, workspace))!;
const repos = (ctx: WorkspaceContext) => repositories(db(), ctx);
const roleOf = (member: string) => env.DB.prepare('SELECT role FROM workspace_members WHERE id = ?1').bind(member).first('role');
const auditCount = (action: string) => env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1').bind(action).first('n');

beforeEach(async () => {
  await env.DB.batch(['audit_log', 'invitations', 'conversations', 'workspace_members', 'auth_sessions', 'auth_tokens', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, signup_policy, created_at, updated_at) VALUES ('i', 'I', 'https://x.test', 'invite_only', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('w1', 'One', 'one', 1, 1), ('w2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES
       ('owner', 'owner@x.test', 'Owner', 'keep', 1, 1), ('owner2', 'owner2@x.test', 'Owner Two', 'keep', 1, 1),
       ('admin', 'admin@x.test', 'Admin', 'keep', 1, 1), ('agent', 'agent@x.test', 'Agent', 'keep', 1, 1), ('other', 'other@x.test', 'Other', 'keep', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
       ('m_owner', 'w1', 'owner', 'owner', 'active', 1, 1), ('m_admin', 'w1', 'admin', 'admin', 'active', 1, 1),
       ('m_agent', 'w1', 'agent', 'agent', 'active', 1, 1), ('m_other', 'w2', 'other', 'owner', 'active', 1, 1)`,
    ),
  ]);
});

const addSecondOwner = () =>
  env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('m_owner2', 'w1', 'owner2', 'owner', 'active', 1, 1)`).run();

describe('the last-owner rule', () => {
  it('refuses to demote, suspend, or remove the only active owner', async () => {
    const ctx = await context('owner');
    expect(await repos(ctx).members.update('m_owner', { role: 'admin' })).toEqual({ outcome: 'last_owner' });
    expect(await repos(ctx).members.update('m_owner', { status: 'suspended' })).toEqual({ outcome: 'last_owner' });
    expect(await repos(ctx).members.remove('m_owner')).toEqual({ outcome: 'last_owner' });
    expect(await roleOf('m_owner')).toBe('owner');
    expect(await auditCount('member.updated')).toBe(0);
  });

  it('does not count a suspended owner as the remaining one', async () => {
    await addSecondOwner();
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'm_owner2'`).run();
    expect(await repos(await context('owner')).members.remove('m_owner')).toEqual({ outcome: 'last_owner' });
  });

  it('does not count an owner of another workspace', async () => {
    expect(await repos(await context('owner')).members.update('m_owner', { role: 'admin' })).toEqual({ outcome: 'last_owner' });
    expect(await roleOf('m_other')).toBe('owner');
  });

  it('allows it when another active owner remains, and writes an audit row', async () => {
    await addSecondOwner();
    expect(await repos(await context('owner')).members.update('m_owner', { role: 'admin' })).toEqual({ outcome: 'done' });
    expect(await roleOf('m_owner')).toBe('admin');
    expect(await auditCount('member.updated')).toBe(1);
  });

  it('holds when two owners demote each other at once', async () => {
    await addSecondOwner();
    const [a, b] = [await context('owner'), await context('owner2')];
    const results = await Promise.all([repos(a).members.update('m_owner2', { role: 'agent' }), repos(b).members.update('m_owner', { role: 'agent' })]);
    expect(results.filter((r) => r.outcome === 'done')).toHaveLength(1);
    const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'w1' AND role = 'owner' AND status = 'active'`).first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe('who may change a member', () => {
  it('stops an admin changing an owner or making one', async () => {
    const ctx = await context('admin');
    expect(await repos(ctx).members.update('m_owner', { status: 'suspended' })).toEqual({ outcome: 'forbidden' });
    expect(await repos(ctx).members.remove('m_owner')).toEqual({ outcome: 'forbidden' });
    expect(await repos(ctx).members.update('m_agent', { role: 'owner' })).toEqual({ outcome: 'forbidden' });
    expect(await roleOf('m_agent')).toBe('agent');
  });

  it('applies the actor’s role at commit, not the role in a stale context', async () => {
    const stale = await context('admin');
    await env.DB.prepare(`UPDATE workspace_members SET role = 'agent' WHERE id = 'm_admin'`).run();
    expect(await repos(stale).members.update('m_agent', { role: 'admin' })).toEqual({ outcome: 'forbidden' });
    expect(await repos(stale).members.remove('m_agent')).toEqual({ outcome: 'forbidden' });
    expect(await roleOf('m_agent')).toBe('agent');
  });

  it('applies the target’s role at commit', async () => {
    const admin = await context('admin');
    await env.DB.prepare(`UPDATE workspace_members SET role = 'owner' WHERE id = 'm_agent'`).run();
    expect(await repos(admin).members.remove('m_agent')).toEqual({ outcome: 'forbidden' });
  });

  it('treats a member of another workspace as not found', async () => {
    const ctx = await context('owner');
    expect(await repos(ctx).members.update('m_other', { role: 'agent' })).toEqual({ outcome: 'not_found' });
    expect(await repos(ctx).members.remove('m_other')).toEqual({ outcome: 'not_found' });
    expect(await repos(ctx).members.get('m_other')).toBeNull();
    expect(await roleOf('m_other')).toBe('owner');
  });

  it('releases assigned conversations when removing a member', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('s1', 'w1', 'S', 'k1', 1, 1)`),
      env.DB.prepare(`INSERT INTO contacts (id,workspace_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES ('p1','w1',1,1,1,1)`),
      env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, assigned_member_id, created_at, updated_at) VALUES ('c1', 'w1', 's1', 'p1', 'm_agent', 1, 1)`),
    ]);
    expect(await repos(await context('owner')).members.remove('m_agent')).toEqual({ outcome: 'done' });
    expect(await env.DB.prepare(`SELECT assigned_member_id AS a FROM conversations WHERE id = 'c1'`).first('a')).toBeNull();
  });
});

describe('invitations', () => {
  const invite = async (email: string, role: 'admin' | 'agent' = 'agent', hash = `hash-${email}`) =>
    repos(await context('owner')).invitations.create({ email, role, placeholderTokenHash: hash, ttlMs: 60_000 });

  it('refuses someone who is already a member, whatever the case of the address', async () => {
    expect(await invite('AGENT@x.test')).toEqual({ outcome: 'already_member' });
  });

  it('replaces a pending invitation for the same address, and only in this workspace', async () => {
    await invite('new@x.test', 'agent', 'first');
    await invite('NEW@x.test', 'admin', 'second');
    const { results } = await env.DB.prepare(`SELECT token_hash AS h, role FROM invitations WHERE workspace_id = 'w1'`).all();
    expect(results).toEqual([{ h: 'second', role: 'admin' }]);
  });

  it('stops a demoted actor inviting', async () => {
    const stale = await context('admin');
    await env.DB.prepare(`UPDATE workspace_members SET role = 'agent' WHERE id = 'm_admin'`).run();
    const result = await repos(stale).invitations.create({ email: 'new@x.test', role: 'agent', placeholderTokenHash: 'x', ttlMs: 60_000 });
    expect(result.outcome).not.toBe('created');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM invitations').first('n')).toBe(0);
  });

  it('accepts once, creating the account as verified. A second attempt changes nothing', async () => {
    await invite('new@x.test');
    const account = { name: 'New', passwordHash: 'first-hash' };
    expect(await acceptInvitation(db(), { tokenHash: 'hash-new@x.test', account })).toEqual({ workspaceId: 'w1' });
    const user = await env.DB.prepare(`SELECT id, password_hash AS h, email_verified_at AS v FROM users WHERE email = 'new@x.test'`).first<{ id: string; h: string; v: number }>();
    expect(user!.h).toBe('first-hash');
    expect(user!.v).toBeGreaterThan(0);

    await env.DB.prepare(`DELETE FROM workspace_members WHERE user_id = ?1`).bind(user!.id).run();
    expect(await acceptInvitation(db(), { tokenHash: 'hash-new@x.test', account: { name: 'Thief', passwordHash: 'second-hash' } })).toBeNull();
    const after = await env.DB.prepare(`SELECT password_hash AS h, name FROM users WHERE id = ?1`).bind(user!.id).first();
    expect(after).toEqual({ h: 'first-hash', name: 'New' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?1`).bind(user!.id).first('n')).toBe(0);
  });

  it('never changes an existing account, even if a name and password are passed in', async () => {
    await invite('other@x.test');
    expect(await inspectInvitation(db(), 'hash-other@x.test')).toEqual({ accountExists: true });
    expect(await acceptInvitation(db(), { tokenHash: 'hash-other@x.test', account: { name: 'Attacker', passwordHash: 'attacker' } })).toEqual({ workspaceId: 'w1' });
    expect(await env.DB.prepare(`SELECT password_hash AS h, name FROM users WHERE id = 'other'`).first()).toEqual({ h: 'keep', name: 'Other' });
    expect(await env.DB.prepare(`SELECT role FROM workspace_members WHERE workspace_id = 'w1' AND user_id = 'other'`).first('role')).toBe('agent');
  });

  it('refuses a new address with no account details, and leaves the invitation usable', async () => {
    await invite('new@x.test');
    expect(await acceptInvitation(db(), { tokenHash: 'hash-new@x.test', account: null })).toBeNull();
    expect(await inspectInvitation(db(), 'hash-new@x.test')).toEqual({ accountExists: false });
  });

  it('refuses an expired invitation', async () => {
    await invite('new@x.test');
    await env.DB.prepare('UPDATE invitations SET expires_at = 1').run();
    expect(await inspectInvitation(db(), 'hash-new@x.test')).toBeNull();
    expect(await acceptInvitation(db(), { tokenHash: 'hash-new@x.test', account: { name: 'N', passwordHash: 'h' } })).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'new@x.test'`).first('n')).toBe(0);
  });

  it('gives a new token on sending, and the old one stops working', async () => {
    const created = await invite('new@x.test');
    if (created.outcome !== 'created') throw new Error('expected an invitation');
    const data = await prepareInvitationEmail(db(), { workspaceId: 'w1', invitationId: created.invitation.id, tokenHash: 'sent' });
    expect(data).toEqual({ email: 'new@x.test', role: 'agent', workspaceName: 'One', inviterName: 'Owner' });
    expect(await inspectInvitation(db(), 'hash-new@x.test')).toBeNull();
    expect(await inspectInvitation(db(), 'sent')).not.toBeNull();
  });

  it('prepares nothing for another workspace’s invitation, or one already accepted', async () => {
    const created = await invite('other@x.test');
    if (created.outcome !== 'created') throw new Error('expected an invitation');
    expect(await prepareInvitationEmail(db(), { workspaceId: 'w2', invitationId: created.invitation.id, tokenHash: 'a' })).toBeNull();
    await acceptInvitation(db(), { tokenHash: 'hash-other@x.test', account: null });
    expect(await prepareInvitationEmail(db(), { workspaceId: 'w1', invitationId: created.invitation.id, tokenHash: 'b' })).toBeNull();
  });
});

describe('createWorkspace', () => {
  it('is refused for a non-owner on an invite-only installation', async () => {
    expect(await createWorkspace(db(), { userId: 'agent', name: 'Mine', slug: 'mine' })).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE slug = 'mine'`).first('n')).toBe(0);
  });

  it('is allowed for an existing owner, who owns the new workspace', async () => {
    const created = await createWorkspace(db(), { userId: 'owner', name: 'Mine', slug: 'mine' });
    expect(created).toMatchObject({ name: 'Mine', slug: 'mine' });
    expect((await context('owner', created!.id)).role).toBe('owner');
  });

  it('is allowed for anyone when signup is open', async () => {
    await env.DB.prepare(`UPDATE installation SET signup_policy = 'open'`).run();
    expect(await createWorkspace(db(), { userId: 'agent', name: 'Mine', slug: 'mine' })).not.toBeNull();
  });
});

describe('deleteAccount', () => {
  it('refuses the last active owner, changing nothing', async () => {
    expect(await deleteAccount(db(), 'owner')).toBe(false);
    expect(await env.DB.prepare(`SELECT email FROM users WHERE id = 'owner'`).first('email')).toBe('owner@x.test');
    expect(await roleOf('m_owner')).toBe('owner');
  });

  it('anonymises, removes memberships and tokens, and ends sessions', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, client_type, created_at, last_used_at, expires_at) VALUES ('s', 'agent', 'r', 'mobile', 1, 1, 9999999999999)`),
      env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ('t', 'agent', 'password_reset', 9999999999999)`),
    ]);
    expect(await deleteAccount(db(), 'agent')).toBe(true);
    const user = await env.DB.prepare(`SELECT email, name, password_hash AS h, disabled_at AS d FROM users WHERE id = 'agent'`).first<{ email: string; name: string; h: string; d: number }>();
    expect(user).toMatchObject({ name: 'Deleted user', h: '!' });
    expect(user!.email).toBe('deleted-agent@deleted.invalid');
    expect(user!.d).toBeGreaterThan(0);
    expect(await roleOf('m_agent')).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens').first('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT revoked_at AS r FROM auth_sessions WHERE id = 's'`).first('r')).toBeGreaterThan(0);
  });

  it('allows an owner when another active owner remains', async () => {
    await addSecondOwner();
    expect(await deleteAccount(db(), 'owner')).toBe(true);
  });
});
