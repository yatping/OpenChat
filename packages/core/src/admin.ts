/**
 * What an installation admin does: manage people, workspaces, and websites. Anyone else gets 404, so the routes
 * do not reveal that they exist. The rules that must hold at commit are in the repository's SQL.
 */
import { generateOpaqueToken, hashOpaqueToken } from '@openchat/auth';
import {
  adminRepository,
  authorizeInstallationAdmin,
  getUserContact,
  issueAuthToken,
  type AdminContext,
  type Database,
  type PersonChange,
  type Principal,
  type Role,
  type WorkspaceRow,
} from '@openchat/database';
import type { EmailProvider } from '@openchat/email';
import { AppError, newId, notFound, toIso, type JobEnvelope } from '@openchat/shared';
import { enforce, escapeHtml, limitKey, LIMITS, type AuthDeps } from './auth-flows';

export const NEW_ACCOUNT_EMAIL_JOB = 'auth.new_account_email';
const NEW_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function adminContext(db: Database, principal: Principal): Promise<AdminContext> {
  const ctx = await authorizeInstallationAdmin(db, principal.userId);
  if (!ctx) throw notFound();
  return ctx;
}

function changed(result: PersonChange) {
  switch (result.outcome) {
    case 'done':
      return result.person;
    case 'email_taken':
      throw new AppError(409, 'email_taken', 'This address already has an account');
    case 'self':
      throw new AppError(409, 'cannot_deactivate_self', 'Ask another installation admin to deactivate your account');
    case 'deactivated':
      throw new AppError(409, 'person_deactivated', 'Reactivate this person first');
    case 'last_admin':
      throw new AppError(409, 'last_admin', 'The installation must keep at least one active admin');
    case 'forbidden':
    case 'not_found':
      throw notFound();
  }
}

export const listPeople = (db: Database, ctx: AdminContext, input: { cursor?: string | undefined; limit: number }) => adminRepository(db, ctx).list(input);
export const listAdminWorkspaces = (db: Database, ctx: AdminContext, input: { cursor?: string | undefined; limit: number }) => adminRepository(db, ctx).listWorkspaces(input);
export const setInstallationAdmin = async (db: Database, ctx: AdminContext, userId: string, isAdmin: boolean) => changed(await adminRepository(db, ctx).setAdmin(userId, isAdmin));
export const deactivatePerson = async (db: Database, ctx: AdminContext, userId: string) => changed(await adminRepository(db, ctx).deactivate(userId));
export const reactivatePerson = async (db: Database, ctx: AdminContext, userId: string) => changed(await adminRepository(db, ctx).reactivate(userId));
export const assignPerson = async (db: Database, ctx: AdminContext, userId: string, workspaceId: string, role: Role) => changed(await adminRepository(db, ctx).assign(userId, workspaceId, role));
export const unassignPerson = async (db: Database, ctx: AdminContext, userId: string, workspaceId: string) => changed(await adminRepository(db, ctx).unassign(userId, workspaceId));

const toWorkspace = (row: WorkspaceRow) => ({ id: row.id, name: row.name, slug: row.slug, createdAt: toIso(row.createdAt) });

function slugFor(name: string): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const suffix = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${base || 'workspace'}-${suffix}`;
}

export async function createWorkspace(db: Database, ctx: AdminContext, name: string) {
  const row = await adminRepository(db, ctx).createWorkspace({ name, slug: slugFor(name) });
  if (!row) throw notFound();
  return toWorkspace(row);
}

export async function updateWorkspace(db: Database, ctx: AdminContext, workspaceId: string, input: { name?: string | undefined }) {
  const row = await adminRepository(db, ctx).updateWorkspace(workspaceId, input);
  if (!row) throw notFound();
  return toWorkspace(row);
}

export async function listAdminWebsites(db: Database, ctx: AdminContext, workspaceId: string) {
  const data = await adminRepository(db, ctx).listWebsites(workspaceId);
  if (!data) throw notFound();
  return { data };
}

/** Otherwise the website would turn away every new visitor, with nothing to say why. */
function assertTurnstilePossible(settings: Record<string, unknown> | undefined, available: boolean): void {
  if (settings?.requireTurnstile === true && !available) {
    throw new AppError(400, 'turnstile_not_configured', 'This installation has no Turnstile keys. Deploy it with them first');
  }
}

export async function createWebsite(
  db: Database,
  ctx: AdminContext,
  workspaceId: string,
  input: { name: string; allowedOrigins: string[]; settings?: Record<string, unknown> | undefined },
  options: { turnstileAvailable: boolean } = { turnstileAvailable: false },
) {
  assertTurnstilePossible(input.settings, options.turnstileAvailable);
  const row = await adminRepository(db, ctx).createWebsite(workspaceId, { ...input, websiteKey: `wk_${generateOpaqueToken()}` });
  if (!row) throw notFound();
  return row;
}

export async function updateWebsite(
  db: Database,
  ctx: AdminContext,
  workspaceId: string,
  websiteId: string,
  input: { name?: string | undefined; allowedOrigins?: string[] | undefined; settings?: Record<string, unknown> | undefined },
  options: { turnstileAvailable: boolean } = { turnstileAvailable: false },
) {
  assertTurnstilePossible(input.settings, options.turnstileAvailable);
  const row = await adminRepository(db, ctx).updateWebsite(workspaceId, websiteId, input);
  if (!row) throw notFound();
  return row;
}

function newAccountJob(userId: string): JobEnvelope<{ userId: string }> {
  const id = newId('job');
  return {
    v: 1,
    type: NEW_ACCOUNT_EMAIL_JOB,
    id,
    idempotencyKey: id,
    workspaceId: null,
    occurredAt: new Date().toISOString(),
    notAfter: new Date(Date.now() + NEW_ACCOUNT_TTL_MS).toISOString(),
    payload: { userId },
  };
}

export async function createPerson(deps: Pick<AuthDeps, 'db' | 'limiter' | 'emailJobs'>, ctx: AdminContext, input: { name: string; email: string }) {
  await enforce(deps.limiter, await limitKey('admin-people', ctx.userId), LIMITS.newPeoplePerAdmin);
  const person = changed(await adminRepository(deps.db, ctx).create(input));
  await deps.emailJobs.send(newAccountJob(person.id));
  return person;
}

/** The token is created as the email is sent, so it never sits in a queue. Otherwise the same as a password reset. */
export async function sendNewAccountEmail(
  deps: { db: Database; email: EmailProvider; publicBaseUrl: string; installationName: string; fromEmail: string },
  userId: string,
): Promise<void> {
  const contact = await getUserContact(deps.db, userId);
  if (!contact) return;
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  await issueAuthToken(deps.db, { tokenHash, userId, purpose: 'password_reset', ttlMs: NEW_ACCOUNT_TTL_MS });
  const link = `${deps.publicBaseUrl.replace(/\/+$/, '')}/reset-password#token=${token}`;
  await deps.email.send({
    to: contact.email,
    from: { name: deps.installationName, email: deps.fromEmail },
    subject: `Your ${deps.installationName} account`,
    text: `An account was created for you. Use this link to choose a password. It expires in seven days.\n\n${link}`,
    html: `<p>Hello ${escapeHtml(contact.name)},</p><p>An account was created for you. Use this link to choose a password. It expires in seven days.</p><p><a href="${escapeHtml(link)}">Choose your password</a></p>`,
    idempotencyKey: `new-account:${tokenHash}`,
  });
}

/** Push, as an installation admin sees it. The relay configuration itself comes from the deployment. */
export async function relayState(db: Database, ctx: AdminContext) {
  return adminRepository(db, ctx).relayState();
}

export async function disconnectRelay(db: Database, ctx: AdminContext, relayId: string): Promise<void> {
  if (!(await adminRepository(db, ctx).disconnectRelay(relayId))) throw notFound();
}

export async function reconnectRelay(db: Database, ctx: AdminContext): Promise<void> {
  if (!(await adminRepository(db, ctx).reconnectRelay())) throw notFound();
}
