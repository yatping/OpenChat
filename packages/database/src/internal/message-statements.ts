import { newId } from '@openchat/shared';
import { DB_NOW_MS } from './handle';

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
}

/**
 * Pattern 1 from docs/architecture/data-model.md: an idempotent insert. Later statements are guarded by the
 * fresh message ID, which exists only if the insert took effect, so a replay or a wrong owner changes
 * nothing. The insert is always first, so that callers can read whether it happened. A visitor's message
 * reopens a conversation, because someone has to see it.
 */
export function messageStatements(d1: D1Database, input: MessageStatementsInput): D1PreparedStatement[] {
  const { id, workspaceId: w, conversationId: c } = input;
  const visibility = input.type === 'internal_note' ? 'internal' : 'public';
  const inserted = `EXISTS (SELECT 1 FROM messages m WHERE m.id = ?1)`;
  return [
    d1
      .prepare(
        `INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, client_message_id,
                               sender_type, sender_id, message_type, visibility, content, created_at)
         SELECT ?1, c.workspace_id, c.id, c.last_message_seq + 1,
                CASE WHEN ?2 = 'public' THEN c.last_public_seq + 1 END,
                ?3, ?4, ?5, ?6, ?2, ?7, ${DB_NOW_MS}
           FROM conversations c WHERE c.workspace_id = ?8 AND c.id = ?9 AND (?10 IS NULL OR c.contact_id = ?10)
         ON CONFLICT (workspace_id, conversation_id, client_message_id) DO NOTHING`,
      )
      .bind(id, visibility, input.clientMessageId, input.sender.type, input.sender.id, input.type, input.content, w, c, input.ownerContactId ?? null),
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
                last_agent_message_at = CASE WHEN ?3 = 'member' THEN ${DB_NOW_MS} ELSE last_agent_message_at END,
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
