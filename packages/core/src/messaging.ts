/**
 * Conversations and messages, for agents. Visitor-facing code does not use this file: it has its own
 * repository, which cannot read internal notes. Write rules: docs/architecture/data-model.md.
 */
import { canAssignConversation } from '@openchat/auth';
import { repositories, type ConversationChange, type ConversationRow, type ConversationStatus, type Database, type StoredMessage, type WorkspaceContext } from '@openchat/database';
import { AppError, notFound, toIso } from '@openchat/shared';
import { requireCapability } from './workspaces';

const invalidCursor = () => new AppError(400, 'invalid_cursor', 'This cursor is not valid for these filters');

const toConversation = (row: ConversationRow) => ({
  id: row.id,
  websiteId: row.websiteId,
  contactId: row.contactId,
  assignedMemberId: row.assignedMemberId,
  status: row.status,
  priority: row.priority,
  subject: row.subject,
  version: row.version,
  lastMessageSeq: row.lastMessageSeq,
  lastMessageAt: row.lastMessageAt === null ? null : toIso(row.lastMessageAt),
  lastReadSeq: row.lastReadSeq,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

const toMessage = (row: StoredMessage) => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq,
  publicSeq: row.publicSeq,
  clientMessageId: row.clientMessageId,
  sender: { type: row.senderType as 'visitor' | 'member' | 'system', id: row.senderId, displayName: row.senderName },
  type: row.type,
  visibility: row.visibility,
  content: row.content,
  attachments: [],
  createdAt: toIso(row.createdAt),
  metadata: {},
});

interface InboxCursor {
  v: 1;
  /** The filters it was issued for. A cursor is refused under any others. */
  f: string;
  at: number;
  id: string;
}

const encodeCursor = (cursor: InboxCursor) => btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeCursor(value: string, filters: string): InboxCursor {
  let cursor: Partial<InboxCursor> | null;
  try {
    cursor = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as Partial<InboxCursor> | null;
  } catch {
    throw invalidCursor();
  }
  if (cursor?.v !== 1 || cursor.f !== filters || typeof cursor.at !== 'number' || typeof cursor.id !== 'string') throw invalidCursor();
  return cursor as InboxCursor;
}

export async function listConversations(
  db: Database,
  ctx: WorkspaceContext,
  input: { status: ConversationStatus; assignee?: string | undefined; cursor?: string | undefined; limit: number },
) {
  const assignee = input.assignee === undefined ? undefined : input.assignee === 'none' ? null : input.assignee === 'me' ? ctx.memberId : input.assignee;
  const filters = `${input.status}|${assignee === undefined ? '*' : (assignee ?? 'none')}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, filters) : undefined;
  const rows = await repositories(db, ctx).conversations.list({
    status: input.status,
    assignee,
    before: cursor ? { lastMessageAt: cursor.at, id: cursor.id } : undefined,
    limit: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    data: page.map(toConversation),
    nextCursor: rows.length > input.limit && last?.lastMessageAt != null ? encodeCursor({ v: 1, f: filters, at: last.lastMessageAt, id: last.id }) : null,
  };
}

export async function getConversation(db: Database, ctx: WorkspaceContext, conversationId: string) {
  const row = await repositories(db, ctx).conversations.get(conversationId);
  if (!row) throw notFound();
  return toConversation(row);
}

/**
 * The assignment rule reads the current assignee. The update only applies at the version the client names, and
 * the rule is only applied when that is also the version read, so the row cannot have changed in between.
 */
export async function updateConversation(db: Database, ctx: WorkspaceContext, conversationId: string, input: ConversationChange & { expectedVersion: number }) {
  requireCapability(ctx, 'conversation.reply');
  const conversations = repositories(db, ctx).conversations;
  const current = await conversations.get(conversationId);
  if (!current) throw notFound();
  const conflict = (currentVersion: number) => new AppError(409, 'version_conflict', 'Someone else changed this conversation', { currentVersion });
  if (current.version !== input.expectedVersion) throw conflict(current.version);

  const { expectedVersion, ...change } = input;
  if (change.assignedMemberId !== undefined) {
    const allowed = canAssignConversation(ctx.role, { actorMemberId: ctx.memberId, currentAssigneeId: current.assignedMemberId, newAssigneeId: change.assignedMemberId });
    if (!allowed) throw new AppError(403, 'forbidden', 'Your role does not allow this');
  }

  const result = await conversations.update(conversationId, change, expectedVersion);
  if (result.outcome === 'not_found') throw notFound();
  if (result.outcome === 'conflict') throw conflict(result.currentVersion);
  if (result.outcome === 'invalid_assignee') throw new AppError(400, 'invalid_assignee', 'That person is not an active member of this workspace');
  const updated = await conversations.get(conversationId);
  if (!updated) throw notFound();
  return toConversation(updated);
}

export async function listMessages(db: Database, ctx: WorkspaceContext, conversationId: string, input: { afterSeq?: number | undefined; beforeSeq?: number | undefined; limit: number }) {
  if (input.afterSeq !== undefined && input.beforeSeq !== undefined) throw new AppError(400, 'validation_failed', 'Use afterSeq or beforeSeq, not both');
  const repos = repositories(db, ctx);
  if (!(await repos.conversations.get(conversationId))) throw notFound();
  return { data: (await repos.messages.list(conversationId, input)).map(toMessage) };
}

export async function sendMessage(db: Database, ctx: WorkspaceContext, conversationId: string, input: { clientMessageId: string; type: 'text' | 'internal_note'; content: string }) {
  requireCapability(ctx, input.type === 'internal_note' ? 'conversation.note' : 'conversation.reply');
  const result = await repositories(db, ctx).messages.send({ conversationId, clientMessageId: input.clientMessageId, sender: { type: 'member', id: ctx.memberId }, type: input.type, content: input.content });
  if (result.outcome === 'not_found') throw notFound();
  return { created: result.outcome === 'created', message: toMessage(result.message) };
}

export async function markConversationRead(db: Database, ctx: WorkspaceContext, conversationId: string, input: { deliveredSeq: number; readSeq: number }): Promise<void> {
  if (!(await repositories(db, ctx).conversations.markRead(conversationId, input))) throw notFound();
}
