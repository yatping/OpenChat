/**
 * Everything a visitor can do. Anyone can reach this code, so it uses only visitor repositories, which cannot
 * read internal notes. See docs/architecture/security.md#visitor-authentication.
 */
import { generateOpaqueToken, hashOpaqueToken, signVisitorToken, verifyVisitorToken, VISITOR_TOKEN_TTL_SECONDS } from '@openchat/auth';
import {
  authorizeVisitor,
  createVisitor,
  findWebsiteByKey,
  resumeVisitor,
  visitorRepositories,
  type PublicWebsite,
  type VisitorContext,
  type VisitorConversationRow,
  type VisitorMessageRow,
} from '@openchat/database';
import { AppError, notFound, toIso } from '@openchat/shared';
import { enforce, limitKey, LIMITS, type AuthDeps } from './auth-flows';
import { issueTicket, visitorSocketUntil } from './messaging';

export type { VisitorContext };

const badOrigin = () => new AppError(403, 'bad_origin', 'This website does not allow requests from this origin');
const unauthorized = () => new AppError(401, 'unauthorized', 'Start a new visitor session');

/**
 * Stops other websites embedding this widget. It is not authentication, since any script can forge the header.
 * A request with no Origin is not from a browser page, so it has nothing here to protect it from.
 */
export function assertVisitorOrigin(ctx: Pick<VisitorContext, 'allowedOrigins'>, origin: string | undefined): void {
  if (origin !== undefined && !ctx.allowedOrigins.includes(origin)) throw badOrigin();
}

const toConversation = (row: VisitorConversationRow) => ({
  id: row.id,
  status: row.status as 'open' | 'pending' | 'resolved' | 'archived',
  lastSeq: row.lastSeq,
  readSeq: row.readSeq,
  agentReadSeq: row.agentReadSeq,
  createdAt: toIso(row.createdAt),
});

/** Copied field by field, so that a new column cannot reach a visitor by default. */
const toMessage = (row: VisitorMessageRow, ctx: VisitorContext) => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq,
  // As on the socket: another person's client ID is no business of a visitor's.
  clientMessageId: row.senderType === 'visitor' ? row.clientMessageId : null,
  sender: { type: row.senderType, displayName: row.senderType === 'member' && !ctx.showAgentNames ? null : row.senderName },
  type: row.type,
  content: row.content,
  attachments: [],
  createdAt: toIso(row.createdAt),
});

export const websiteForWidget = (deps: Pick<AuthDeps, 'db'>, websiteKey: string): Promise<PublicWebsite | null> => findWebsiteByKey(deps.db, websiteKey);

export async function createVisitorSession(deps: AuthDeps, input: { websiteKey: string; refreshToken?: string | undefined; origin: string | undefined; ip: string }) {
  await enforce(deps.limiter, await limitKey('visitor-session-ip', input.ip), LIMITS.visitorSessionIp);
  const website = await findWebsiteByKey(deps.db, input.websiteKey);
  if (!website) throw notFound();
  // Required here, unlike later requests: this is the check that stops other sites starting sessions.
  if (!input.origin || !website.allowedOrigins.includes(input.origin)) throw badOrigin();
  await enforce(deps.limiter, await limitKey('visitor-session-website', website.id), LIMITS.visitorSessionWebsite);

  let refreshToken = input.refreshToken;
  let visitorId = refreshToken ? await resumeVisitor(deps.db, website.id, await hashOpaqueToken(refreshToken)) : null;
  if (!visitorId) {
    refreshToken = generateOpaqueToken();
    visitorId = await createVisitor(deps.db, website, await hashOpaqueToken(refreshToken));
  }

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signVisitorToken(deps.signingKey, { visitorId, workspaceId: website.workspaceId, websiteId: website.id, installationId: deps.installationId }, now);
  return { visitorId, accessToken, accessTokenExpiresAt: toIso((now + VISITOR_TOKEN_TTL_SECONDS) * 1000), refreshToken: refreshToken! };
}

export async function authenticateVisitor(deps: Pick<AuthDeps, 'db' | 'verificationKeys' | 'installationId'>, token: string): Promise<VisitorContext> {
  const verified = await verifyVisitorToken(token, deps.verificationKeys, deps.installationId);
  if (!verified.ok) throw unauthorized();
  const ctx = await authorizeVisitor(deps.db, { visitorId: verified.claims.sub, workspaceId: verified.claims.wid, websiteId: verified.claims.site });
  if (!ctx) throw unauthorized();
  return ctx;
}

/** Per visitor for one person, and per website so that many visitors cannot fill the shared database. */
async function limitMessage(deps: Pick<AuthDeps, 'limiter'>, ctx: VisitorContext) {
  await enforce(deps.limiter, await limitKey('visitor-message', ctx.visitorId), LIMITS.visitorMessage);
  await enforce(deps.limiter, await limitKey('website-messages', ctx.websiteId), LIMITS.websiteVisitorMessages);
}

export async function updateVisitorProfile(deps: Pick<AuthDeps, 'db'>, ctx: VisitorContext, input: { name?: string | undefined; email?: string | undefined; followUpConsent?: boolean | undefined }) {
  await visitorRepositories(deps.db, ctx).profile.update(input);
}

export async function listVisitorConversations(deps: Pick<AuthDeps, 'db'>, ctx: VisitorContext) {
  return { data: (await visitorRepositories(deps.db, ctx).conversations.list()).map(toConversation) };
}

export async function createVisitorConversation(deps: Pick<AuthDeps, 'db' | 'limiter'>, ctx: VisitorContext, input: { clientMessageId: string; content: string }) {
  await limitMessage(deps, ctx);
  const { created, conversation, message } = await visitorRepositories(deps.db, ctx).conversations.create(input);
  return { created, messageId: message.id, conversation: { ...toConversation(conversation), message: toMessage(message, ctx) } };
}

export async function listVisitorMessages(deps: Pick<AuthDeps, 'db'>, ctx: VisitorContext, conversationId: string, input: { afterSeq?: number | undefined; beforeSeq?: number | undefined; limit: number }) {
  if (input.afterSeq !== undefined && input.beforeSeq !== undefined) throw new AppError(400, 'validation_failed', 'Use afterSeq or beforeSeq, not both');
  const repos = visitorRepositories(deps.db, ctx);
  if (!(await repos.conversations.get(conversationId))) throw notFound();
  return { data: (await repos.messages.list(conversationId, input)).map((row) => toMessage(row, ctx)) };
}

export async function sendVisitorMessage(deps: Pick<AuthDeps, 'db' | 'limiter'>, ctx: VisitorContext, conversationId: string, input: { clientMessageId: string; content: string }) {
  await limitMessage(deps, ctx);
  const result = await visitorRepositories(deps.db, ctx).messages.send(conversationId, input);
  if (result.outcome === 'not_found') throw notFound();
  if (result.outcome === 'conflict') throw new AppError(409, 'client_message_id_taken', 'Send this message again with a new clientMessageId');
  return { created: result.outcome === 'created', message: toMessage(result.message, ctx) };
}

export async function markVisitorConversationRead(deps: Pick<AuthDeps, 'db'>, ctx: VisitorContext, conversationId: string, input: { deliveredSeq: number; readSeq: number }) {
  const position = await visitorRepositories(deps.db, ctx).messages.markRead(conversationId, input);
  if (!position) throw notFound();
  return position;
}

export async function createVisitorTicket(deps: Pick<AuthDeps, 'db' | 'signingKey' | 'installationId'>, ctx: VisitorContext, conversationId: string, origin: string | undefined) {
  if (!(await visitorRepositories(deps.db, ctx).conversations.get(conversationId))) throw notFound();
  return issueTicket(deps, { kind: 'visitor', sub: ctx.visitorId, wid: ctx.workspaceId, conv: conversationId, until: visitorSocketUntil(), ...(origin ? { org: origin } : {}), iss: deps.installationId });
}
