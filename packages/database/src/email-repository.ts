/**
 * Email, run from queue jobs with no user, so each query filters on an ID from the job. The delivery log holds a hash
 * and never an address. See docs/architecture/background-jobs.md.
 */
import { newId } from '@openchat/shared';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import type { WorkspaceContext } from './context';

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

export interface FollowUpRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  inactiveMinutes: number;
  createdAt: number;
  updatedAt: number;
}

interface RawRule {
  id: string;
  name: string;
  enabled: number;
  inactiveMinutes: number;
  createdAt: number;
  updatedAt: number;
}

const RULE_COLUMNS = `id, name, enabled, json_extract(conditions_json, '$.inactiveMinutes') AS inactiveMinutes, created_at AS createdAt, updated_at AS updatedAt`;
const toRule = (row: RawRule): FollowUpRuleRow => ({ ...row, enabled: row.enabled === 1 });
const MAX_RULES = 10;

export function followUpRuleRepository(database: Database, ctx: WorkspaceContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;
  return {
    async list(): Promise<FollowUpRuleRow[]> {
      const { results } = await d1.prepare(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE workspace_id = ?1 AND trigger_type = 'conversation_inactive' ORDER BY id LIMIT ${MAX_RULES}`).bind(w).all<RawRule>();
      return results.map(toRule);
    },
    /** Null at the limit. The conditions are fixed, in the shape the specification gives. */
    async create(input: { name: string; enabled: boolean; inactiveMinutes: number }): Promise<FollowUpRuleRow | null> {
      const row = await d1
        .prepare(
          `INSERT INTO automation_rules (id, workspace_id, name, trigger_type, conditions_json, actions_json, enabled, created_at, updated_at)
           SELECT ?1, ?2, ?3, 'conversation_inactive',
                  json_object('inactiveMinutes', ?4, 'visitorEmailExists', json('true'), 'conversationStatus', 'open', 'followUpConsent', json('true')),
                  json_array(json_object('type', 'send_email', 'template', 'follow_up')), ?5, ${DB_NOW_MS}, ${DB_NOW_MS}
            WHERE (SELECT COUNT(*) FROM automation_rules WHERE workspace_id = ?2) < ${MAX_RULES}
           RETURNING ${RULE_COLUMNS}`,
        )
        .bind(newId('automationRule'), w, input.name, input.inactiveMinutes, input.enabled ? 1 : 0)
        .first<RawRule>();
      return row ? toRule(row) : null;
    },
    async update(ruleId: string, change: { name?: string | undefined; enabled?: boolean | undefined; inactiveMinutes?: number | undefined }): Promise<FollowUpRuleRow | null> {
      const row = await d1
        .prepare(
          `UPDATE automation_rules
              SET name = COALESCE(?3, name), enabled = COALESCE(?4, enabled),
                  conditions_json = CASE WHEN ?5 IS NULL THEN conditions_json ELSE json_set(conditions_json, '$.inactiveMinutes', ?5) END,
                  updated_at = ${DB_NOW_MS}
            WHERE workspace_id = ?1 AND id = ?2 RETURNING ${RULE_COLUMNS}`,
        )
        .bind(w, ruleId, change.name ?? null, change.enabled === undefined ? null : change.enabled ? 1 : 0, change.inactiveMinutes ?? null)
        .first<RawRule>();
      return row ? toRule(row) : null;
    },
    async remove(ruleId: string): Promise<boolean> {
      const result = await d1.prepare(`DELETE FROM automation_rules WHERE workspace_id = ?1 AND id = ?2`).bind(w, ruleId).run();
      return result.meta.changes === 1;
    },
  };
}

export async function dueFollowUpConversations(database: Database, limit: number): Promise<{ workspaceId: string; id: string; dueAt: number }[]> {
  const { results } = await rawHandle(database)
    .prepare(
      `SELECT workspace_id AS workspaceId, id, next_automation_at AS dueAt
         FROM conversations WHERE next_automation_at IS NOT NULL AND next_automation_at <= ${DB_NOW_MS} ORDER BY next_automation_at LIMIT ?1`,
    )
    .bind(limit)
    .all<{ workspaceId: string; id: string; dueAt: number }>();
  return results;
}

/** Only the time it read, so that a message since then keeps the time it set. */
export async function clearFollowUpDue(database: Database, workspaceId: string, conversationId: string, dueAt: number): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE conversations SET next_automation_at = NULL WHERE workspace_id = ?1 AND id = ?2 AND next_automation_at = ?3`)
    .bind(workspaceId, conversationId, dueAt)
    .run();
}

/** A rule with a longer wait comes back later, unless a message has started a new quiet period. */
export async function scheduleFollowUpCheck(database: Database, input: { workspaceId: string; conversationId: string; lastPublicSeq: number; at: number }): Promise<void> {
  await rawHandle(database)
    .prepare(`UPDATE conversations SET next_automation_at = MIN(COALESCE(next_automation_at, ?4), ?4) WHERE workspace_id = ?1 AND id = ?2 AND last_public_seq = ?3`)
    .bind(input.workspaceId, input.conversationId, input.lastPublicSeq, input.at)
    .run();
}

export interface QuietConversation {
  status: string;
  lastPublicSeq: number;
  /** The last thing either side said to the other. An internal note is not that. */
  lastPublicAt: number | null;
  hasEmail: number;
  hasConsent: number;
}

export function conversationForFollowUp(database: Database, workspaceId: string, conversationId: string): Promise<QuietConversation | null> {
  return rawHandle(database)
    .prepare(
      `SELECT c.status, c.last_public_seq AS lastPublicSeq, MAX(COALESCE(c.last_visitor_message_at, 0), COALESCE(c.last_agent_message_at, 0)) AS lastPublicAt,
              ct.email IS NOT NULL AS hasEmail, ct.follow_up_consent_at IS NOT NULL AS hasConsent
         FROM conversations c JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
        WHERE c.workspace_id = ?1 AND c.id = ?2`,
    )
    .bind(workspaceId, conversationId)
    .first<QuietConversation>();
}

export async function enabledFollowUpRules(database: Database, workspaceId: string): Promise<{ id: string; inactiveMinutes: number }[]> {
  const { results } = await rawHandle(database)
    .prepare(`SELECT id, json_extract(conditions_json, '$.inactiveMinutes') AS inactiveMinutes FROM automation_rules WHERE workspace_id = ?1 AND trigger_type = 'conversation_inactive' AND enabled = 1`)
    .bind(workspaceId)
    .all<{ id: string; inactiveMinutes: number }>();
  return results;
}

/** One row for each rule in each quiet period. Returns the outcome on record, which a repeated job then follows. */
export async function claimFollowUpRun(database: Database, input: { workspaceId: string; ruleId: string; conversationId: string; triggerKey: string; outcome: string }): Promise<string> {
  const row = await rawHandle(database)
    .prepare(
      `INSERT INTO automation_runs (id, workspace_id, rule_id, conversation_id, trigger_key, outcome, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${DB_NOW_MS})
       ON CONFLICT (workspace_id, rule_id, conversation_id, trigger_key) DO UPDATE SET trigger_key = excluded.trigger_key
       RETURNING outcome`,
    )
    .bind(newId('automationRun'), input.workspaceId, input.ruleId, input.conversationId, input.triggerKey, input.outcome)
    .first<{ outcome: string }>();
  return row!.outcome;
}

export interface FollowUpFacts {
  workspaceName: string;
  ruleEnabled: number;
  status: string;
  lastPublicSeq: number;
  email: string | null;
  hasConsent: number;
  suppressed: number;
  originsJson: string;
}

/** Everything that decides a follow-up, read together just before sending. */
export function followUpFactsForSend(database: Database, input: { workspaceId: string; conversationId: string; ruleId: string }): Promise<FollowUpFacts | null> {
  return rawHandle(database)
    .prepare(
      `SELECT w.name AS workspaceName, r.enabled AS ruleEnabled, c.status, c.last_public_seq AS lastPublicSeq, ct.email,
              ct.follow_up_consent_at IS NOT NULL AS hasConsent,
              EXISTS (SELECT 1 FROM email_suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = ct.email) AS suppressed,
              site.allowed_origins_json AS originsJson
         FROM conversations c
         JOIN workspaces w ON w.id = c.workspace_id
         JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
         JOIN websites site ON site.workspace_id = c.workspace_id AND site.id = c.website_id
         JOIN automation_rules r ON r.workspace_id = c.workspace_id AND r.id = ?3
        WHERE c.workspace_id = ?1 AND c.id = ?2`,
    )
    .bind(input.workspaceId, input.conversationId, input.ruleId)
    .first<FollowUpFacts>();
}
