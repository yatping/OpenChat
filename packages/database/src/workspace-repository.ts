/**
 * Operations that span workspaces, or that happen before a member exists, so no WorkspaceContext can be
 * proved. Each filters on an ID the caller already holds: its own user, a hashed token, or a job's IDs.
 * In these batches the audit row is written first, under the conditions that decide the action, and later
 * statements check that it exists. See docs/architecture/data-model.md#write-patterns.
 */
import { newId } from '@openchat/shared';
import type { Role } from './context';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}

const WORKSPACE_COLUMNS = `id, name, slug, created_at AS createdAt`;

/** Null if the signup policy refuses. Invite-only allows only someone who already owns a workspace. */
export async function createWorkspace(database: Database, input: { userId: string; name: string; slug: string }): Promise<WorkspaceRow | null> {
  const d1 = rawHandle(database);
  const id = newId('workspace');
  const memberId = newId('member');
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
         SELECT ?1, ?2, ?3, ${DB_NOW_MS}, ${DB_NOW_MS}
          WHERE EXISTS (SELECT 1 FROM installation WHERE signup_policy = 'open')
             OR EXISTS (SELECT 1 FROM workspace_members WHERE user_id = ?4 AND role = 'owner' AND status = 'active')`,
      )
      .bind(id, input.name, input.slug, input.userId),
    d1
      .prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
         SELECT ?1, w.id, ?2, 'owner', 'active', ${DB_NOW_MS}, ${DB_NOW_MS} FROM workspaces w WHERE w.id = ?3`,
      )
      .bind(memberId, input.userId, id),
    d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
         SELECT ?1, w.id, 'member', ?2, 'workspace.created', 'workspace', w.id, ${DB_NOW_MS} FROM workspaces w WHERE w.id = ?3`,
      )
      .bind(newId('audit'), memberId, id),
  ]);
  if (inserted?.meta.changes !== 1) return null;
  return d1.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1`).bind(id).first<WorkspaceRow>();
}

/**
 * Anonymises rather than deletes, because messages keep their authors. Refused for the last active owner of
 * any workspace, which is decided in the first statement. False means refused.
 */
export async function deleteAccount(database: Database, userId: string): Promise<boolean> {
  const d1 = rawHandle(database);
  const audit = newId('audit');
  const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`;
  const [allowed] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
         SELECT ?1, NULL, 'user', u.id, 'account.deleted', 'user', u.id, ${DB_NOW_MS}
           FROM users u
          WHERE u.id = ?2 AND u.disabled_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workspace_members m
               WHERE m.user_id = u.id AND m.role = 'owner' AND m.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM workspace_members o
                                  WHERE o.workspace_id = m.workspace_id AND o.id <> m.id AND o.role = 'owner' AND o.status = 'active'))`,
      )
      .bind(audit, userId),
    d1
      .prepare(
        `UPDATE conversations SET assigned_member_id = NULL, version = version + 1, updated_at = ${DB_NOW_MS}
          WHERE ${guard} AND assigned_member_id IN (SELECT id FROM workspace_members WHERE user_id = ?2)`,
      )
      .bind(audit, userId),
    // Before the members go, so that their sockets can be found and closed. Swept within about two minutes.
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?3 || '_' || id, workspace_id, 'member.access_changed', id, json_object('memberId', id), ${DB_NOW_MS}
           FROM workspace_members WHERE ${guard} AND user_id = ?2`,
      )
      .bind(audit, userId, newId('outbox')),
    d1.prepare(`DELETE FROM workspace_members WHERE ${guard} AND user_id = ?2`).bind(audit, userId),
    d1.prepare(`DELETE FROM auth_tokens WHERE ${guard} AND user_id = ?2`).bind(audit, userId),
    d1.prepare(`UPDATE auth_sessions SET revoked_at = ${DB_NOW_MS} WHERE ${guard} AND user_id = ?2 AND revoked_at IS NULL`).bind(audit, userId),
    d1
      .prepare(
        `UPDATE users SET email = 'deleted-' || id || '@deleted.invalid', name = 'Deleted user', password_hash = '!',
                          email_verified_at = NULL, disabled_at = ${DB_NOW_MS}, updated_at = ${DB_NOW_MS}
          WHERE ${guard} AND id = ?2`,
      )
      .bind(audit, userId),
  ]);
  return allowed?.meta.changes === 1;
}

/** Only so that a new account's password is hashed when it is needed. acceptInvitation still decides. */
export async function inspectInvitation(database: Database, tokenHash: string): Promise<{ accountExists: boolean } | null> {
  const row = await rawHandle(database)
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email) AS accountExists
         FROM invitations i WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.expires_at > ${DB_NOW_MS}`,
    )
    .bind(tokenHash)
    .first<{ accountExists: number }>();
  return row ? { accountExists: row.accountExists === 1 } : null;
}

/**
 * The token was emailed to the address, so holding it proves control of that address, and joining needs no
 * password. An existing account's name and password are never changed, however the caller got here.
 */
export async function acceptInvitation(
  database: Database,
  input: { tokenHash: string; account: { name: string; passwordHash: string } | null },
): Promise<{ workspaceId: string } | null> {
  const d1 = rawHandle(database);
  const audit = newId('audit');
  const memberId = newId('member');
  const invitation = `SELECT * FROM invitations WHERE token_hash = ?2 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`;
  const [accepted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, created_at)
         SELECT ?1, i.workspace_id, 'invitation', i.id, 'invitation.accepted', 'member', ?3, ${DB_NOW_MS}
           FROM invitations i
          WHERE i.token_hash = ?2 AND i.accepted_at IS NULL AND i.expires_at > ${DB_NOW_MS}
            AND (?4 = 1 OR EXISTS (SELECT 1 FROM users u WHERE u.email = i.email))`,
      )
      .bind(audit, input.tokenHash, memberId, input.account ? 1 : 0),
    d1
      .prepare(`UPDATE invitations SET accepted_at = ${DB_NOW_MS} WHERE token_hash = ?2 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`)
      .bind(audit, input.tokenHash),
    d1
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at, updated_at)
         SELECT ?3, i.email, ?4, ?5, ${DB_NOW_MS}, ${DB_NOW_MS}, ${DB_NOW_MS} FROM (${invitation}) i
          WHERE ?5 IS NOT NULL
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(audit, input.tokenHash, newId('user'), input.account?.name ?? null, input.account?.passwordHash ?? null),
    d1
      .prepare(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ${DB_NOW_MS}), updated_at = ${DB_NOW_MS}
          WHERE email = (SELECT email FROM (${invitation}))`,
      )
      .bind(audit, input.tokenHash),
    d1
      .prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
         SELECT ?3, i.workspace_id, u.id, i.role, 'active', ${DB_NOW_MS}, ${DB_NOW_MS}
           FROM (${invitation}) i JOIN users u ON u.email = i.email
          WHERE true
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      )
      .bind(audit, input.tokenHash, memberId),
  ]);
  if (accepted?.meta.changes !== 1) return null;
  return d1.prepare(`SELECT workspace_id AS workspaceId FROM invitations WHERE token_hash = ?1`).bind(input.tokenHash).first<{ workspaceId: string }>();
}

export interface InvitationEmailData {
  email: string;
  role: Exclude<Role, 'owner'>;
  workspaceName: string;
  inviterName: string;
}

/** Gives a pending invitation a new token as its email is sent, so no token reaches a queue. */
export async function prepareInvitationEmail(
  database: Database,
  input: { workspaceId: string; invitationId: string; tokenHash: string },
): Promise<InvitationEmailData | null> {
  const d1 = rawHandle(database);
  const [rotated, selected] = await d1.batch([
    d1
      .prepare(`UPDATE invitations SET token_hash = ?1 WHERE workspace_id = ?2 AND id = ?3 AND accepted_at IS NULL AND expires_at > ${DB_NOW_MS}`)
      .bind(input.tokenHash, input.workspaceId, input.invitationId),
    d1
      .prepare(
        `SELECT i.email, i.role, w.name AS workspaceName, u.name AS inviterName
           FROM invitations i
           JOIN workspaces w ON w.id = i.workspace_id
           JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.id = i.invited_by_member_id
           JOIN users u ON u.id = m.user_id
          WHERE i.workspace_id = ?1 AND i.id = ?2 AND i.token_hash = ?3`,
      )
      .bind(input.workspaceId, input.invitationId, input.tokenHash),
  ]);
  if (rotated?.meta.changes !== 1) return null;
  return (selected?.results[0] as InvitationEmailData | undefined) ?? null;
}
