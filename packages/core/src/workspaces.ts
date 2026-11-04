/**
 * Workspaces, members, invitations, and websites. The role checks here give a clear 403 early. The checks
 * that must hold at commit, including the last-owner rule, are in the SQL of the repositories.
 */
import { can, generateOpaqueToken, hashOpaqueToken, hashPassword, type Capability } from '@openchat/auth';
import {
  acceptInvitation as acceptInBatch,
  authorizeWorkspaceMember,
  createWorkspace as createInBatch,
  inspectInvitation,
  prepareInvitationEmail,
  repositories,
  type Database,
  type MemberChange,
  type Principal,
  type Role,
  type WorkspaceContext,
  type WorkspaceRow,
} from '@openchat/database';
import type { EmailProvider } from '@openchat/email';
import { AppError, newId, notFound, toIso, type JobEnvelope } from '@openchat/shared';
import { enforce, escapeHtml, invalidToken, limitKey, LIMITS, type AuthDeps } from './auth-flows';

export const INVITATION_EMAIL_JOB = 'workspace.invitation_email';
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const forbidden = () => new AppError(403, 'forbidden', 'Your role does not allow this');

/** Any failure is 404, so that a workspace's existence does not leak. */
export async function workspaceContext(db: Database, principal: Principal, workspaceId: string): Promise<WorkspaceContext> {
  const ctx = await authorizeWorkspaceMember(db, principal.userId, workspaceId);
  if (!ctx) throw notFound();
  return ctx;
}

export const requireCapability = (ctx: WorkspaceContext, capability: Capability) => {
  if (!can(ctx.role, capability)) throw forbidden();
};

const toWorkspace = (row: WorkspaceRow) => ({ id: row.id, name: row.name, slug: row.slug, createdAt: toIso(row.createdAt) });

function slugFor(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${base || 'workspace'}-${suffix}`;
}

export async function createWorkspace(db: Database, principal: Principal, name: string) {
  const row = await createInBatch(db, { userId: principal.userId, name, slug: slugFor(name) });
  if (!row) throw new AppError(403, 'signup_closed', 'This installation is invite-only');
  return toWorkspace(row);
}

export async function getWorkspace(db: Database, ctx: WorkspaceContext) {
  const row = await repositories(db, ctx).workspace.get();
  if (!row) throw notFound();
  return toWorkspace(row);
}

export async function updateWorkspace(db: Database, ctx: WorkspaceContext, input: { name?: string | undefined }) {
  requireCapability(ctx, 'workspace.manage');
  const row = await repositories(db, ctx).workspace.update(input);
  if (!row) throw notFound();
  return toWorkspace(row);
}

export const listMembers = (db: Database, ctx: WorkspaceContext, input: { cursor?: string | undefined; limit: number }) => repositories(db, ctx).members.list(input);

function assertMemberChange(result: MemberChange): void {
  if (result.outcome === 'not_found') throw notFound();
  if (result.outcome === 'forbidden') throw forbidden();
  if (result.outcome === 'last_owner') throw new AppError(409, 'last_owner', 'A workspace must keep at least one active owner');
}

// Live sockets for the member close here once sockets carry identity, in M1b.
export async function updateMember(db: Database, ctx: WorkspaceContext, memberId: string, input: { role?: Role | undefined; status?: 'active' | 'suspended' | undefined }) {
  requireCapability(ctx, 'member.remove');
  const repos = repositories(db, ctx);
  assertMemberChange(await repos.members.update(memberId, input));
  const member = await repos.members.get(memberId);
  if (!member) throw notFound();
  return member;
}

export async function removeMember(db: Database, ctx: WorkspaceContext, memberId: string): Promise<void> {
  requireCapability(ctx, 'member.remove');
  assertMemberChange(await repositories(db, ctx).members.remove(memberId));
}

export function invitationEmailJob(workspaceId: string, invitationId: string): JobEnvelope<{ invitationId: string }> {
  const id = newId('job');
  return {
    v: 1,
    type: INVITATION_EMAIL_JOB,
    id,
    idempotencyKey: id,
    workspaceId,
    occurredAt: new Date().toISOString(),
    notAfter: new Date(Date.now() + INVITATION_TTL_MS).toISOString(),
    payload: { invitationId },
  };
}

export async function inviteMember(deps: Pick<AuthDeps, 'db' | 'limiter' | 'emailJobs'>, ctx: WorkspaceContext, input: { email: string; role: Exclude<Role, 'owner'> }) {
  requireCapability(ctx, 'member.invite');
  await enforce(deps.limiter, await limitKey('invite-workspace', ctx.workspaceId), LIMITS.invitationsPerWorkspace);
  // Nobody ever sees this token. The real one is created as the email is sent.
  const placeholderTokenHash = await hashOpaqueToken(generateOpaqueToken());
  const result = await repositories(deps.db, ctx).invitations.create({ ...input, placeholderTokenHash, ttlMs: INVITATION_TTL_MS });
  if (result.outcome === 'forbidden') throw forbidden();
  if (result.outcome === 'already_member') throw new AppError(409, 'already_member', 'This person is already a member');
  await deps.emailJobs.send(invitationEmailJob(ctx.workspaceId, result.invitation.id));
  return { ...result.invitation, role: input.role, expiresAt: toIso(result.invitation.expiresAt) };
}

/** A retry replaces the token, so if a send did succeed before a crash, the newest email holds the working link. */
export async function sendInvitationEmail(
  deps: { db: Database; email: EmailProvider; publicBaseUrl: string; installationName: string; fromEmail: string },
  input: { workspaceId: string; invitationId: string },
): Promise<void> {
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const data = await prepareInvitationEmail(deps.db, { ...input, tokenHash });
  if (!data) return; // Accepted, replaced, or expired since this was queued.
  const link = `${deps.publicBaseUrl.replace(/\/+$/, '')}/accept-invitation#token=${token}`;
  await deps.email.send({
    to: data.email,
    from: { name: deps.installationName, email: deps.fromEmail },
    subject: `Join ${data.workspaceName} on ${deps.installationName}`,
    text: `${data.inviterName} invited you to join ${data.workspaceName}. This link expires in seven days.\n\n${link}`,
    html: `<p>${escapeHtml(data.inviterName)} invited you to join ${escapeHtml(data.workspaceName)}. This link expires in seven days.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a></p>`,
    idempotencyKey: `invitation:${tokenHash}`,
  });
}

export async function acceptWorkspaceInvitation(
  deps: Pick<AuthDeps, 'db' | 'limiter'>,
  input: { token: string; name?: string | undefined; password?: string | undefined; ip: string },
): Promise<{ workspaceId: string }> {
  await enforce(deps.limiter, await limitKey('confirm-ip', input.ip), LIMITS.confirmIp);
  const tokenHash = await hashOpaqueToken(input.token);
  const invitation = await inspectInvitation(deps.db, tokenHash);
  if (!invitation) throw invalidToken();
  // Whatever an existing account's holder sends, it is ignored. The name and password stay as they are.
  let account: { name: string; passwordHash: string } | null = null;
  if (!invitation.accountExists) {
    if (!input.name || !input.password) throw new AppError(400, 'account_details_required', 'Choose a name and password');
    account = { name: input.name, passwordHash: await hashPassword(input.password) };
  }
  const accepted = await acceptInBatch(deps.db, { tokenHash, account });
  if (!accepted) throw invalidToken();
  return accepted;
}

const newWebsiteKey = () => `wk_${generateOpaqueToken()}`;

export const listWebsites = async (db: Database, ctx: WorkspaceContext) => ({ data: await repositories(db, ctx).websites.list() });

export function createWebsite(db: Database, ctx: WorkspaceContext, input: { name: string; allowedOrigins: string[]; settings?: Record<string, unknown> | undefined }) {
  requireCapability(ctx, 'website.manage');
  return repositories(db, ctx).websites.create({ ...input, websiteKey: newWebsiteKey() });
}

export async function updateWebsite(
  db: Database,
  ctx: WorkspaceContext,
  websiteId: string,
  input: { name?: string | undefined; allowedOrigins?: string[] | undefined; settings?: Record<string, unknown> | undefined },
) {
  requireCapability(ctx, 'website.manage');
  const row = await repositories(db, ctx).websites.update(websiteId, input);
  if (!row) throw notFound();
  return row;
}
