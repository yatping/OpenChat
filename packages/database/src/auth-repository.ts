/**
 * Account and session data. Users span workspaces, so nothing here takes a WorkspaceContext, and nothing
 * here touches workspace data apart from the caller's own memberships. Decisions that must hold at commit
 * are made in SQL. See docs/architecture/data-model.md#write-patterns.
 */
import { newId } from '@openchat/shared';
import type { Role } from './context';
import { effectiveRole } from './internal/roles';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

export type ClientType = 'dashboard' | 'mobile';
export type AuthTokenPurpose = 'password_reset' | 'email_verification';

export const SESSION_TTL_MS: Record<ClientType, number> = {
  dashboard: 30 * 24 * 60 * 60 * 1000,
  mobile: 90 * 24 * 60 * 60 * 1000,
};

export interface LoginRow {
  id: string;
  passwordHash: string;
  disabledAt: number | null;
}

export function findUserForLogin(database: Database, email: string): Promise<LoginRow | null> {
  return rawHandle(database)
    .prepare(`SELECT id, password_hash AS passwordHash, disabled_at AS disabledAt FROM users WHERE email = ?1`)
    .bind(email)
    .first<LoginRow>();
}

export async function findActiveUserId(database: Database, email: string): Promise<string | null> {
  const row = await rawHandle(database)
    .prepare(`SELECT id FROM users WHERE email = ?1 AND disabled_at IS NULL`)
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export function getUserContact(database: Database, userId: string): Promise<{ email: string; name: string } | null> {
  return rawHandle(database)
    .prepare(`SELECT email, name FROM users WHERE id = ?1 AND disabled_at IS NULL`)
    .bind(userId)
    .first<{ email: string; name: string }>();
}

/** Replaces a hash only if it is still the one that was checked, so a concurrent reset wins. */
export async function upgradePasswordHash(database: Database, userId: string, checkedHash: string, newHash: string): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE users SET password_hash = ?1, updated_at = ${DB_NOW_MS} WHERE id = ?2 AND password_hash = ?3`)
    .bind(newHash, userId, checkedHash)
    .run();
}

export async function createSession(
  database: Database,
  input: { userId: string; refreshTokenHash: string; clientType: ClientType; clientLabel: string | null },
): Promise<string> {
  const id = newId('session');
  await rawHandle(database)
    .prepare(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, client_type, client_label, created_at, last_used_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ${DB_NOW_MS}, ${DB_NOW_MS}, ${DB_NOW_MS} + ?6)`,
    )
    .bind(id, input.userId, input.refreshTokenHash, input.clientType, input.clientLabel, SESSION_TTL_MS[input.clientType])
    .run();
  return id;
}

export type RotateResult =
  | { outcome: 'rotated'; sessionId: string; userId: string; clientType: ClientType }
  | { outcome: 'reused' }
  | { outcome: 'invalid' };

/**
 * Rotation and reuse detection in one batch. A token that matches a session's previous hash, and did not
 * just rotate it, was presented twice. One of those parties may be a thief and we cannot tell which, so
 * the session is revoked. Only one generation back is kept, and an older token simply fails.
 */
export async function rotateRefreshToken(database: Database, presentedHash: string, newHash: string): Promise<RotateResult> {
  const d1 = rawHandle(database);
  const [rotated, , revoked] = await d1.batch([
    d1
      .prepare(
        `UPDATE auth_sessions
            SET refresh_token_hash = ?1,
                previous_token_hash = ?2,
                last_used_at = ${DB_NOW_MS},
                expires_at = ${DB_NOW_MS} + CASE client_type WHEN 'mobile' THEN ?3 ELSE ?4 END
          WHERE refresh_token_hash = ?2
            AND revoked_at IS NULL
            AND expires_at > ${DB_NOW_MS}
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = auth_sessions.user_id AND u.disabled_at IS NULL)
        RETURNING id AS sessionId, user_id AS userId, client_type AS clientType`,
      )
      .bind(newHash, presentedHash, SESSION_TTL_MS.mobile, SESSION_TTL_MS.dashboard),
    // Reuse means a token is stolen, so sockets close too. Before the revoke below, while the same condition finds it.
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?3 || '_' || m.id, m.workspace_id, 'member.access_changed', m.id, json_object('memberId', m.id), ${DB_NOW_MS}
           FROM workspace_members m
          WHERE m.user_id IN (SELECT user_id FROM auth_sessions WHERE previous_token_hash = ?1 AND refresh_token_hash <> ?2 AND revoked_at IS NULL)`,
      )
      .bind(presentedHash, newHash, crypto.randomUUID()),
    d1
      .prepare(
        `UPDATE auth_sessions SET revoked_at = ${DB_NOW_MS}
          WHERE previous_token_hash = ?1 AND refresh_token_hash <> ?2 AND revoked_at IS NULL`,
      )
      .bind(presentedHash, newHash),
  ]);
  const row = rotated?.results[0] as { sessionId: string; userId: string; clientType: ClientType } | undefined;
  if (row) return { outcome: 'rotated', ...row };
  return revoked && revoked.meta.changes > 0 ? { outcome: 'reused' } : { outcome: 'invalid' };
}

export async function revokeSession(database: Database, sessionId: string): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE auth_sessions SET revoked_at = ${DB_NOW_MS} WHERE id = ?1 AND revoked_at IS NULL`)
    .bind(sessionId)
    .run();
}

export interface Principal {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
}

/** Read on every authenticated request, so revoking a session or disabling a user applies at once. */
export function loadPrincipal(database: Database, userId: string, sessionId: string): Promise<Principal | null> {
  return rawHandle(database)
    .prepare(
      `SELECT u.id AS userId, s.id AS sessionId, u.email, u.name
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?1 AND s.user_id = ?2 AND s.revoked_at IS NULL AND s.expires_at > ${DB_NOW_MS} AND u.disabled_at IS NULL`,
    )
    .bind(sessionId, userId)
    .first<Principal>();
}

export interface MembershipRow {
  memberId: string;
  role: Role;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  workspaceCreatedAt: number;
}

/** The user's own active memberships. Filtering by user is what keeps this safe without a tenant scope. */
export async function listMemberships(database: Database, userId: string): Promise<MembershipRow[]> {
  const { results } = await rawHandle(database)
    .prepare(
      `SELECT m.id AS memberId, ${effectiveRole('m')} AS role, w.id AS workspaceId, w.name AS workspaceName, w.slug AS workspaceSlug, w.created_at AS workspaceCreatedAt
         FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ?1 AND m.status = 'active' ORDER BY w.created_at, w.id`,
    )
    .bind(userId)
    .all<MembershipRow>();
  return results;
}

export async function issueAuthToken(database: Database, input: { tokenHash: string; userId: string; purpose: AuthTokenPurpose; ttlMs: number }): Promise<void> {
  await rawHandle(database)
    .prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, ?3, ${DB_NOW_MS} + ?4)`)
    .bind(input.tokenHash, input.userId, input.purpose, input.ttlMs)
    .run();
}

/** Only avoids costly hashing for an invalid token. The batch below is what decides. */
export async function isAuthTokenUsable(database: Database, tokenHash: string, purpose: AuthTokenPurpose): Promise<boolean> {
  const row = await rawHandle(database)
    .prepare(`SELECT 1 AS ok FROM auth_tokens WHERE token_hash = ?1 AND purpose = ?2 AND consumed_at IS NULL AND expires_at > ${DB_NOW_MS}`)
    .bind(tokenHash, purpose)
    .first();
  return row !== null;
}

const consumeToken = (d1: D1Database, tokenHash: string, purpose: AuthTokenPurpose, attempt: string) =>
  d1
    .prepare(
      `UPDATE auth_tokens SET consumed_at = ${DB_NOW_MS}, consumed_by = ?1
        WHERE token_hash = ?2 AND purpose = ?3 AND consumed_at IS NULL AND expires_at > ${DB_NOW_MS}`,
    )
    .bind(attempt, tokenHash, purpose);

/** One token wins exactly once. Every later statement is guarded by this attempt's own ID. */
export async function confirmPasswordReset(database: Database, tokenHash: string, passwordHash: string): Promise<boolean> {
  const d1 = rawHandle(database);
  const attempt = crypto.randomUUID();
  const userOfAttempt = `(SELECT user_id FROM auth_tokens WHERE token_hash = ?2 AND consumed_by = ?1)`;
  const [consumed] = await d1.batch([
    consumeToken(d1, tokenHash, 'password_reset', attempt),
    d1.prepare(`UPDATE users SET password_hash = ?3, updated_at = ${DB_NOW_MS} WHERE id = ${userOfAttempt}`).bind(attempt, tokenHash, passwordHash),
    // A reset usually follows a suspected compromise, so every existing session ends.
    d1.prepare(`UPDATE auth_sessions SET revoked_at = ${DB_NOW_MS} WHERE revoked_at IS NULL AND user_id = ${userOfAttempt}`).bind(attempt, tokenHash),
    // Sessions are not the only way in: an open socket would keep listening until its authorisation ran out.
    // Swept within about two minutes, like removing a member. Guarded by this attempt, so it runs for one winner.
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?1 || '_' || id, workspace_id, 'member.access_changed', id, json_object('memberId', id), ${DB_NOW_MS}
           FROM workspace_members WHERE user_id = ${userOfAttempt}`,
      )
      .bind(attempt, tokenHash),
    // Other reset links for this user stop working too.
    d1
      .prepare(`UPDATE auth_tokens SET consumed_at = ${DB_NOW_MS} WHERE purpose = 'password_reset' AND consumed_at IS NULL AND user_id = ${userOfAttempt}`)
      .bind(attempt, tokenHash),
  ]);
  return consumed?.meta.changes === 1;
}

export async function confirmEmailVerification(database: Database, tokenHash: string): Promise<boolean> {
  const d1 = rawHandle(database);
  const attempt = crypto.randomUUID();
  const [consumed] = await d1.batch([
    consumeToken(d1, tokenHash, 'email_verification', attempt),
    d1
      .prepare(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, ${DB_NOW_MS}), updated_at = ${DB_NOW_MS}
          WHERE id = (SELECT user_id FROM auth_tokens WHERE token_hash = ?2 AND consumed_by = ?1)`,
      )
      .bind(attempt, tokenHash),
  ]);
  return consumed?.meta.changes === 1;
}
