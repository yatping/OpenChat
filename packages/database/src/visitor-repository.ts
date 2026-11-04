/**
 * Everything a visitor can reach. It is separate from the agent repositories so that notes are out of reach
 * by construction: no query here can return an internal message, and no type here has a visibility field,
 * a member ID, an assignee, or a raw sequence. See docs/architecture/security.md#visitor-authentication.
 */
import { deterministicId, newId } from '@openchat/shared';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import { ATTACHMENTS_JSON, messageStatements } from './internal/message-statements';
import { ATTACHMENT_SELECT, attachmentKey, type AttachmentRow, type NewAttachment } from './repositories';

declare const visitorBrand: unique symbol;

/** Proof that a signed token names a visitor that still exists. Cannot be constructed outside this file. */
export interface VisitorContext {
  readonly workspaceId: string;
  readonly websiteId: string;
  readonly visitorId: string;
  readonly contactId: string;
  readonly allowedOrigins: readonly string[];
  /** A workspace's choice. Off unless it says otherwise, so agents stay anonymous by default. */
  readonly showAgentNames: boolean;
  readonly [visitorBrand]: true;
}

export interface PublicWebsite {
  id: string;
  workspaceId: string;
  allowedOrigins: string[];
  settings: Record<string, unknown>;
}

export interface VisitorConversationRow {
  id: string;
  status: string;
  lastSeq: number;
  createdAt: number;
  /** This visitor's own read position. */
  readSeq: number;
  /** How far any agent has read, as a public sequence number, so that it says nothing about notes. */
  agentReadSeq: number;
}

export interface VisitorMessageRow {
  id: string;
  conversationId: string;
  seq: number;
  clientMessageId: string | null;
  senderType: 'visitor' | 'member' | 'system';
  senderName: string | null;
  type: 'text' | 'image' | 'file' | 'system';
  content: string;
  createdAt: number;
  attachmentsJson: string;
}

export type VisitorSendResult =
  | { outcome: 'created' | 'replayed'; message: VisitorMessageRow }
  | { outcome: 'not_found' }
  /** The client ID is taken by a message this visitor did not send, which must not be returned. */
  | { outcome: 'conflict' }
  /** A named file is not one this visitor can put on a message. */
  | { outcome: 'invalid_attachments' };

/** Public rows only, in the visitor's own sequence, for conversations of this contact. ?1 is the contact. */
const MESSAGE_SELECT = `SELECT m.id, ${ATTACHMENTS_JSON} AS attachmentsJson, m.conversation_id AS conversationId, m.public_seq AS seq,
    CASE WHEN m.sender_type = 'visitor' THEN m.client_message_id END AS clientMessageId,
    m.sender_type AS senderType, m.message_type AS type, m.content, m.created_at AS createdAt, COALESCE(u.name, ct.name) AS senderName
  FROM messages m
  JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id AND c.contact_id = ?1
  LEFT JOIN workspace_members sm ON m.sender_type = 'member' AND sm.workspace_id = m.workspace_id AND sm.id = m.sender_id
  LEFT JOIN users u ON u.id = sm.user_id
  LEFT JOIN visitors sv ON m.sender_type = 'visitor' AND sv.workspace_id = m.workspace_id AND sv.id = m.sender_id
  LEFT JOIN contacts ct ON ct.workspace_id = sv.workspace_id AND ct.id = sv.contact_id`;

export async function findWebsiteByKey(database: Database, websiteKey: string): Promise<PublicWebsite | null> {
  const row = await rawHandle(database)
    .prepare(`SELECT id, workspace_id AS workspaceId, allowed_origins_json AS origins, settings_json AS settings FROM websites WHERE website_key = ?1`)
    .bind(websiteKey)
    .first<{ id: string; workspaceId: string; origins: string; settings: string | null }>();
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspaceId, allowedOrigins: JSON.parse(row.origins) as string[], settings: row.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {} };
}

/** A new visitor is always a new contact. An email typed later never joins them to an existing one. */
export async function createVisitor(database: Database, website: Pick<PublicWebsite, 'id' | 'workspaceId'>, refreshTokenHash: string): Promise<string> {
  const d1 = rawHandle(database);
  const visitorId = newId('visitor');
  const contactId = newId('contact');
  await d1.batch([
    d1
      .prepare(`INSERT INTO contacts (id, workspace_id, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?1, ?2, ${DB_NOW_MS}, ${DB_NOW_MS}, ${DB_NOW_MS}, ${DB_NOW_MS})`)
      .bind(contactId, website.workspaceId),
    d1
      .prepare(`INSERT INTO visitors (id, workspace_id, website_id, contact_id, refresh_token_hash, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ${DB_NOW_MS}, ${DB_NOW_MS})`)
      .bind(visitorId, website.workspaceId, website.id, contactId, refreshTokenHash),
  ]);
  return visitorId;
}

/** Null unless the token belongs to a visitor of this website. */
export async function resumeVisitor(database: Database, websiteId: string, refreshTokenHash: string): Promise<string | null> {
  const row = await rawHandle(database)
    .prepare(`UPDATE visitors SET last_seen_at = ${DB_NOW_MS} WHERE refresh_token_hash = ?1 AND website_id = ?2 RETURNING id`)
    .bind(refreshTokenHash, websiteId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Null if the visitor is gone, or if the claims do not all describe the same visitor. */
export async function authorizeVisitor(database: Database, claims: { visitorId: string; workspaceId: string; websiteId: string }): Promise<VisitorContext | null> {
  const row = await rawHandle(database)
    .prepare(
      `SELECT v.contact_id AS contactId, s.allowed_origins_json AS origins, s.settings_json AS settings
         FROM visitors v JOIN websites s ON s.workspace_id = v.workspace_id AND s.id = v.website_id
        WHERE v.id = ?1 AND v.workspace_id = ?2 AND v.website_id = ?3`,
    )
    .bind(claims.visitorId, claims.workspaceId, claims.websiteId)
    .first<{ contactId: string; origins: string; settings: string | null }>();
  if (!row) return null;
  const settings = row.settings ? (JSON.parse(row.settings) as { showAgentNames?: boolean }) : {};
  return { ...claims, contactId: row.contactId, allowedOrigins: JSON.parse(row.origins) as string[], showAgentNames: settings.showAgentNames === true } as unknown as VisitorContext;
}

export function visitorRepositories(database: Database, ctx: VisitorContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;

  /** Takes the visitor's ID as ?3. */
  const CONVERSATION_COLUMNS = `c.id, c.status, c.last_public_seq AS lastSeq, c.created_at AS createdAt,
    COALESCE((SELECT r.read_seq FROM conversation_read_cursors r
               WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id AND r.reader_type = 'visitor' AND r.reader_id = ?3), 0) AS readSeq,
    COALESCE((SELECT m.public_seq FROM messages m
               WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.public_seq IS NOT NULL
                 AND m.seq <= (SELECT MAX(r.read_seq) FROM conversation_read_cursors r
                                WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id AND r.reader_type = 'member')
               ORDER BY m.seq DESC LIMIT 1), 0) AS agentReadSeq`;

  const findOwn = (conversationId: string) =>
    d1
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.workspace_id = ?1 AND c.id = ?2 AND c.contact_id = ?4`)
      .bind(w, conversationId, ctx.visitorId, ctx.contactId)
      .first<VisitorConversationRow>();

  /** Only their own message, so that a client ID cannot be used to read anything else. */
  const findSent = (conversationId: string, clientMessageId: string) =>
    d1
      .prepare(`${MESSAGE_SELECT} WHERE m.workspace_id = ?2 AND m.conversation_id = ?3 AND m.client_message_id = ?4 AND m.visibility = 'public' AND m.sender_type = 'visitor' AND m.sender_id = ?5`)
      .bind(ctx.contactId, w, conversationId, clientMessageId, ctx.visitorId)
      .first<VisitorMessageRow>();

  return {
    conversations: {
      get: findOwn,

      async list(): Promise<VisitorConversationRow[]> {
        const { results } = await d1
          .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations c WHERE c.workspace_id = ?1 AND c.contact_id = ?2 ORDER BY c.last_message_at DESC LIMIT 50`)
          .bind(w, ctx.contactId, ctx.visitorId)
          .all<VisitorConversationRow>();
        return results;
      },

      /**
       * The conversation's ID comes from the visitor and the client ID, so a retry reaches the same row and
       * the message insert becomes a replay. The first statement after the insert only runs for a new message.
       */
      async create(input: { clientMessageId: string; content: string }): Promise<{ created: boolean; conversation: VisitorConversationRow; message: VisitorMessageRow }> {
        const id = await deterministicId('conversation', `${ctx.visitorId}|${input.clientMessageId}`);
        const messageId = newId('message');
        const [, insert] = await d1.batch([
          d1
            .prepare(
              `INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ${DB_NOW_MS}, ${DB_NOW_MS}, ${DB_NOW_MS}) ON CONFLICT (id) DO NOTHING`,
            )
            .bind(id, w, ctx.websiteId, ctx.contactId),
          ...messageStatements(d1, {
            id: messageId,
            workspaceId: w,
            conversationId: id,
            clientMessageId: input.clientMessageId,
            sender: { type: 'visitor', id: ctx.visitorId },
            type: 'text',
            content: input.content,
            ownerContactId: ctx.contactId,
          }),
          d1
            .prepare(
              `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
               SELECT ?1, c.workspace_id, 'conversation.created', c.id, json_object('conversationId', c.id), ${DB_NOW_MS}
                 FROM conversations c WHERE c.workspace_id = ?2 AND c.id = ?3 AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ?4)`,
            )
            .bind(newId('outbox'), w, id, messageId),
        ]);
        const [conversation, message] = await Promise.all([findOwn(id), findSent(id, input.clientMessageId)]);
        if (!conversation || !message) throw new Error('A conversation was not readable after its batch');
        return { created: insert?.meta.changes === 1, conversation, message };
      },
    },

    attachments: {
      /** False unless this is a conversation of theirs. Pending until its bytes are stored. */
      async begin(input: NewAttachment): Promise<boolean> {
        const result = await d1
          .prepare(
            `INSERT INTO attachments (id, workspace_id, conversation_id, storage_key, filename, content_type, size, status, uploaded_by_type, uploaded_by_id, created_at)
             SELECT ?1, workspace_id, id, ?2, ?3, ?4, ?5, 'pending', 'visitor', ?6, ${DB_NOW_MS} FROM conversations WHERE workspace_id = ?7 AND id = ?8 AND contact_id = ?9`,
          )
          .bind(input.id, attachmentKey(w, input.conversationId, input.id), input.filename, input.contentType, input.size, ctx.visitorId, w, input.conversationId, ctx.contactId)
          .run();
        return result.meta.changes === 1;
      },

      async finish(id: string): Promise<void> {
        await d1.prepare(`UPDATE attachments SET status = 'ready' WHERE workspace_id = ?1 AND id = ?2 AND uploaded_by_type = 'visitor' AND uploaded_by_id = ?3`).bind(w, id, ctx.visitorId).run();
      },

      async abandon(id: string): Promise<void> {
        await d1.prepare(`DELETE FROM attachments WHERE workspace_id = ?1 AND id = ?2 AND message_id IS NULL AND uploaded_by_type = 'visitor' AND uploaded_by_id = ?3`).bind(w, id, ctx.visitorId).run();
      },

      /** A file on a public message in a conversation of theirs. A note's file, or one an agent has not sent yet, does not exist here. */
      get(id: string): Promise<AttachmentRow | null> {
        return d1
          .prepare(
            `${ATTACHMENT_SELECT} WHERE workspace_id = ?1 AND id = ?2 AND status = 'ready' AND EXISTS (
               SELECT 1 FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
                WHERE m.workspace_id = attachments.workspace_id AND m.id = attachments.message_id AND m.visibility = 'public' AND c.contact_id = ?3)`,
          )
          .bind(w, id, ctx.contactId)
          .first<AttachmentRow>();
      },
    },

    messages: {
      async send(conversationId: string, input: { clientMessageId: string; content: string; attachmentIds?: string[] }): Promise<VisitorSendResult> {
        const [insert] = await d1.batch(
          messageStatements(d1, {
            id: newId('message'),
            workspaceId: w,
            conversationId,
            clientMessageId: input.clientMessageId,
            sender: { type: 'visitor', id: ctx.visitorId },
            type: 'text',
            content: input.content,
            ownerContactId: ctx.contactId,
            ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
          }),
        );
        const message = await findSent(conversationId, input.clientMessageId);
        if (message) return { outcome: insert?.meta.changes === 1 ? 'created' : 'replayed', message };
        if (!(await findOwn(conversationId))) return { outcome: 'not_found' };
        // A taken client ID comes first: what is sent with it may never have been this visitor's.
        const taken = await d1.prepare(`SELECT 1 AS found FROM messages WHERE workspace_id = ?1 AND conversation_id = ?2 AND client_message_id = ?3`).bind(w, conversationId, input.clientMessageId).first();
        return taken || !input.attachmentIds?.length ? { outcome: 'conflict' } : { outcome: 'invalid_attachments' };
      },

      /** Oldest first. An unknown or foreign conversation simply has no rows. */
      async list(conversationId: string, input: { afterSeq?: number | undefined; beforeSeq?: number | undefined; limit: number }): Promise<VisitorMessageRow[]> {
        const backward = input.beforeSeq !== undefined;
        const { results } = await d1
          .prepare(
            `${MESSAGE_SELECT} WHERE m.workspace_id = ?2 AND m.conversation_id = ?3 AND m.visibility = 'public'
               AND ${backward ? 'm.public_seq < ?4 ORDER BY m.public_seq DESC' : 'm.public_seq > ?4 ORDER BY m.public_seq'} LIMIT ?5`,
          )
          .bind(ctx.contactId, w, conversationId, backward ? input.beforeSeq : (input.afterSeq ?? 0), Math.min(input.limit, 100))
          .all<VisitorMessageRow>();
        return backward ? results.reverse() : results;
      },

      /** In the visitor's own sequence. Positions only move forward, and stop at the last public message. */
      async markRead(conversationId: string, input: { deliveredSeq: number; readSeq: number }): Promise<{ deliveredSeq: number; readSeq: number } | null> {
        return d1
          .prepare(
            `INSERT INTO conversation_read_cursors (workspace_id, conversation_id, reader_type, reader_id, delivered_seq, read_seq, updated_at)
             SELECT c.workspace_id, c.id, 'visitor', ?1, MIN(MAX(?2, ?3), c.last_public_seq), MIN(?3, c.last_public_seq), ${DB_NOW_MS}
               FROM conversations c WHERE c.workspace_id = ?4 AND c.id = ?5 AND c.contact_id = ?6
             ON CONFLICT (workspace_id, conversation_id, reader_type, reader_id) DO UPDATE
               SET delivered_seq = MAX(delivered_seq, excluded.delivered_seq), read_seq = MAX(read_seq, excluded.read_seq), updated_at = excluded.updated_at
             RETURNING delivered_seq AS deliveredSeq, read_seq AS readSeq`,
          )
          .bind(ctx.visitorId, input.deliveredSeq, input.readSeq, w, conversationId, ctx.contactId)
          .first<{ deliveredSeq: number; readSeq: number }>();
      },
    },

    profile: {
      /** Consent keeps its first timestamp while it stays on, and withdrawing clears it. */
      async update(input: { name?: string | undefined; email?: string | undefined; followUpConsent?: boolean | undefined }): Promise<void> {
        const consent = input.followUpConsent === undefined ? null : input.followUpConsent ? 1 : 0;
        await d1
          .prepare(
            `UPDATE contacts SET name = COALESCE(?1, name), email = COALESCE(?2, email),
                    follow_up_consent_at = CASE ?3 WHEN 1 THEN COALESCE(follow_up_consent_at, ${DB_NOW_MS}) WHEN 0 THEN NULL ELSE follow_up_consent_at END,
                    follow_up_consent_source = CASE ?3 WHEN 1 THEN COALESCE(follow_up_consent_source, 'widget') WHEN 0 THEN NULL ELSE follow_up_consent_source END,
                    updated_at = ${DB_NOW_MS}
              WHERE workspace_id = ?4 AND id = ?5`,
          )
          .bind(input.name ?? null, input.email ?? null, consent, w, ctx.contactId)
          .run();
      },
    },
  };
}
