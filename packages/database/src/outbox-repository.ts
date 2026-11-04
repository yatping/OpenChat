/**
 * Dispatch of committed events. It runs with no user, either right after a commit or from the cron sweep,
 * so each query filters on an ID from an outbox row. See docs/architecture/background-jobs.md.
 */
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import { MESSAGE_SELECT, type ConversationPriority, type ConversationStatus, type StoredMessage } from './repositories';

export interface OutboxRow {
  id: string;
  workspaceId: string;
  topic: string;
  aggregateId: string;
  payloadJson: string;
}

const COLUMNS = `id, workspace_id AS workspaceId, topic, aggregate_id AS aggregateId, payload_json AS payloadJson`;

/** Uses the partial index of pending rows, which stays small however large the table grows. */
export async function pendingOutboxFor(database: Database, workspaceId: string, aggregateIds: string[]): Promise<OutboxRow[]> {
  if (aggregateIds.length === 0) return [];
  const marks = aggregateIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await rawHandle(database)
    .prepare(`SELECT ${COLUMNS} FROM outbox WHERE dispatched_at IS NULL AND workspace_id = ?1 AND aggregate_id IN (${marks}) ORDER BY created_at, id`)
    .bind(workspaceId, ...aggregateIds)
    .all<OutboxRow>();
  return results;
}

/** Fewest attempts first, so that rows which keep failing cannot crowd out the rest. */
export async function staleOutbox(database: Database, olderThanMs: number, limit: number): Promise<OutboxRow[]> {
  const { results } = await rawHandle(database)
    .prepare(`SELECT ${COLUMNS} FROM outbox WHERE dispatched_at IS NULL AND created_at < ${DB_NOW_MS} - ?1 ORDER BY attempts, created_at LIMIT ?2`)
    .bind(olderThanMs, limit)
    .all<OutboxRow>();
  return results;
}

export async function markOutboxDispatched(database: Database, id: string): Promise<void> {
  await rawHandle(database).prepare(`UPDATE outbox SET dispatched_at = ${DB_NOW_MS} WHERE id = ?1`).bind(id).run();
}

/** In chunks, so that one run stays cheap however far behind it is. */
export async function purgeDispatchedOutbox(database: Database, olderThanMs: number, limit: number): Promise<void> {
  await rawHandle(database)
    .prepare(`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE dispatched_at IS NOT NULL AND dispatched_at < ${DB_NOW_MS} - ?1 LIMIT ?2)`)
    .bind(olderThanMs, limit)
    .run();
}

export async function recordOutboxFailure(database: Database, id: string): Promise<void> {
  await rawHandle(database).prepare(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ?1`).bind(id).run();
}

export async function messageForDispatch(database: Database, workspaceId: string, messageId: string): Promise<(StoredMessage & { showAgentNames: boolean; conversationVersion: number | null }) | null> {
  const d1 = rawHandle(database);
  const message = await d1.prepare(`${MESSAGE_SELECT} WHERE m.workspace_id = ?1 AND m.id = ?2`).bind(workspaceId, messageId).first<StoredMessage>();
  if (!message) return null;
  const site = await d1
    .prepare(`SELECT s.settings_json AS settings, c.version FROM conversations c JOIN websites s ON s.workspace_id = c.workspace_id AND s.id = c.website_id WHERE c.workspace_id = ?1 AND c.id = ?2`)
    .bind(workspaceId, message.conversationId)
    .first<{ settings: string | null; version: number }>();
  const settings = site?.settings ? (JSON.parse(site.settings) as { showAgentNames?: boolean }) : {};
  return { ...message, showAgentNames: settings.showAgentNames === true, conversationVersion: site?.version ?? null };
}

export function conversationForDispatch(database: Database, workspaceId: string, conversationId: string) {
  return rawHandle(database)
    .prepare(
      `SELECT id, version, status, priority, assigned_member_id AS assignedMemberId, last_message_seq AS lastMessageSeq,
              last_message_at AS lastMessageAt, updated_at AS updatedAt
         FROM conversations WHERE workspace_id = ?1 AND id = ?2`,
    )
    .bind(workspaceId, conversationId)
    .first<{
      id: string;
      version: number;
      status: ConversationStatus;
      priority: ConversationPriority;
      assignedMemberId: string | null;
      lastMessageSeq: number;
      lastMessageAt: number | null;
      updatedAt: number;
    }>();
}
