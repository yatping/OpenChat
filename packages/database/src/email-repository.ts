/**
 * Email to members, run from queue jobs with no user, so each query filters on an ID from the job. The delivery log
 * holds a hash and never an address. See docs/architecture/background-jobs.md.
 */
import { newId } from '@openchat/shared';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import type { WorkspaceContext } from './context';

/** Email is off until a member turns it on, so a busy website cannot use up a sending allowance by surprise. */
export async function emailRecipients(database: Database, input: { workspaceId: string; eventType: string; onlyMemberId: string | null }): Promise<string[]> {
  const { results } = await rawHandle(database)
    .prepare(
      `SELECT m.id AS memberId
         FROM notification_preferences p
         JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.id = p.member_id AND m.status = 'active'
         JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
        WHERE p.workspace_id = ?1 AND p.event_type = ?2 AND p.channel = 'email' AND p.enabled = 1 AND (?3 IS NULL OR m.id = ?3)`,
    )
    .bind(input.workspaceId, input.eventType, input.onlyMemberId)
    .all<{ memberId: string }>();
  return results.map((row) => row.memberId);
}

export interface AlertFacts {
  workspaceName: string;
  status: string;
  assignedMemberId: string | null;
  lastMessageSeq: number;
  lastVisitorMessageAt: number | null;
  lastAgentMessageAt: number | null;
}

export function conversationForAlert(database: Database, workspaceId: string, conversationId: string): Promise<AlertFacts | null> {
  return rawHandle(database)
    .prepare(
      `SELECT w.name AS workspaceName, c.status, c.assigned_member_id AS assignedMemberId, c.last_message_seq AS lastMessageSeq,
              c.last_visitor_message_at AS lastVisitorMessageAt, c.last_agent_message_at AS lastAgentMessageAt
         FROM conversations c JOIN workspaces w ON w.id = c.workspace_id WHERE c.workspace_id = ?1 AND c.id = ?2`,
    )
    .bind(workspaceId, conversationId)
    .first<AlertFacts>();
}

/** Read when sending, so that the job holds no address, and a change of address or access counts. */
export function alertRecipient(database: Database, workspaceId: string, memberId: string, eventType: string): Promise<{ email: string; name: string } | null> {
  return rawHandle(database)
    .prepare(
      `SELECT u.email, u.name
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
         JOIN notification_preferences p ON p.workspace_id = m.workspace_id AND p.member_id = m.id AND p.event_type = ?3 AND p.channel = 'email' AND p.enabled = 1
        WHERE m.workspace_id = ?1 AND m.id = ?2 AND m.status = 'active'`,
    )
    .bind(workspaceId, memberId, eventType)
    .first<{ email: string; name: string }>();
}

/**
 * True if this caller may send. A row left `failed` may be claimed again. One left `claimed` is not: it may be in
 * flight, or may have died after sending, and a provider with no idempotency key could then send twice.
 */
export async function claimEmailDelivery(database: Database, input: { workspaceId: string; dedupeKey: string; template: string; recipientHash: string }): Promise<boolean> {
  const result = await rawHandle(database)
    .prepare(
      `INSERT INTO email_deliveries (id, workspace_id, dedupe_key, template, recipient_hash, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', ${DB_NOW_MS}, ${DB_NOW_MS})
       ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET status = 'claimed', updated_at = ${DB_NOW_MS} WHERE email_deliveries.status = 'failed'`,
    )
    .bind(newId('emailDelivery'), input.workspaceId, input.dedupeKey, input.template, input.recipientHash)
    .run();
  return result.meta.changes === 1;
}

export async function finishEmailDelivery(database: Database, input: { workspaceId: string; dedupeKey: string; status: 'sent' | 'failed' | 'suppressed'; providerMessageId?: string }): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE email_deliveries SET status = ?3, provider_message_id = ?4, updated_at = ${DB_NOW_MS} WHERE workspace_id = ?1 AND dedupe_key = ?2`)
    .bind(input.workspaceId, input.dedupeKey, input.status, input.providerMessageId ?? null)
    .run();
}

export async function dueUnansweredConversations(database: Database, limit: number): Promise<{ workspaceId: string; id: string; lastMessageSeq: number; dueAt: number }[]> {
  const { results } = await rawHandle(database)
    .prepare(
      `SELECT workspace_id AS workspaceId, id, last_message_seq AS lastMessageSeq, next_unanswered_alert_at AS dueAt
         FROM conversations WHERE next_unanswered_alert_at IS NOT NULL AND next_unanswered_alert_at <= ${DB_NOW_MS} ORDER BY next_unanswered_alert_at LIMIT ?1`,
    )
    .bind(limit)
    .all<{ workspaceId: string; id: string; lastMessageSeq: number; dueAt: number }>();
  return results;
}

/** Only the time it read, so that a newer visitor message keeps its own alert. */
export async function clearUnansweredAlert(database: Database, workspaceId: string, conversationId: string, dueAt: number): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE conversations SET next_unanswered_alert_at = NULL WHERE workspace_id = ?1 AND id = ?2 AND next_unanswered_alert_at = ?3`)
    .bind(workspaceId, conversationId, dueAt)
    .run();
}

/** Kept so that a link in an old email goes on working. Only a hash of its token is stored. */
export async function createUnsubscribeLink(database: Database, input: { workspaceId: string; email: string; tokenHash: string }): Promise<void> {
  await rawHandle(database)
    .prepare(`INSERT INTO email_unsubscribe_links (token_hash, workspace_id, email, created_at) VALUES (?1, ?2, ?3, ${DB_NOW_MS})`)
    .bind(input.tokenHash, input.workspaceId, input.email)
    .run();
}

export async function unsubscribeLinkExists(database: Database, tokenHash: string): Promise<boolean> {
  const row = await rawHandle(database).prepare(`SELECT 1 AS found FROM email_unsubscribe_links WHERE token_hash = ?1`).bind(tokenHash).first<{ found: number }>();
  return row !== null;
}

/** The address goes on the list and loses its consent together. Pressing it twice changes nothing more. */
export async function unsubscribeByLink(database: Database, tokenHash: string): Promise<void> {
  const d1 = rawHandle(database);
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO email_suppressions (workspace_id, email, reason, created_at)
         SELECT workspace_id, email, 'unsubscribe', ${DB_NOW_MS} FROM email_unsubscribe_links WHERE token_hash = ?1
         ON CONFLICT (workspace_id, email) DO UPDATE SET reason = 'unsubscribe'`,
      )
      .bind(tokenHash),
    d1
      .prepare(
        `UPDATE contacts SET follow_up_consent_at = NULL, follow_up_consent_source = NULL, updated_at = ${DB_NOW_MS}
          WHERE EXISTS (SELECT 1 FROM email_unsubscribe_links l WHERE l.token_hash = ?1 AND l.workspace_id = contacts.workspace_id AND l.email = contacts.email)`,
      )
      .bind(tokenHash),
  ]);
}

export interface SuppressionRow {
  email: string;
  reason: 'unsubscribe' | 'bounce' | 'complaint' | 'manual';
  createdAt: number;
}

export function suppressionRepository(database: Database, ctx: WorkspaceContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;
  return {
    async list(input: { cursor?: string | undefined; limit: number }): Promise<{ data: SuppressionRow[]; nextCursor: string | null }> {
      const { results } = await d1
        .prepare(`SELECT email, reason, created_at AS createdAt FROM email_suppressions WHERE workspace_id = ?1 AND (?2 IS NULL OR email > ?2) ORDER BY email LIMIT ?3`)
        .bind(w, input.cursor ?? null, input.limit + 1)
        .all<SuppressionRow>();
      const data = results.slice(0, input.limit);
      return { data, nextCursor: results.length > input.limit ? (data.at(-1)?.email ?? null) : null };
    },
    /** Never replaces a reason already there, so that adding by hand cannot turn an unsubscribe into something removable. */
    async add(email: string): Promise<void> {
      await d1.prepare(`INSERT OR IGNORE INTO email_suppressions (workspace_id, email, reason, created_at) VALUES (?1, ?2, 'manual', ${DB_NOW_MS})`).bind(w, email).run();
    },
    /** False if the address is listed for a reason that is not ours to undo. */
    async removeManual(email: string): Promise<boolean> {
      await d1.prepare(`DELETE FROM email_suppressions WHERE workspace_id = ?1 AND email = ?2 AND reason = 'manual'`).bind(w, email).run();
      const left = await d1.prepare(`SELECT 1 AS found FROM email_suppressions WHERE workspace_id = ?1 AND email = ?2`).bind(w, email).first<{ found: number }>();
      return left === null;
    },
  };
}
