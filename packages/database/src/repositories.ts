/**
 * Scoped repositories. Every query here applies ctx.workspaceId. A cross-tenant ID behaves exactly
 * like an ID that does not exist. Write patterns: docs/architecture/data-model.md.
 */
import { newId } from '@openchat/shared';
import type { Role, WorkspaceContext } from './context';
import type { WorkspaceRow } from './workspace-repository';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

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

  return {
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
