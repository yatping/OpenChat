/**
 * The retention sweeps, run hourly by cron. They act for the installation, not for a member, so they take no
 * context. Each statement deletes a bounded chunk and repeats its conditions in SQL, so that anything that changed
 * since it was read, such as a visitor writing again or an admin changing the setting, is left alone.
 * See docs/architecture/data-model.md#retention.
 */
import { newId } from '@openchat/shared';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

const DAY_MS = 86_400_000;

/** What the installation keeps whatever a workspace chooses. */
export const HOUSEKEEPING = {
  /** Long enough for any redelivery, since a queue keeps a message for at most 14 days. */
  jobReceiptDays: 14,
  failedJobDays: 90,
  /** Visitors who never wrote and gave no address. */
  anonymousContactDays: 30,
} as const;

export interface RetentionWorkspace {
  id: string;
  retentionDays: number;
}

export async function workspacesWithRetention(database: Database, limit: number): Promise<RetentionWorkspace[]> {
  const { results } = await rawHandle(database)
    .prepare(`SELECT id, retention_days AS retentionDays FROM workspaces WHERE retention_days IS NOT NULL ORDER BY id LIMIT ?1`)
    .bind(limit)
    .all<RetentionWorkspace>();
  return results;
}

/** The setting as read must still hold at commit. */
const settingHolds = `(SELECT retention_days FROM workspaces WHERE id = ?1) = ?2`;
const cutoff = `(${DB_NOW_MS} - ?2 * ${DAY_MS})`;

/**
 * Deletes up to `limit` resolved or archived conversations whose last message is older than the workspace's
 * retention, with their messages, events, tags, read positions, files, and failed jobs. The outbox row fixes which
 * conversations go, and tells dispatch to delete their files from storage, as erasure does. Returns how many went.
 */
export async function expireConversations(database: Database, workspace: RetentionWorkspace, limit: number): Promise<number> {
  const d1 = rawHandle(database);
  const outboxId = newId('outbox');
  const expired = `(SELECT value FROM json_each((SELECT payload_json FROM outbox WHERE id = ?3), '$.conversationIds'))`;
  const [queued] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?3, ?1, 'conversations.expired', ?1, json_object('conversationIds', json_group_array(id)), ${DB_NOW_MS}
           FROM (SELECT id FROM conversations WHERE workspace_id = ?1 AND status IN ('resolved', 'archived') AND last_message_at < ${cutoff}
                  ORDER BY last_message_at LIMIT ?4)
         HAVING count(*) > 0 AND ${settingHolds}`,
      )
      .bind(workspace.id, workspace.retentionDays, outboxId, limit),
    d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
         SELECT ?4, ?1, 'system', NULL, 'conversations.expired', 'workspace', ?1,
                json_object('conversations', json_array_length(payload_json, '$.conversationIds'), 'retentionDays', CAST(?2 AS INTEGER)), ${DB_NOW_MS}
           FROM outbox WHERE id = ?3`,
      )
      .bind(workspace.id, workspace.retentionDays, outboxId, newId('audit')),
    // A failed job's envelope names the conversation it was about.
    d1.prepare(`DELETE FROM failed_jobs WHERE workspace_id = ?1 AND EXISTS (SELECT 1 FROM ${expired} e WHERE instr(failed_jobs.envelope_json, e.value) > 0)`).bind(workspace.id, workspace.retentionDays, outboxId),
    // Messages and files both cascade from a conversation, but a file also refers to its message without a cascade.
    d1.prepare(`DELETE FROM attachments WHERE workspace_id = ?1 AND conversation_id IN ${expired}`).bind(workspace.id, workspace.retentionDays, outboxId),
    d1.prepare(`DELETE FROM conversations WHERE workspace_id = ?1 AND id IN ${expired}`).bind(workspace.id, workspace.retentionDays, outboxId),
  ]);
  if (queued?.meta.changes !== 1) return 0;
  const row = await d1.prepare(`SELECT json_array_length(payload_json, '$.conversationIds') AS count FROM outbox WHERE id = ?1`).bind(outboxId).first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Deletes contacts by ID, only while `condition` holds for each, after clearing merge pointers to them. The
 * condition may use ?1 and ?2, given in `binds`; the IDs are ?3.
 */
async function deleteContacts(database: Database, ids: string[], condition: string, binds: [unknown, unknown]): Promise<number> {
  if (ids.length === 0) return 0;
  const d1 = rawHandle(database);
  const chosen = `(SELECT x.id FROM contacts x WHERE x.id IN (SELECT value FROM json_each(?3)) AND ${condition})`;
  const [, deleted] = await d1.batch([
    d1.prepare(`UPDATE contacts SET merged_into_contact_id = NULL WHERE merged_into_contact_id IN ${chosen}`).bind(...binds, JSON.stringify(ids)),
    // Counted by RETURNING, because D1's change count includes rows removed by cascade.
    d1.prepare(`DELETE FROM contacts WHERE id IN ${chosen} RETURNING id`).bind(...binds, JSON.stringify(ids)),
  ]);
  return deleted?.results.length ?? 0;
}

const noConversations = `NOT EXISTS (SELECT 1 FROM conversations v WHERE v.workspace_id = x.workspace_id AND v.contact_id = x.id)`;

/**
 * Contacts of a workspace with retention who have no conversations left and have not been seen within it, with
 * their browsers and tags. Then the workspace's unsubscribe links and email delivery records from before the
 * cutoff, except links for an address a contact still has. Suppressions stay, so that an address that opted out
 * stays out. Returns how many contacts went.
 */
export async function expireContacts(database: Database, workspace: RetentionWorkspace, limit: number): Promise<number> {
  const d1 = rawHandle(database);
  const condition = `x.workspace_id = ?1 AND x.last_seen_at < ${cutoff} AND ${noConversations} AND ${settingHolds}`;
  const { results } = await d1
    .prepare(`SELECT x.id FROM contacts x WHERE ${condition} ORDER BY x.last_seen_at LIMIT ?3`)
    .bind(workspace.id, workspace.retentionDays, limit)
    .all<{ id: string }>();
  const count = await deleteContacts(database, results.map((r) => r.id), condition, [workspace.id, workspace.retentionDays]);
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM email_unsubscribe_links WHERE rowid IN (
           SELECT l.rowid FROM email_unsubscribe_links l WHERE l.workspace_id = ?1 AND l.created_at < ${cutoff} AND ${settingHolds}
              AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.workspace_id = ?1 AND c.email = l.email) LIMIT ?3)`,
      )
      .bind(workspace.id, workspace.retentionDays, limit),
    d1
      .prepare(`DELETE FROM email_deliveries WHERE rowid IN (SELECT rowid FROM email_deliveries WHERE workspace_id = ?1 AND created_at < ${cutoff} AND ${settingHolds} LIMIT ?3)`)
      .bind(workspace.id, workspace.retentionDays, limit),
  ]);
  if (count > 0) {
    await d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
         VALUES (?1, ?2, 'system', NULL, 'contacts.expired', 'workspace', ?2, json_object('contacts', CAST(?3 AS INTEGER), 'retentionDays', CAST(?4 AS INTEGER)), ${DB_NOW_MS})`,
      )
      .bind(newId('audit'), workspace.id, count, workspace.retentionDays)
      .run();
  }
  return count;
}

/**
 * What every installation deletes, in chunks of `limit`: expired sessions and one-time links, old job receipts and
 * failed jobs, and visitors who never wrote and gave no address. Returns how many contacts went.
 */
export async function purgeHousekeeping(database: Database, limit: number): Promise<number> {
  const d1 = rawHandle(database);
  const chunk = (table: string, where: string) => d1.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?1)`).bind(limit);
  await d1.batch([
    chunk('auth_sessions', `expires_at < ${DB_NOW_MS}`),
    chunk('auth_tokens', `expires_at < ${DB_NOW_MS}`),
    chunk('job_receipts', `claimed_at < ${DB_NOW_MS} - ${HOUSEKEEPING.jobReceiptDays * DAY_MS}`),
    chunk('failed_jobs', `failed_at < ${DB_NOW_MS} - ${HOUSEKEEPING.failedJobDays * DAY_MS}`),
  ]);
  const condition = `x.email IS NULL AND x.last_seen_at < ${DB_NOW_MS} - ${HOUSEKEEPING.anonymousContactDays * DAY_MS} AND ${noConversations}`;
  const { results } = await d1.prepare(`SELECT x.id FROM contacts x WHERE ${condition} ORDER BY x.last_seen_at LIMIT ?1`).bind(limit).all<{ id: string }>();
  return deleteContacts(database, results.map((r) => r.id), condition, [null, null]);
}
