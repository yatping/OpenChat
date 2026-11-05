/**
 * Installation admins manage people across workspaces, so these queries have no tenant scope. They touch
 * accounts and memberships, and never conversations, contacts, or messages. Being an admin gives no way to read
 * a workspace: that needs a membership, and adding one is audited. See ADR-0015. In each batch the audit row is
 * written first, under the conditions that decide the action, and later statements check that it exists.
 */
import { newId } from '@openchat/shared';
import type { Role } from './context';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import { removeMembershipStatements } from './internal/member-statements';

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
  | { outcome: 'last_owner' }
  | { outcome: 'last_admin' }
  | { outcome: 'forbidden' };

const PERSON_SELECT = `SELECT u.id, u.name, u.email, u.is_installation_admin AS isAdmin, u.disabled_at IS NOT NULL AS deactivated,
    (SELECT json_group_array(json_object('memberId', m.id, 'workspaceId', w.id, 'workspaceName', w.name, 'role', m.role,
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

/** Whether the user is the only working owner of a workspace. Someone deactivated cannot act as an owner. */
const isOnlyOwner = (user: string, workspaceFilter = '') => `EXISTS (
  SELECT 1 FROM workspace_members m
   WHERE m.user_id = ${user} AND m.role = 'owner' AND m.status = 'active' ${workspaceFilter}
     AND NOT EXISTS (SELECT 1 FROM workspace_members o JOIN users ou ON ou.id = o.user_id
                      WHERE o.workspace_id = m.workspace_id AND o.id <> m.id AND o.role = 'owner' AND o.status = 'active' AND ou.disabled_at IS NULL))`;

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
              WHERE u.id = ?3 AND u.disabled_at IS NULL AND ${actorIsAdmin('?2')} AND NOT ${isOnlyOwner('u.id')}`,
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
      return (await authorizeInstallationAdmin(database, actor)) ? { outcome: 'last_owner' } : { outcome: 'forbidden' };
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
              WHERE u.id = ?3 AND w.id = ?4 AND u.disabled_at IS NULL AND ${actorIsAdmin('?2')}
                AND (?5 = 'owner' OR NOT ${isOnlyOwner('u.id', 'AND m.workspace_id = w.id')})`,
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
      return person.deactivated ? { outcome: 'deactivated' } : { outcome: 'last_owner' };
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
              WHERE t.workspace_id = ?3 AND t.id = ?4 AND ${actorIsAdmin('?2')}
                AND NOT ${isOnlyOwner('t.user_id', 'AND m.workspace_id = t.workspace_id')}`,
          )
          .bind(audit, actor, workspaceId, member.id),
        ...removeMembershipStatements(d1, workspaceId, member.id, audit),
      ]);
      if (allowed?.meta.changes === 1) return done(userId);
      return (await authorizeInstallationAdmin(database, actor)) ? { outcome: 'last_owner' } : { outcome: 'forbidden' };
    },
  };
}
