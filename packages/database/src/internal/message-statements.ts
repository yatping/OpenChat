import { newId } from '@openchat/shared';
import { DB_NOW_MS } from './handle';

/** How long a visitor waits before members who asked are told. */
const UNANSWERED_ALERT_AFTER_MS = 15 * 60_000;

/** The shortest wait in the workspace, in the update below. NULL with no rule enabled, which clears the time. */
const SHORTEST_FOLLOW_UP_WAIT_MS = `(SELECT MIN(json_extract(r.conditions_json, '$.inactiveMinutes')) * 60000 FROM automation_rules r
     WHERE r.workspace_id = ?4 AND r.trigger_type = 'conversation_inactive' AND r.enabled = 1)`;

export interface MessageStatementsInput {
  id: string;
  workspaceId: string;
  conversationId: string;
  clientMessageId: string;
  sender: { type: 'visitor' | 'member' | 'system'; id: string | null };
  type: 'text' | 'image' | 'file' | 'system' | 'internal_note';
  content: string;
  /** Set for a visitor, so that the insert only applies to a conversation of theirs. */
  ownerContactId?: string;
  /** Unique. Files this sender uploaded to this conversation, and not yet on a message. */
  attachmentIds?: string[];
}

/** Older than this and the sweep may be deleting it, so that a message can no longer claim it. */
export const ATTACHMENT_CLAIM_MS = 23 * 60 * 60 * 1000;

/** The files on a message, as JSON, for a query with messages as m. */
export const ATTACHMENTS_JSON = `(SELECT COALESCE(json_group_array(json_object('id', a.id, 'filename', a.filename, 'contentType', a.content_type, 'size', a.size)), '[]')
       FROM attachments a WHERE a.workspace_id = m.workspace_id AND a.message_id = m.id AND a.status = 'ready')`;

export interface AttachmentJson {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}


/**
 * Pattern 1 from docs/architecture/data-model.md: an idempotent insert. Later statements are guarded by the
 * fresh message ID, which exists only if the insert took effect, so a replay or a wrong owner changes
 * nothing. The insert is always first, so that callers can read whether it happened. A visitor's message
 * reopens a conversation, because someone has to see it. The insert also requires every named file to be
 * claimable, in SQL: a wrong ID means no message, rather than a message that lost its file.
 */
export function messageStatements(d1: D1Database, input: MessageStatementsInput): D1PreparedStatement[] {
  const { id, workspaceId: w, conversationId: c } = input;
  const visibility = input.type === 'internal_note' ? 'internal' : 'public';
  const inserted = `EXISTS (SELECT 1 FROM messages m WHERE m.id = ?1)`;
  const attachmentIds = JSON.stringify(input.attachmentIds ?? []);
  const claimable = `a.workspace_id = c.workspace_id AND a.conversation_id = c.id AND a.message_id IS NULL AND a.status = 'ready'
                 AND a.uploaded_by_type = ?4 AND a.uploaded_by_id = ?5 AND a.created_at > ${DB_NOW_MS} - ${ATTACHMENT_CLAIM_MS}
                 AND a.id IN (SELECT value FROM json_each(?11))`;
  return [
    d1
      .prepare(
        `INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, client_message_id,
                               sender_type, sender_id, message_type, visibility, content, created_at)
         SELECT ?1, c.workspace_id, c.id, c.last_message_seq + 1,
                CASE WHEN ?2 = 'public' THEN c.last_public_seq + 1 END,
                ?3, ?4, ?5,
                CASE WHEN ?6 <> 'text' OR json_array_length(?11) = 0 THEN ?6
                     WHEN NOT EXISTS (SELECT 1 FROM attachments a WHERE ${claimable} AND a.content_type NOT LIKE 'image/%') THEN 'image'
                     ELSE 'file' END,
                ?2, ?7, ${DB_NOW_MS}
           FROM conversations c WHERE c.workspace_id = ?8 AND c.id = ?9 AND (?10 IS NULL OR c.contact_id = ?10)
            AND (SELECT COUNT(*) FROM attachments a WHERE ${claimable}) = json_array_length(?11)
         ON CONFLICT (workspace_id, conversation_id, client_message_id) DO NOTHING`,
      )
      .bind(id, visibility, input.clientMessageId, input.sender.type, input.sender.id, input.type, input.content, w, c, input.ownerContactId ?? null, attachmentIds),
    d1
      .prepare(
        `UPDATE attachments SET message_id = ?1
          WHERE workspace_id = ?2 AND conversation_id = ?3 AND message_id IS NULL
            AND id IN (SELECT value FROM json_each(?4)) AND ${inserted}`,
      )
      .bind(id, w, c, attachmentIds),
    d1
      .prepare(
        `INSERT INTO conversation_events (id, workspace_id, conversation_id, event_type, actor_type, actor_id, created_at)
         SELECT ?2, workspace_id, id, 'reopened', 'visitor', ?3, ${DB_NOW_MS} FROM conversations
          WHERE workspace_id = ?4 AND id = ?5 AND status <> 'open' AND ?6 = 'visitor' AND ${inserted}`,
      )
      .bind(id, newId('event'), input.sender.id, w, c, input.sender.type),
    d1
      .prepare(
        `UPDATE conversations
            SET last_message_seq = last_message_seq + 1,
                last_public_seq = last_public_seq + CASE WHEN ?2 = 'public' THEN 1 ELSE 0 END,
                last_message_at = ${DB_NOW_MS},
                last_visitor_message_at = CASE WHEN ?3 = 'visitor' THEN ${DB_NOW_MS} ELSE last_visitor_message_at END,
                last_agent_message_at = CASE WHEN ?3 = 'member' AND ?2 = 'public' THEN ${DB_NOW_MS} ELSE last_agent_message_at END,
                next_automation_at = CASE WHEN ?2 = 'public' THEN ${DB_NOW_MS} + ${SHORTEST_FOLLOW_UP_WAIT_MS} ELSE next_automation_at END,
                next_unanswered_alert_at = CASE WHEN ?3 = 'visitor' THEN COALESCE(next_unanswered_alert_at, ${DB_NOW_MS} + ${UNANSWERED_ALERT_AFTER_MS})
                                                WHEN ?3 = 'member' AND ?2 = 'public' THEN NULL ELSE next_unanswered_alert_at END,
                status = CASE WHEN ?3 = 'visitor' THEN 'open' ELSE status END,
                version = version + 1,
                updated_at = ${DB_NOW_MS}
          WHERE workspace_id = ?4 AND id = ?5 AND ${inserted}`,
      )
      .bind(id, visibility, input.sender.type, w, c),
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?2, m.workspace_id, 'message.created', m.id,
                json_object('messageId', m.id, 'conversationId', m.conversation_id), ${DB_NOW_MS}
           FROM messages m WHERE m.id = ?1`,
      )
      .bind(id, newId('outbox')),
  ];
}
