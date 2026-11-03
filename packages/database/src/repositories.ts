/**
 * Scoped repositories. Every query here applies ctx.workspaceId. A cross-tenant ID behaves exactly
 * like an ID that does not exist. Write patterns: docs/architecture/data-model.md.
 */
import { newId } from '@openchat/shared';
import type { WorkspaceContext } from './context';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

export interface WebsiteRow {
  id: string;
  name: string;
  websiteKey: string;
}

export type SendableType = 'text' | 'image' | 'file' | 'system' | 'internal_note';

export interface SendMessageInput {
  conversationId: string;
  clientMessageId: string;
  sender: { type: 'visitor' | 'member' | 'system'; id: string | null };
  type: SendableType;
  content: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  publicSeq: number | null;
  clientMessageId: string | null;
  senderType: string;
  senderId: string | null;
  type: SendableType;
  visibility: 'public' | 'internal';
  content: string;
  createdAt: number;
}

export type SendResult =
  | { outcome: 'created'; message: StoredMessage }
  | { outcome: 'replayed'; message: StoredMessage }
  | { outcome: 'not_found' };

export type AssignResult = { outcome: 'updated'; version: number } | { outcome: 'conflict'; currentVersion: number } | { outcome: 'not_found' };

const MESSAGE_COLUMNS = `id, conversation_id AS conversationId, seq, public_seq AS publicSeq,
  client_message_id AS clientMessageId, sender_type AS senderType, sender_id AS senderId,
  message_type AS type, visibility, content, created_at AS createdAt`;

export function repositories(database: Database, ctx: WorkspaceContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;

  return {
    websites: {
      async list(): Promise<WebsiteRow[]> {
        const { results } = await d1
          .prepare(`SELECT id, name, website_key AS websiteKey FROM websites WHERE workspace_id = ?1 ORDER BY id`)
          .bind(w)
          .all<WebsiteRow>();
        return results;
      },
      async create(input: { name: string; websiteKey: string }): Promise<WebsiteRow> {
        const id = newId('website');
        await d1
          .prepare(
            `INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ${DB_NOW_MS}, ${DB_NOW_MS})`,
          )
          .bind(id, w, input.name, input.websiteKey)
          .run();
        return { id, name: input.name, websiteKey: input.websiteKey };
      },
    },

    conversations: {
      async get(conversationId: string) {
        return d1
          .prepare(
            `SELECT id, status, assigned_member_id AS assignedMemberId, version,
                    last_message_seq AS lastMessageSeq, last_public_seq AS lastPublicSeq, updated_at AS updatedAt
               FROM conversations WHERE workspace_id = ?1 AND id = ?2`,
          )
          .bind(w, conversationId)
          .first<{
            id: string;
            status: string;
            assignedMemberId: string | null;
            version: number;
            lastMessageSeq: number;
            lastPublicSeq: number;
            updatedAt: number;
          }>();
      },

      /**
       * Pattern 2: compare-and-set with a follow-up statement. The follow-ups are guarded by a value
       * unique to this request. Guarding on version = expected + 1 is wrong: if another writer already
       * advanced the version, a stale request would match it and write a false event.
       */
      async assign(conversationId: string, memberId: string | null, expectedVersion: number): Promise<AssignResult> {
        const mutation = newId('mutation');
        const eventId = newId('event');
        const outboxId = newId('outbox');
        const [update] = await d1.batch([
          d1
            .prepare(
              `UPDATE conversations
                  SET assigned_member_id = ?1, version = version + 1, last_mutation_id = ?2, updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?3 AND id = ?4 AND version = ?5`,
            )
            .bind(memberId, mutation, w, conversationId, expectedVersion),
          d1
            .prepare(
              `INSERT INTO conversation_events (id, workspace_id, conversation_id, event_type, actor_type, actor_id, metadata_json, created_at)
               SELECT ?1, workspace_id, id, 'assigned', 'member', ?2, json_object('assignedMemberId', ?3), ${DB_NOW_MS}
                 FROM conversations WHERE workspace_id = ?4 AND id = ?5 AND last_mutation_id = ?6`,
            )
            .bind(eventId, ctx.memberId, memberId, w, conversationId, mutation),
          d1
            .prepare(
              `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
               SELECT ?1, workspace_id, 'conversation.updated', id, json_object('conversationId', id, 'version', version), ${DB_NOW_MS}
                 FROM conversations WHERE workspace_id = ?2 AND id = ?3 AND last_mutation_id = ?4`,
            )
            .bind(outboxId, w, conversationId, mutation),
        ]);
        if (update?.meta.changes === 1) return { outcome: 'updated', version: expectedVersion + 1 };
        const current = await this.get(conversationId);
        return current ? { outcome: 'conflict', currentVersion: current.version } : { outcome: 'not_found' };
      },
    },

    messages: {
      /**
       * Pattern 1: idempotent insert. Later statements are guarded by the fresh message ID, which
       * exists only if the insert took effect, so a replay or a wrong workspace changes nothing.
       */
      async send(input: SendMessageInput): Promise<SendResult> {
        const id = newId('message');
        const outboxId = newId('outbox');
        const visibility = input.type === 'internal_note' ? 'internal' : 'public';
        const c = input.conversationId;
        const [insert] = await d1.batch([
          d1
            .prepare(
              `INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, client_message_id,
                                     sender_type, sender_id, message_type, visibility, content, created_at)
               SELECT ?1, c.workspace_id, c.id, c.last_message_seq + 1,
                      CASE WHEN ?2 = 'public' THEN c.last_public_seq + 1 END,
                      ?3, ?4, ?5, ?6, ?2, ?7, ${DB_NOW_MS}
                 FROM conversations c WHERE c.workspace_id = ?8 AND c.id = ?9
               ON CONFLICT (workspace_id, conversation_id, client_message_id) DO NOTHING`,
            )
            .bind(id, visibility, input.clientMessageId, input.sender.type, input.sender.id, input.type, input.content, w, c),
          d1
            .prepare(
              `UPDATE conversations
                  SET last_message_seq = last_message_seq + 1,
                      last_public_seq = last_public_seq + CASE WHEN ?1 = 'public' THEN 1 ELSE 0 END,
                      last_message_at = ${DB_NOW_MS},
                      version = version + 1,
                      updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?2 AND id = ?3 AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ?4)`,
            )
            .bind(visibility, w, c, id),
          d1
            .prepare(
              `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
               SELECT ?1, m.workspace_id, 'message.created', m.id,
                      json_object('messageId', m.id, 'conversationId', m.conversation_id), ${DB_NOW_MS}
                 FROM messages m WHERE m.id = ?2`,
            )
            .bind(outboxId, id),
        ]);

        const created = insert?.meta.changes === 1;
        const message = await d1
          .prepare(
            `SELECT ${MESSAGE_COLUMNS} FROM messages
              WHERE workspace_id = ?1 AND conversation_id = ?2 AND client_message_id = ?3`,
          )
          .bind(w, c, input.clientMessageId)
          .first<StoredMessage>();
        if (!message) return { outcome: 'not_found' };
        return { outcome: created ? 'created' : 'replayed', message };
      },

      /** Everything, including internal notes. For agents only. */
      async listAfter(conversationId: string, afterSeq: number, limit = 50): Promise<StoredMessage[]> {
        const { results } = await d1
          .prepare(
            `SELECT ${MESSAGE_COLUMNS} FROM messages
              WHERE workspace_id = ?1 AND conversation_id = ?2 AND seq > ?3 ORDER BY seq LIMIT ?4`,
          )
          .bind(w, conversationId, afterSeq, Math.min(limit, 100))
          .all<StoredMessage>();
        return results;
      },
    },
  };
}

export type Repositories = ReturnType<typeof repositories>;

/** Reads with no tenant, for the discovery document. Deliberately narrow. */
export async function getInstallation(database: Database) {
  return rawHandle(database)
    .prepare(`SELECT id, name, public_base_url AS publicBaseUrl, signup_policy AS signupPolicy FROM installation LIMIT 1`)
    .first<{ id: string; name: string; publicBaseUrl: string; signupPolicy: 'invite_only' | 'open' }>();
}

/** Consumer idempotency. True if this caller claimed the key first. */
export async function claimJob(database: Database, key: string, jobType: string): Promise<boolean> {
  const result = await rawHandle(database)
    .prepare(
      `INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at)
       VALUES (?1, ?2, 'claimed', ${DB_NOW_MS}) ON CONFLICT (idempotency_key) DO NOTHING`,
    )
    .bind(key, jobType)
    .run();
  return result.meta.changes === 1;
}

export async function recordFailedJob(
  database: Database,
  input: { queue: string; jobType: string; idempotencyKey: string; workspaceId: string | null; attempts: number; envelopeJson: string },
): Promise<void> {
  await rawHandle(database)
    .prepare(
      `INSERT INTO failed_jobs (id, workspace_id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ${DB_NOW_MS})`,
    )
    .bind(newId('failedJob'), input.workspaceId, input.queue, input.jobType, input.idempotencyKey, input.attempts, input.envelopeJson)
    .run();
}
