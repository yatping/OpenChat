/**
 * Installation admins manage people, workspaces, and websites, so these queries have no tenant scope of their
 * own. They never touch conversations, contacts, or messages. Being an admin gives no way to read those: that
 * needs a membership, and adding one is audited. See ADR-0015 and ADR-0016. In each batch the audit row is
 * written first, under the conditions that decide the action, and later statements check that it exists.
 */
import { newId } from '@openchat/shared';
import type { Role } from './context';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import { removeMembershipStatements } from './internal/member-statements';
import { effectiveRole } from './internal/roles';
import { toWebsite, WEBSITE_COLUMNS, type RawWebsite, type WebsiteRow, type WorkspaceRow } from './repositories';

declare const adminBrand: unique symbol;

/** Proof that the user was an active installation admin. It cannot be constructed outside this file. */
export interface AdminContext {
  readonly userId: string;
  readonly [adminBrand]: true;
}

export async function authorizeInstallationAdmin(database: Database, userId: string): Promise<AdminContext | null> {
  const row = await rawHandle(database)
    .prepare(`SELECT id FROM users WHERE id = ?1 AND is_installation_admin = 1 AND disabled_at IS NULL`)
    .bind(userId)
    .first<{ id: string }>();
  return row ? ({ userId: row.id } as AdminContext) : null;
}

export interface PersonMembership {
  memberId: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  status: 'active' | 'suspended' | 'removed';
}

export interface PersonRow {
  id: string;
  name: string;
  email: string;
  isInstallationAdmin: boolean;
  deactivated: boolean;
  memberships: PersonMembership[];
}

export type PersonChange =
  | { outcome: 'done'; person: PersonRow }
  | { outcome: 'not_found' }
  | { outcome: 'email_taken' }
  | { outcome: 'self' }
  | { outcome: 'deactivated' }
  | { outcome: 'last_admin' }
  | { outcome: 'forbidden' };

const PERSON_SELECT = `SELECT u.id, u.name, u.email, u.is_installation_admin AS isAdmin, u.disabled_at IS NOT NULL AS deactivated,
    (SELECT json_group_array(json_object('memberId', m.id, 'workspaceId', w.id, 'workspaceName', w.name, 'role', ${effectiveRole('m')},
                                         'status', CASE WHEN m.removed_at IS NOT NULL THEN 'removed' ELSE m.status END))
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id) AS membershipsJson
  FROM users u`;

interface RawPerson {
  id: string;
  name: string;
  email: string;
  isAdmin: number;
  deactivated: number;
  membershipsJson: string;
}

const toPerson = (row: RawPerson): PersonRow => ({
  id: row.id,
  name: row.name,
  email: row.email,
  isInstallationAdmin: row.isAdmin === 1,
  deactivated: row.deactivated === 1,
  memberships: JSON.parse(row.membershipsJson) as PersonMembership[],
});

/** Checked at commit, because an admin may lose the role after this request was authorised. */
const actorIsAdmin = (actor: string) => `EXISTS (SELECT 1 FROM users a WHERE a.id = ${actor} AND a.is_installation_admin = 1 AND a.disabled_at IS NULL)`;

const WORKSPACE_COLUMNS = `id, name, slug, created_at AS createdAt`;

const otherAdminExists = (user: string) => `EXISTS (SELECT 1 FROM users o WHERE o.id <> ${user} AND o.is_installation_admin = 1 AND o.disabled_at IS NULL)`;

export function adminRepository(database: Database, ctx: AdminContext) {
  const d1 = rawHandle(database);
  const actor = ctx.userId;

  const get = async (userId: string): Promise<PersonRow | null> => {
    const row = await d1.prepare(`${PERSON_SELECT} WHERE u.id = ?1`).bind(userId).first<RawPerson>();
    return row ? toPerson(row) : null;
  };

  const done = async (userId: string): Promise<PersonChange> => {
    const person = await get(userId);
    return person ? { outcome: 'done', person } : { outcome: 'not_found' };
  };

  return {
    get,

    async list(input: { cursor?: string | undefined; limit: number }): Promise<{ data: PersonRow[]; nextCursor: string | null }> {
      const { results } = await d1.prepare(`${PERSON_SELECT} WHERE u.id > ?1 ORDER BY u.id LIMIT ?2`).bind(input.cursor ?? '', input.limit + 1).all<RawPerson>();
      const data = results.slice(0, input.limit).map(toPerson);
      return { data, nextCursor: results.length > input.limit ? (data.at(-1)?.id ?? null) : null };
    },

    async listWorkspaces(input: { cursor?: string | undefined; limit: number }): Promise<{ data: { id: string; name: string }[]; nextCursor: string | null }> {
      const { results } = await d1.prepare(`SELECT id, name FROM workspaces WHERE id > ?1 ORDER BY id LIMIT ?2`).bind(input.cursor ?? '', input.limit + 1).all<{ id: string; name: string }>();
      const data = results.slice(0, input.limit);
      return { data, nextCursor: results.length > input.limit ? (data.at(-1)?.id ?? null) : null };
    },

    /** The password hash is unusable until the person follows the emailed link, as for the first owner. */
    async create(input: { name: string; email: string }): Promise<PersonChange> {
      const audit = newId('audit');
      const userId = newId('user');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, NULL, 'user', ?2, 'person.created', 'user', ?3, ${DB_NOW_MS}
              WHERE ${actorIsAdmin('?2')} AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?4)`,
          )
          .bind(audit, actor, userId, input.email),
        d1
          .prepare(
            `INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
             SELECT ?1, ?2, ?3, '!', ${DB_NOW_MS}, ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?4)`,
          )
          .bind(userId, input.email, input.name, audit),
      ]);
      if (allowed?.meta.changes !== 1) return (await authorizeInstallationAdmin(database, actor)) ? { outcome: 'email_taken' } : { outcome: 'forbidden' };
      return done(userId);
    },

    async setAdmin(userId: string, isAdmin: boolean): Promise<PersonChange> {
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
             SELECT ?1, NULL, 'user', ?2, 'person.admin_changed', 'user', u.id, json_object('isInstallationAdmin', ?4), ${DB_NOW_MS}
               FROM users u
              WHERE u.id = ?3 AND ${actorIsAdmin('?2')} AND (?4 = 1 OR ${otherAdminExists('u.id')})`,
          )
          .bind(audit, actor, userId, isAdmin ? 1 : 0),
        d1
          .prepare(`UPDATE users SET is_installation_admin = ?1, updated_at = ${DB_NOW_MS} WHERE id = ?2 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`)
          .bind(isAdmin ? 1 : 0, userId, audit),
      ]);
      if (allowed?.meta.changes === 1) return done(userId);
      if (!(await get(userId))) return { outcome: 'not_found' };
      return (await authorizeInstallationAdmin(database, actor)) ? { outcome: 'last_admin' } : { outcome: 'forbidden' };
    },

    /** Memberships stay as they are, so reactivating restores them. What it ends is every way in. */
    async deactivate(userId: string): Promise<PersonChange> {
      if (userId === actor) return { outcome: 'self' };
      const audit = newId('audit');
      const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`;
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, NULL, 'user', ?2, 'person.deactivated', 'user', u.id, ${DB_NOW_MS}
               FROM users u
              WHERE u.id = ?3 AND u.disabled_at IS NULL AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, userId),
        d1
          .prepare(
            `UPDATE conversations SET assigned_member_id = NULL, version = version + 1, updated_at = ${DB_NOW_MS}
              WHERE ${guard} AND assigned_member_id IN (SELECT id FROM workspace_members WHERE user_id = ?2)`,
          )
          .bind(audit, userId),
        // So that open sockets close even if the isolate dies right after the commit.
        d1
          .prepare(
            `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
             SELECT ?3 || '_' || id, workspace_id, 'member.access_changed', id, json_object('memberId', id), ${DB_NOW_MS}
               FROM workspace_members WHERE ${guard} AND user_id = ?2`,
          )
          .bind(audit, userId, newId('outbox')),
        d1
          .prepare(`DELETE FROM push_subscriptions WHERE ${guard} AND member_id IN (SELECT id FROM workspace_members WHERE user_id = ?2)`)
          .bind(audit, userId),
        d1.prepare(`DELETE FROM auth_tokens WHERE ${guard} AND user_id = ?2`).bind(audit, userId),
        d1.prepare(`UPDATE auth_sessions SET revoked_at = ${DB_NOW_MS} WHERE ${guard} AND user_id = ?2 AND revoked_at IS NULL`).bind(audit, userId),
        d1.prepare(`UPDATE users SET disabled_at = ${DB_NOW_MS}, updated_at = ${DB_NOW_MS} WHERE ${guard} AND id = ?2`).bind(audit, userId),
      ]);
      if (allowed?.meta.changes === 1) return done(userId);
      const person = await get(userId);
      if (!person) return { outcome: 'not_found' };
      if (person.deactivated) return { outcome: 'done', person };
      return { outcome: 'forbidden' };
    },

    async reactivate(userId: string): Promise<PersonChange> {
      const audit = newId('audit');
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, NULL, 'user', ?2, 'person.reactivated', 'user', u.id, ${DB_NOW_MS}
               FROM users u WHERE u.id = ?3 AND u.disabled_at IS NOT NULL AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, userId),
        d1.prepare(`UPDATE users SET disabled_at = NULL, updated_at = ${DB_NOW_MS} WHERE id = ?1 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)`).bind(userId, audit),
      ]);
      if (!(await authorizeInstallationAdmin(database, actor))) return { outcome: 'forbidden' };
      return done(userId);
    },

    /** Adds a member, or changes one, including bringing back someone removed, whose member ID stays the same. */
    async assign(userId: string, workspaceId: string, role: Role): Promise<PersonChange> {
      const audit = newId('audit');
      const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`;
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
             SELECT ?1, w.id, 'user', ?2, 'person.assigned', 'user', u.id, json_object('role', ?5), ${DB_NOW_MS}
               FROM users u, workspaces w
              WHERE u.id = ?3 AND w.id = ?4 AND u.disabled_at IS NULL AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, userId, workspaceId, role),
        d1
          .prepare(
            `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
             SELECT ?2, ?3, ?4, ?5, 'active', ${DB_NOW_MS}, ${DB_NOW_MS} WHERE ${guard}
             ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role, status = 'active', removed_at = NULL, updated_at = excluded.updated_at`,
          )
          .bind(audit, newId('member'), workspaceId, userId, role),
        d1
          .prepare(
            `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
             SELECT ?2, workspace_id, 'member.access_changed', id, json_object('memberId', id), ${DB_NOW_MS}
               FROM workspace_members WHERE ${guard} AND workspace_id = ?3 AND user_id = ?4`,
          )
          .bind(audit, newId('outbox'), workspaceId, userId),
      ]);
      if (allowed?.meta.changes === 1) return done(userId);
      const person = await get(userId);
      const workspace = await d1.prepare(`SELECT id FROM workspaces WHERE id = ?1`).bind(workspaceId).first();
      if (!person || !workspace) return { outcome: 'not_found' };
      if (!(await authorizeInstallationAdmin(database, actor))) return { outcome: 'forbidden' };
      return person.deactivated ? { outcome: 'deactivated' } : { outcome: 'forbidden' };
    },

    async unassign(userId: string, workspaceId: string): Promise<PersonChange> {
      const member = await d1.prepare(`SELECT id FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2`).bind(workspaceId, userId).first<{ id: string }>();
      if (!member) return { outcome: 'not_found' };
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, t.workspace_id, 'user', ?2, 'person.unassigned', 'member', t.id, ${DB_NOW_MS}
               FROM workspace_members t
              WHERE t.workspace_id = ?3 AND t.id = ?4 AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, workspaceId, member.id),
        ...removeMembershipStatements(d1, workspaceId, member.id, audit),
      ]);
      if (allowed?.meta.changes === 1) return done(userId);
      return { outcome: 'forbidden' };
    },

    /** Nobody joins it by creating it. Reading its conversations takes a separate, audited assignment. */
    async createWorkspace(input: { name: string; slug: string }): Promise<WorkspaceRow | null> {
      const id = newId('workspace');
      const [inserted] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
             SELECT ?1, ?2, ?3, ${DB_NOW_MS}, ${DB_NOW_MS} WHERE ${actorIsAdmin('?4')}`,
          )
          .bind(id, input.name, input.slug, actor),
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, w.id, 'user', ?2, 'workspace.created', 'workspace', w.id, ${DB_NOW_MS} FROM workspaces w WHERE w.id = ?3`,
          )
          .bind(newId('audit'), actor, id),
      ]);
      return inserted?.meta.changes === 1 ? d1.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1`).bind(id).first<WorkspaceRow>() : null;
    },

    async updateWorkspace(workspaceId: string, input: { name?: string | undefined }): Promise<WorkspaceRow | null> {
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, w.id, 'user', ?2, 'workspace.updated', 'workspace', w.id, ${DB_NOW_MS} FROM workspaces w WHERE w.id = ?3 AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, workspaceId),
        d1
          .prepare(`UPDATE workspaces SET name = COALESCE(?1, name), updated_at = ${DB_NOW_MS} WHERE id = ?2 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`)
          .bind(input.name ?? null, workspaceId, audit),
      ]);
      return allowed?.meta.changes === 1 ? d1.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1`).bind(workspaceId).first<WorkspaceRow>() : null;
    },

    /** Null if the workspace does not exist. */
    async listWebsites(workspaceId: string): Promise<WebsiteRow[] | null> {
      const workspace = await d1.prepare(`SELECT id FROM workspaces WHERE id = ?1`).bind(workspaceId).first();
      if (!workspace) return null;
      const { results } = await d1.prepare(`SELECT ${WEBSITE_COLUMNS} FROM websites WHERE workspace_id = ?1 ORDER BY id`).bind(workspaceId).all<RawWebsite>();
      return results.map(toWebsite);
    },

    async createWebsite(workspaceId: string, input: { name: string; websiteKey: string; allowedOrigins: string[]; settings?: Record<string, unknown> | undefined }): Promise<WebsiteRow | null> {
      const audit = newId('audit');
      const id = newId('website');
      const settings = input.settings ?? {};
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, w.id, 'user', ?2, 'website.created', 'website', ?4, ${DB_NOW_MS} FROM workspaces w WHERE w.id = ?3 AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, workspaceId, id),
        d1
          .prepare(
            `INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ${DB_NOW_MS}, ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?7)`,
          )
          .bind(id, workspaceId, input.name, input.websiteKey, JSON.stringify(input.allowedOrigins), JSON.stringify(settings), audit),
      ]);
      return allowed?.meta.changes === 1 ? { id, name: input.name, websiteKey: input.websiteKey, allowedOrigins: input.allowedOrigins, settings } : null;
    },

    /** The workspace is part of the match, so a website named under the wrong workspace is not found. */
    async updateWebsite(
      workspaceId: string,
      websiteId: string,
      input: { name?: string | undefined; allowedOrigins?: string[] | undefined; settings?: Record<string, unknown> | undefined },
    ): Promise<WebsiteRow | null> {
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, s.workspace_id, 'user', ?2, 'website.updated', 'website', s.id, ${DB_NOW_MS}
               FROM websites s WHERE s.workspace_id = ?3 AND s.id = ?4 AND ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, workspaceId, websiteId),
        d1
          .prepare(
            `UPDATE websites SET name = COALESCE(?1, name), allowed_origins_json = COALESCE(?2, allowed_origins_json),
                                 settings_json = COALESCE(?3, settings_json), updated_at = ${DB_NOW_MS}
              WHERE workspace_id = ?4 AND id = ?5 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?6)`,
          )
          .bind(input.name ?? null, input.allowedOrigins ? JSON.stringify(input.allowedOrigins) : null, input.settings ? JSON.stringify(input.settings) : null, workspaceId, websiteId, audit),
      ]);
      if (allowed?.meta.changes !== 1) return null;
      const row = await d1.prepare(`SELECT ${WEBSITE_COLUMNS} FROM websites WHERE workspace_id = ?1 AND id = ?2`).bind(workspaceId, websiteId).first<RawWebsite>();
      return row ? toWebsite(row) : null;
    },

    /** What push looks like to an admin. Never the key, which stays a Worker secret. */
    async relayState(): Promise<{ registeredId: string | null; disconnectedId: string | null; subscriptions: number }> {
      const row = await d1
        .prepare(`SELECT relay_registered_id AS registeredId, relay_disconnected_id AS disconnectedId, (SELECT count(*) FROM push_subscriptions) AS subscriptions FROM installation`)
        .first<{ registeredId: string | null; disconnectedId: string | null; subscriptions: number }>();
      return row ?? { registeredId: null, disconnectedId: null, subscriptions: 0 };
    },

    /**
     * Turns push off for this relay before the relay is asked to erase anything, so that no phone can register the
     * installation again in between. The handles are useless once the relay has erased them, so they go too.
     * False if the caller is no longer an admin at commit.
     */
    async disconnectRelay(relayId: string): Promise<boolean> {
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, NULL, 'user', ?2, 'relay.disconnected', 'relay', ?3, ${DB_NOW_MS} WHERE ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor, relayId),
        d1.prepare(`UPDATE installation SET relay_disconnected_id = ?1, relay_registered_id = NULL, updated_at = ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)`).bind(relayId, audit),
        d1.prepare(`UPDATE workspaces SET relay_workspace_status = 'unregistered' WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`).bind(audit),
        d1.prepare(`DELETE FROM push_subscriptions WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`).bind(audit),
      ]);
      return allowed?.meta.changes === 1;
    },

    /** Push comes back. Phones register the installation again the next time they ask for a grant. */
    async reconnectRelay(): Promise<boolean> {
      const audit = newId('audit');
      const [allowed] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
             SELECT ?1, NULL, 'user', ?2, 'relay.reconnected', 'relay', (SELECT relay_disconnected_id FROM installation), ${DB_NOW_MS} WHERE ${actorIsAdmin('?2')}`,
          )
          .bind(audit, actor),
        d1.prepare(`UPDATE installation SET relay_disconnected_id = NULL, updated_at = ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`).bind(audit),
      ]);
      return allowed?.meta.changes === 1;
    },
  };
}
