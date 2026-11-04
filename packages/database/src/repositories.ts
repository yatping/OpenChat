/**
 * Scoped repositories. Every query here applies ctx.workspaceId. A cross-tenant ID behaves exactly
 * like an ID that does not exist. Write patterns: docs/architecture/data-model.md.
 */
import { newId } from '@openchat/shared';
import type { Role, WorkspaceContext } from './context';
import type { WorkspaceRow } from './workspace-repository';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';
import { messageStatements } from './internal/message-statements';

export interface WebsiteRow {
  id: string;
  name: string;
  websiteKey: string;
  allowedOrigins: string[];
  settings: Record<string, unknown>;
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'suspended';
}

export type MemberChange = { outcome: 'done' } | { outcome: 'not_found' } | { outcome: 'forbidden' } | { outcome: 'last_owner' };

export type InvitationResult =
  | { outcome: 'created'; invitation: { id: string; email: string; role: string; expiresAt: number } }
  | { outcome: 'already_member' }
  | { outcome: 'forbidden' };

const WEBSITE_COLUMNS = `id, name, website_key AS websiteKey, allowed_origins_json AS originsJson, settings_json AS settingsJson`;
type RawWebsite = Omit<WebsiteRow, 'allowedOrigins' | 'settings'> & { originsJson: string; settingsJson: string | null };
const toWebsite = ({ originsJson, settingsJson, ...row }: RawWebsite): WebsiteRow => ({
  ...row,
  allowedOrigins: JSON.parse(originsJson) as string[],
  settings: settingsJson ? (JSON.parse(settingsJson) as Record<string, unknown>) : {},
});

const MEMBER_SELECT = `SELECT m.id, u.name, u.email, m.role, m.status FROM workspace_members m JOIN users u ON u.id = m.user_id`;

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
  /** The member's or contact's current name. Null if there is none, or the member has since left. */
  senderName: string | null;
}

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'archived';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TagRow {
  id: string;
  name: string;
}

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ConversationRow {
  id: string;
  websiteId: string;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  /** A JSON array of TagRow. */
  tagsJson: string;
  assignedMemberId: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  subject: string | null;
  version: number;
  lastMessageSeq: number;
  lastPublicSeq: number;
  lastMessageAt: number | null;
  /** The calling member's own read position. */
  lastReadSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationChange {
  /** Null unassigns. Undefined leaves the assignee alone. */
  assignedMemberId?: string | null | undefined;
  status?: ConversationStatus | undefined;
  priority?: ConversationPriority | undefined;
}

/** A member ID, or null for conversations nobody is assigned to. */
export interface ConversationFilter {
  status: ConversationStatus;
  assignee?: string | null | undefined;
  before?: { lastMessageAt: number; id: string } | undefined;
  limit: number;
}

export type SendResult =
  | { outcome: 'created'; message: StoredMessage }
  | { outcome: 'replayed'; message: StoredMessage }
  | { outcome: 'not_found' };

export type AssignResult =
  | { outcome: 'updated'; version: number }
  | { outcome: 'conflict'; currentVersion: number }
  | { outcome: 'invalid_assignee' }
  | { outcome: 'not_found' };

/** Names come by primary key, so that this stays cheap on the hot path. Agents only: it includes internal notes. */
export const MESSAGE_SELECT = `SELECT m.id, m.conversation_id AS conversationId, m.seq, m.public_seq AS publicSeq,
    m.client_message_id AS clientMessageId, m.sender_type AS senderType, m.sender_id AS senderId,
    m.message_type AS type, m.visibility, m.content, m.created_at AS createdAt, COALESCE(u.name, ct.name) AS senderName
  FROM messages m
  LEFT JOIN workspace_members sm ON m.sender_type = 'member' AND sm.workspace_id = m.workspace_id AND sm.id = m.sender_id
  LEFT JOIN users u ON u.id = sm.user_id
  LEFT JOIN visitors sv ON m.sender_type = 'visitor' AND sv.workspace_id = m.workspace_id AND sv.id = m.sender_id
  LEFT JOIN contacts ct ON ct.workspace_id = sv.workspace_id AND ct.id = sv.contact_id`;

/** ?1 is the calling member, for their read position. */
const CONTACT_SELECT = `SELECT id, name, email, phone, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt FROM contacts`;
const MAX_TAGS = 500;

/** The tags are read by primary key per row, and a page is at most 100 rows. */
export const CONVERSATION_TAGS_JSON = `(SELECT COALESCE(json_group_array(json_object('id', t.id, 'name', t.name)), '[]')
       FROM conversation_tags ct JOIN tags t ON t.workspace_id = ct.workspace_id AND t.id = ct.tag_id
      WHERE ct.workspace_id = c.workspace_id AND ct.conversation_id = c.id)`;

const CONVERSATION_SELECT = `SELECT c.id, c.website_id AS websiteId, c.contact_id AS contactId, k.name AS contactName, k.email AS contactEmail,
    ${CONVERSATION_TAGS_JSON} AS tagsJson, c.assigned_member_id AS assignedMemberId,
    c.status, c.priority, c.subject, c.version, c.last_message_seq AS lastMessageSeq, c.last_public_seq AS lastPublicSeq,
    c.last_message_at AS lastMessageAt, COALESCE(r.read_seq, 0) AS lastReadSeq, c.created_at AS createdAt, c.updated_at AS updatedAt
  FROM conversations c
  JOIN contacts k ON k.workspace_id = c.workspace_id AND k.id = c.contact_id
  LEFT JOIN conversation_read_cursors r ON r.workspace_id = c.workspace_id AND r.conversation_id = c.id
    AND r.reader_type = 'member' AND r.reader_id = ?1`;

export function repositories(database: Database, ctx: WorkspaceContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;

  /**
   * The rules that must hold at commit, for a statement over target `t`. The actor is re-read, so a role
   * changed since this request was authorised counts. ?6 is the new role or NULL, and ?7 is true when the
   * change would leave the target unable to act as an owner.
   */
  const MAY_CHANGE_MEMBER = `
    EXISTS (SELECT 1 FROM workspace_members a
             WHERE a.workspace_id = t.workspace_id AND a.id = ?8 AND a.status = 'active'
               AND (a.role = 'owner' OR (a.role = 'admin' AND t.role <> 'owner' AND COALESCE(?6, '') <> 'owner')))
    AND (t.role <> 'owner' OR t.status <> 'active' OR ?7 = 0
         OR EXISTS (SELECT 1 FROM workspace_members o
                     WHERE o.workspace_id = t.workspace_id AND o.id <> t.id AND o.role = 'owner' AND o.status = 'active'))`;

  /** Explains a refused change. The batch has already decided, so this only chooses the message. */
  const explainRefusal = async (memberId: string): Promise<MemberChange> => {
    const target = await d1.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ?1 AND id = ?2`).bind(w, memberId).first<{ role: Role }>();
    if (!target) return { outcome: 'not_found' };
    return { outcome: target.role === 'owner' && ctx.role === 'owner' ? 'last_owner' : 'forbidden' };
  };

  const auditMemberChange = (auditId: string, action: string, memberId: string, role: Role | null, removesOwner: boolean, metadata: string) =>
    d1
      .prepare(
        `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
         SELECT ?1, t.workspace_id, 'member', ?8, ?2, 'member', t.id, ?3, ${DB_NOW_MS}
           FROM workspace_members t
          WHERE t.workspace_id = ?4 AND t.id = ?5 AND ${MAY_CHANGE_MEMBER}`,
      )
      .bind(auditId, action, metadata, w, memberId, role, removesOwner ? 1 : 0, ctx.memberId);

  /** So that the member's sockets close even if the isolate dies right after the commit. */
  const accessChanged = (memberId: string, audit: string) =>
    d1
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
         SELECT ?1, ?2, 'member.access_changed', ?3, json_object('memberId', ?3), ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?4)`,
      )
      .bind(newId('outbox'), w, memberId, audit);

  return {
    contacts: {
      get(contactId: string): Promise<ContactRow | null> {
        return d1.prepare(`${CONTACT_SELECT} WHERE workspace_id = ?1 AND id = ?2`).bind(w, contactId).first<ContactRow>();
      },
      /** Undefined leaves a field alone, and null clears it. */
      async update(contactId: string, change: { name?: string | null | undefined; email?: string | null | undefined; phone?: string | null | undefined }): Promise<boolean> {
        const field = (value: string | null | undefined) => [value === undefined ? 0 : 1, value ?? null];
        const result = await d1
          .prepare(
            `UPDATE contacts
                SET name = CASE WHEN ?1 THEN ?2 ELSE name END, email = CASE WHEN ?3 THEN ?4 ELSE email END,
                    phone = CASE WHEN ?5 THEN ?6 ELSE phone END, updated_at = ${DB_NOW_MS}
              WHERE workspace_id = ?7 AND id = ?8`,
          )
          .bind(...field(change.name), ...field(change.email), ...field(change.phone), w, contactId)
          .run();
        return result.meta.changes === 1;
      },
    },

    tags: {
      async list(): Promise<TagRow[]> {
        const { results } = await d1.prepare(`SELECT id, name FROM tags WHERE workspace_id = ?1 ORDER BY name LIMIT ${MAX_TAGS}`).bind(w).all<TagRow>();
        return results;
      },
      /** Null means that the workspace is at its limit, decided in SQL so that a race cannot exceed it. */
      async create(name: string): Promise<{ created: boolean; tag: TagRow } | null> {
        const insert = await d1
          .prepare(
            `INSERT INTO tags (id, workspace_id, name, created_at)
             SELECT ?1, ?2, ?3, ${DB_NOW_MS} WHERE (SELECT COUNT(*) FROM tags WHERE workspace_id = ?2) < ${MAX_TAGS}
             ON CONFLICT (workspace_id, name) DO NOTHING`,
          )
          .bind(newId('tag'), w, name)
          .run();
        const tag = await d1.prepare(`SELECT id, name FROM tags WHERE workspace_id = ?1 AND name = ?2`).bind(w, name).first<TagRow>();
        return tag ? { created: insert.meta.changes === 1, tag } : null;
      },
      async delete(tagId: string): Promise<boolean> {
        // D1 counts cascaded rows here too, so this cannot compare with 1.
        return (await d1.prepare(`DELETE FROM tags WHERE workspace_id = ?1 AND id = ?2`).bind(w, tagId).run()).meta.changes > 0;
      },
    },

    workspace: {
      get(): Promise<WorkspaceRow | null> {
        return d1.prepare(`SELECT id, name, slug, created_at AS createdAt FROM workspaces WHERE id = ?1`).bind(w).first<WorkspaceRow>();
      },
      async update(input: { name?: string | undefined }): Promise<WorkspaceRow | null> {
        return d1
          .prepare(`UPDATE workspaces SET name = COALESCE(?1, name), updated_at = ${DB_NOW_MS} WHERE id = ?2 RETURNING id, name, slug, created_at AS createdAt`)
          .bind(input.name ?? null, w)
          .first<WorkspaceRow>();
      },
    },

    members: {
      async list(input: { cursor?: string | undefined; limit: number }): Promise<{ data: MemberRow[]; nextCursor: string | null }> {
        const { results } = await d1
          .prepare(`${MEMBER_SELECT} WHERE m.workspace_id = ?1 AND m.id > ?2 ORDER BY m.id LIMIT ?3`)
          .bind(w, input.cursor ?? '', input.limit + 1)
          .all<MemberRow>();
        const data = results.slice(0, input.limit);
        return { data, nextCursor: results.length > input.limit ? (data.at(-1)?.id ?? null) : null };
      },
      get(memberId: string): Promise<MemberRow | null> {
        return d1.prepare(`${MEMBER_SELECT} WHERE m.workspace_id = ?1 AND m.id = ?2`).bind(w, memberId).first<MemberRow>();
      },
      async update(memberId: string, input: { role?: Role | undefined; status?: 'active' | 'suspended' | undefined }): Promise<MemberChange> {
        const audit = newId('audit');
        const role = input.role ?? null;
        const status = input.status ?? null;
        const removesOwner = (role !== null && role !== 'owner') || status === 'suspended';
        const metadata = JSON.stringify({ role, status });
        const [allowed] = await d1.batch([
          auditMemberChange(audit, 'member.updated', memberId, role, removesOwner, metadata),
          d1
            .prepare(
              `UPDATE workspace_members SET role = COALESCE(?1, role), status = COALESCE(?2, status), updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?3 AND id = ?4 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?5)`,
            )
            .bind(role, status, w, memberId, audit),
          accessChanged(memberId, audit),
        ]);
        return allowed?.meta.changes === 1 ? { outcome: 'done' } : explainRefusal(memberId);
      },
      async remove(memberId: string): Promise<MemberChange> {
        const audit = newId('audit');
        const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`;
        const [allowed] = await d1.batch([
          auditMemberChange(audit, 'member.removed', memberId, null, true, '{}'),
          // Assignment has no cascade, so these must be released first or the delete fails.
          d1
            .prepare(
              `UPDATE conversations SET assigned_member_id = NULL, version = version + 1, updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?1 AND assigned_member_id = ?2 AND ${guard}`,
            )
            .bind(w, memberId, audit),
          d1.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?1 AND id = ?2 AND ${guard}`).bind(w, memberId, audit),
          accessChanged(memberId, audit),
        ]);
        return allowed?.meta.changes === 1 ? { outcome: 'done' } : explainRefusal(memberId);
      },
    },

    invitations: {
      /** A new invitation replaces any pending one for the address. Its token is set when the email is sent. */
      async create(input: { email: string; role: Exclude<Role, 'owner'>; placeholderTokenHash: string; ttlMs: number }): Promise<InvitationResult> {
        const id = newId('invitation');
        const audit = newId('audit');
        const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`;
        const [allowed] = await d1.batch([
          d1
            .prepare(
              `INSERT INTO audit_log (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, created_at)
               SELECT ?1, a.workspace_id, 'member', a.id, 'invitation.created', 'invitation', ?2, json_object('role', ?3), ${DB_NOW_MS}
                 FROM workspace_members a
                WHERE a.workspace_id = ?4 AND a.id = ?5 AND a.status = 'active' AND a.role IN ('owner', 'admin')
                  AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
                                   WHERE m.workspace_id = a.workspace_id AND u.email = ?6)`,
            )
            .bind(audit, id, input.role, w, ctx.memberId, input.email),
          d1.prepare(`DELETE FROM invitations WHERE ${guard} AND workspace_id = ?2 AND email = ?3 AND accepted_at IS NULL`).bind(audit, w, input.email),
          d1
            .prepare(
              `INSERT INTO invitations (id, workspace_id, email, role, token_hash, invited_by_member_id, expires_at, created_at)
               SELECT ?2, ?3, ?4, ?5, ?6, ?7, ${DB_NOW_MS} + ?8, ${DB_NOW_MS} WHERE ${guard}`,
            )
            .bind(audit, id, w, input.email, input.role, input.placeholderTokenHash, ctx.memberId, input.ttlMs),
        ]);
        if (allowed?.meta.changes !== 1) return { outcome: ctx.role === 'owner' || ctx.role === 'admin' ? 'already_member' : 'forbidden' };
        const invitation = await d1
          .prepare(`SELECT id, email, role, expires_at AS expiresAt FROM invitations WHERE workspace_id = ?1 AND id = ?2`)
          .bind(w, id)
          .first<{ id: string; email: string; role: string; expiresAt: number }>();
        return { outcome: 'created', invitation: invitation! };
      },
    },

    websites: {
      async list(): Promise<WebsiteRow[]> {
        const { results } = await d1.prepare(`SELECT ${WEBSITE_COLUMNS} FROM websites WHERE workspace_id = ?1 ORDER BY id`).bind(w).all<RawWebsite>();
        return results.map(toWebsite);
      },
      async create(input: { name: string; websiteKey: string; allowedOrigins?: string[]; settings?: Record<string, unknown> | undefined }): Promise<WebsiteRow> {
        const id = newId('website');
        const allowedOrigins = input.allowedOrigins ?? [];
        const settings = input.settings ?? {};
        await d1
          .prepare(
            `INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ${DB_NOW_MS}, ${DB_NOW_MS})`,
          )
          .bind(id, w, input.name, input.websiteKey, JSON.stringify(allowedOrigins), JSON.stringify(settings))
          .run();
        return { id, name: input.name, websiteKey: input.websiteKey, allowedOrigins, settings };
      },
      async update(
        websiteId: string,
        input: { name?: string | undefined; allowedOrigins?: string[] | undefined; settings?: Record<string, unknown> | undefined },
      ): Promise<WebsiteRow | null> {
        const row = await d1
          .prepare(
            `UPDATE websites SET name = COALESCE(?1, name), allowed_origins_json = COALESCE(?2, allowed_origins_json),
                                 settings_json = COALESCE(?3, settings_json), updated_at = ${DB_NOW_MS}
              WHERE workspace_id = ?4 AND id = ?5 RETURNING ${WEBSITE_COLUMNS}`,
          )
          .bind(input.name ?? null, input.allowedOrigins ? JSON.stringify(input.allowedOrigins) : null, input.settings ? JSON.stringify(input.settings) : null, w, websiteId)
          .first<RawWebsite>();
        return row ? toWebsite(row) : null;
      },
    },

    conversations: {
      get(conversationId: string): Promise<ConversationRow | null> {
        return d1.prepare(`${CONVERSATION_SELECT} WHERE c.workspace_id = ?2 AND c.id = ?3`).bind(ctx.memberId, w, conversationId).first<ConversationRow>();
      },

      /**
       * An inbox view, newest first, using the inbox and assignee indexes. Every conversation starts with a
       * message in the same batch, so last_message_at is set and the row comparison is safe.
       */
      async list(filter: ConversationFilter): Promise<ConversationRow[]> {
        const assignee = filter.assignee === undefined ? '' : filter.assignee === null ? 'AND c.assigned_member_id IS NULL' : 'AND c.assigned_member_id = ?4';
        const before = filter.before ? 'AND (c.last_message_at, c.id) < (?5, ?6)' : '';
        const { results } = await d1
          .prepare(`${CONVERSATION_SELECT} WHERE c.workspace_id = ?2 AND c.status = ?3 ${assignee} ${before} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?7`)
          .bind(ctx.memberId, w, filter.status, filter.assignee ?? null, filter.before?.lastMessageAt ?? null, filter.before?.id ?? null, filter.limit)
          .all<ConversationRow>();
        return results;
      },

      /** Everything changed since a position, oldest change first, for a client catching up. */
      async listChangedSince(after: { updatedAt: number; id: string }, limit: number): Promise<ConversationRow[]> {
        const { results } = await d1
          .prepare(`${CONVERSATION_SELECT} WHERE c.workspace_id = ?2 AND (c.updated_at, c.id) > (?3, ?4) ORDER BY c.updated_at, c.id LIMIT ?5`)
          .bind(ctx.memberId, w, after.updatedAt, after.id, limit)
          .all<ConversationRow>();
        return results;
      },

      /**
       * Pattern 2: compare-and-set with follow-up statements, guarded by a value unique to this request.
       * Guarding on version = expected + 1 is wrong: if another writer already advanced the version, a stale
       * request would match it and write a false event. The assignee is checked here, so that someone removed
       * since the request was authorised cannot be assigned.
       */
      async update(conversationId: string, change: ConversationChange, expectedVersion: number): Promise<AssignResult> {
        const mutation = newId('mutation');
        const assigning = change.assignedMemberId !== undefined;
        const assignee = change.assignedMemberId ?? null;
        const event = (type: string, applies: boolean, field: string, value: string | null) =>
          d1
            .prepare(
              `INSERT INTO conversation_events (id, workspace_id, conversation_id, event_type, actor_type, actor_id, metadata_json, created_at)
               SELECT ?1, workspace_id, id, ?2, 'member', ?3, json_object(?4, ?5), ${DB_NOW_MS}
                 FROM conversations WHERE workspace_id = ?6 AND id = ?7 AND last_mutation_id = ?8 AND ?9`,
            )
            .bind(newId('event'), type, ctx.memberId, field, value, w, conversationId, mutation, applies ? 1 : 0);
        const [update] = await d1.batch([
          d1
            .prepare(
              `UPDATE conversations
                  SET assigned_member_id = CASE WHEN ?1 THEN ?2 ELSE assigned_member_id END,
                      status = COALESCE(?3, status), priority = COALESCE(?4, priority),
                      version = version + 1, last_mutation_id = ?5, updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?6 AND id = ?7 AND version = ?8
                  AND (NOT ?1 OR ?2 IS NULL OR EXISTS (SELECT 1 FROM workspace_members t
                        WHERE t.workspace_id = conversations.workspace_id AND t.id = ?2 AND t.status = 'active'))`,
            )
            .bind(assigning ? 1 : 0, assignee, change.status ?? null, change.priority ?? null, mutation, w, conversationId, expectedVersion),
          event('assigned', assigning, 'assignedMemberId', assignee),
          event('status_changed', change.status !== undefined, 'status', change.status ?? null),
          event('priority_changed', change.priority !== undefined, 'priority', change.priority ?? null),
          d1
            .prepare(
              `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
               SELECT ?1, workspace_id, 'conversation.updated', id, json_object('conversationId', id, 'version', version), ${DB_NOW_MS}
                 FROM conversations WHERE workspace_id = ?2 AND id = ?3 AND last_mutation_id = ?4`,
            )
            .bind(newId('outbox'), w, conversationId, mutation),
        ]);
        if (update?.meta.changes === 1) return { outcome: 'updated', version: expectedVersion + 1 };
        const current = await this.get(conversationId);
        if (!current) return { outcome: 'not_found' };
        return current.version === expectedVersion ? { outcome: 'invalid_assignee' } : { outcome: 'conflict', currentVersion: current.version };
      },

      assign(conversationId: string, memberId: string | null, expectedVersion: number): Promise<AssignResult> {
        return this.update(conversationId, { assignedMemberId: memberId }, expectedVersion);
      },

      /**
       * Pattern 2 without a version: the first statement applies only if the conversation and every tag are in
       * this workspace, and leaves a mark that guards the rest. Tagging does not conflict with anything else.
       */
      async setTags(conversationId: string, tagIds: string[]): Promise<'updated' | 'not_found' | 'unknown_tag'> {
        const mutation = newId('mutation');
        const ids = JSON.stringify(tagIds);
        const mine = `EXISTS (SELECT 1 FROM conversations WHERE workspace_id = ?1 AND id = ?2 AND last_mutation_id = ?3)`;
        const [update] = await d1.batch([
          d1
            .prepare(
              `UPDATE conversations SET last_mutation_id = ?3, updated_at = ${DB_NOW_MS}
                WHERE workspace_id = ?1 AND id = ?2
                  AND (SELECT COUNT(*) FROM tags WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?4))) = ?5`,
            )
            .bind(w, conversationId, mutation, ids, tagIds.length),
          d1.prepare(`DELETE FROM conversation_tags WHERE workspace_id = ?1 AND conversation_id = ?2 AND ${mine}`).bind(w, conversationId, mutation),
          d1
            .prepare(
              `INSERT INTO conversation_tags (workspace_id, conversation_id, tag_id, created_at)
               SELECT workspace_id, ?2, id, ${DB_NOW_MS} FROM tags WHERE workspace_id = ?1 AND id IN (SELECT value FROM json_each(?4)) AND ${mine}`,
            )
            .bind(w, conversationId, mutation, ids),
          d1
            .prepare(
              `INSERT INTO conversation_events (id, workspace_id, conversation_id, event_type, actor_type, actor_id, metadata_json, created_at)
               SELECT ?4, ?1, ?2, 'tags_changed', 'member', ?5, json_object('tagIds', json(?6)), ${DB_NOW_MS} WHERE ${mine}`,
            )
            .bind(w, conversationId, mutation, newId('event'), ctx.memberId, ids),
          d1
            .prepare(
              `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
               SELECT ?4, ?1, 'conversation.updated', ?2, json_object('conversationId', ?2), ${DB_NOW_MS} WHERE ${mine}`,
            )
            .bind(w, conversationId, mutation, newId('outbox')),
        ]);
        if (update?.meta.changes === 1) return 'updated';
        return (await this.get(conversationId)) ? 'unknown_tag' : 'not_found';
      },

      /** The database's clock, because update times come from it and a Worker's clock can disagree. */
      async now(): Promise<number> {
        return (await d1.prepare(`SELECT ${DB_NOW_MS} AS now`).first<{ now: number }>())!.now;
      },

      /** Positions only move forward, and stop at the last message. False if there is no such conversation. */
      async markRead(conversationId: string, input: { deliveredSeq: number; readSeq: number }): Promise<boolean> {
        const result = await d1
          .prepare(
            `INSERT INTO conversation_read_cursors (workspace_id, conversation_id, reader_type, reader_id, delivered_seq, read_seq, updated_at)
             SELECT c.workspace_id, c.id, 'member', ?1, MIN(MAX(?2, ?3), c.last_message_seq), MIN(?3, c.last_message_seq), ${DB_NOW_MS}
               FROM conversations c WHERE c.workspace_id = ?4 AND c.id = ?5
             ON CONFLICT (workspace_id, conversation_id, reader_type, reader_id) DO UPDATE
               SET delivered_seq = MAX(delivered_seq, excluded.delivered_seq), read_seq = MAX(read_seq, excluded.read_seq), updated_at = excluded.updated_at`,
          )
          .bind(ctx.memberId, input.deliveredSeq, input.readSeq, w, conversationId)
          .run();
        return result.meta.changes === 1;
      },
    },

    messages: {
      /**
       * Pattern 1: idempotent insert. Later statements are guarded by the fresh message ID, which
       * exists only if the insert took effect, so a replay or a wrong workspace changes nothing.
       */
      async send(input: SendMessageInput): Promise<SendResult> {
        const id = newId('message');
        const c = input.conversationId;
        const [insert] = await d1.batch(messageStatements(d1, { ...input, id, workspaceId: w }));

        const created = insert?.meta.changes === 1;
        const message = await d1
          .prepare(
            `${MESSAGE_SELECT} WHERE m.workspace_id = ?1 AND m.conversation_id = ?2 AND m.client_message_id = ?3`,
          )
          .bind(w, c, input.clientMessageId)
          .first<StoredMessage>();
        if (!message) return { outcome: 'not_found' };
        return { outcome: created ? 'created' : 'replayed', message };
      },

      /** Everything, including internal notes. For agents only. Oldest first, whichever direction was asked for. */
      async list(conversationId: string, input: { afterSeq?: number | undefined; beforeSeq?: number | undefined; limit: number }): Promise<StoredMessage[]> {
        const backward = input.beforeSeq !== undefined;
        const { results } = await d1
          .prepare(
            `${MESSAGE_SELECT} WHERE m.workspace_id = ?1 AND m.conversation_id = ?2 AND ${backward ? 'm.seq < ?3 ORDER BY m.seq DESC' : 'm.seq > ?3 ORDER BY m.seq'} LIMIT ?4`,
          )
          .bind(w, conversationId, backward ? input.beforeSeq : (input.afterSeq ?? 0), Math.min(input.limit, 100))
          .all<StoredMessage>();
        return backward ? results.reverse() : results;
      },

      listAfter(conversationId: string, afterSeq: number, limit = 50): Promise<StoredMessage[]> {
        return this.list(conversationId, { afterSeq, limit });
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
