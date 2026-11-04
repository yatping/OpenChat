/**
 * Conversations and messages, for agents. Visitor-facing code does not use this file: it has its own
 * repository, which cannot read internal notes. Write rules: docs/architecture/data-model.md.
 */
import { canAssignConversation, signTicket, TICKET_TTL_SECONDS, verifyTicket, type TicketClaims } from '@openchat/auth';
import { repositories, type ContactRow, type ConversationChange, type ConversationRow, type ConversationStatus, type Database, type StoredMessage, type WorkspaceContext } from '@openchat/database';
import { AppError, notFound, toIso } from '@openchat/shared';
import type { AuthDeps } from './auth-flows';
import { requireCapability } from './workspaces';

const invalidCursor = () => new AppError(400, 'invalid_cursor', 'This cursor is not valid for these filters');

const toConversation = (row: ConversationRow) => ({
  id: row.id,
  websiteId: row.websiteId,
  contactId: row.contactId,
  contactName: row.contactName,
  contactEmail: row.contactEmail,
  tags: JSON.parse(row.tagsJson) as { id: string; name: string }[],
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

export const toMessage = (row: StoredMessage) => ({
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

const SYNC = 'sync';
/** Commits can land slightly out of time order, so catching up always looks a little further back. */
const SYNC_OVERLAP_MS = 5000;

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
  input: { status: ConversationStatus; assignee?: string | undefined; cursor?: string | undefined; updatedAfter?: string | undefined; limit: number },
) {
  const repo = repositories(db, ctx).conversations;
  const syncCursorAt = async () => encodeCursor({ v: 1, f: SYNC, at: (await repo.now()) - SYNC_OVERLAP_MS, id: '' });
  if (input.updatedAfter) {
    const after = decodeCursor(input.updatedAfter, SYNC);
    const rows = await repo.listChangedSince({ updatedAt: after.at, id: after.id }, input.limit + 1);
    const changed = rows.slice(0, input.limit);
    const last = changed.at(-1);
    const position = rows.length > input.limit && last ? encodeCursor({ v: 1, f: SYNC, at: last.updatedAt, id: last.id }) : null;
    return { data: changed.map(toConversation), nextCursor: position, syncCursor: position ?? (await syncCursorAt()) };
  }
  const assignee = input.assignee === undefined ? undefined : input.assignee === 'none' ? null : input.assignee === 'me' ? ctx.memberId : input.assignee;
  const filters = `${input.status}|${assignee === undefined ? '*' : (assignee ?? 'none')}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, filters) : undefined;
  const rows = await repo.list({
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
    syncCursor: await syncCursorAt(),
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

const AGENT_SOCKET_MS = 15 * 60 * 1000;
const VISITOR_SOCKET_MS = 60 * 60 * 1000;

/** The first half of a connection. The member was just authorised, so the ticket proves it. */
export async function createAgentTicket(deps: Pick<AuthDeps, 'signingKey' | 'installationId'>, ctx: WorkspaceContext, origin: string | undefined) {
  return issueTicket(deps, { kind: 'agent', sub: ctx.memberId, wid: ctx.workspaceId, role: ctx.role, until: Date.now() + AGENT_SOCKET_MS, ...(origin ? { org: origin } : {}), iss: deps.installationId });
}

export async function issueTicket(deps: Pick<AuthDeps, 'signingKey'>, claims: Omit<TicketClaims, 'aud' | 'iat' | 'exp'>) {
  const now = Math.floor(Date.now() / 1000);
  return { ticket: await signTicket(deps.signingKey, claims, now), expiresAt: toIso((now + TICKET_TTL_SECONDS) * 1000) };
}

export const visitorSocketUntil = () => Date.now() + VISITOR_SOCKET_MS;

/** The second half. A wrong page is refused here, because browsers send Origin on a WebSocket and any site can try. */
export async function verifyConnection(deps: Pick<AuthDeps, 'verificationKeys' | 'installationId'>, ticket: string, origin: string | undefined): Promise<TicketClaims> {
  const verified = await verifyTicket(ticket, deps.verificationKeys, deps.installationId);
  if (!verified.ok) throw new AppError(401, 'invalid_ticket', 'Ask for a new ticket');
  if (origin !== verified.claims.org) throw new AppError(403, 'bad_origin', 'This ticket was issued to another page');
  return verified.claims;
}

export async function markConversationRead(db: Database, ctx: WorkspaceContext, conversationId: string, input: { deliveredSeq: number; readSeq: number }) {
  const position = await repositories(db, ctx).conversations.markRead(conversationId, input);
  if (!position) throw notFound();
  return position;
}

const toContact = (row: ContactRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  firstSeenAt: toIso(row.firstSeenAt),
  lastSeenAt: toIso(row.lastSeenAt),
});

export async function getContact(db: Database, ctx: WorkspaceContext, contactId: string) {
  requireCapability(ctx, 'conversation.view');
  const row = await repositories(db, ctx).contacts.get(contactId);
  if (!row) throw notFound();
  return toContact(row);
}

export async function updateContact(db: Database, ctx: WorkspaceContext, contactId: string, change: { name?: string | null | undefined; email?: string | null | undefined; phone?: string | null | undefined }) {
  requireCapability(ctx, 'conversation.reply');
  const contacts = repositories(db, ctx).contacts;
  if (!(await contacts.update(contactId, change))) throw notFound();
  return toContact((await contacts.get(contactId))!);
}

export async function listTags(db: Database, ctx: WorkspaceContext) {
  requireCapability(ctx, 'conversation.view');
  return { data: await repositories(db, ctx).tags.list() };
}

export async function createTag(db: Database, ctx: WorkspaceContext, name: string) {
  requireCapability(ctx, 'conversation.reply');
  const result = await repositories(db, ctx).tags.create(name);
  if (!result) throw new AppError(409, 'tag_limit', 'This workspace has too many tags. Delete some first');
  return result;
}

export async function deleteTag(db: Database, ctx: WorkspaceContext, tagId: string) {
  requireCapability(ctx, 'workspace.manage');
  if (!(await repositories(db, ctx).tags.delete(tagId))) throw notFound();
}

export async function setConversationTags(db: Database, ctx: WorkspaceContext, conversationId: string, tagIds: string[]) {
  requireCapability(ctx, 'conversation.reply');
  const outcome = await repositories(db, ctx).conversations.setTags(conversationId, [...new Set(tagIds)]);
  if (outcome === 'not_found') throw notFound();
  if (outcome === 'unknown_tag') throw new AppError(400, 'unknown_tag', 'One of these tags does not exist in this workspace');
}
