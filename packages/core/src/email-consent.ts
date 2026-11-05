/** Unsubscribe links, which work with no sign-in, and the list of addresses a workspace must not email. */
import { generateOpaqueToken, hashOpaqueToken } from '@openchat/auth';
import { createUnsubscribeLink, suppressionRepository, unsubscribeByLink, unsubscribeLinkExists, type Database, type WorkspaceContext } from '@openchat/database';
import { AppError } from '@openchat/shared';
import { enforce, limitKeyForIp, LIMITS, type AuthDeps } from './auth-flows';
import { requireCapability } from './workspaces';

/** A new link for each email. The token is random, so the link holds no personal data and outlives any signing key. */
export async function newUnsubscribeHeaders(db: Database, input: { workspaceId: string; email: string; publicBaseUrl: string }) {
  const token = generateOpaqueToken();
  await createUnsubscribeLink(db, { workspaceId: input.workspaceId, email: input.email, tokenHash: await hashOpaqueToken(token) });
  const url = `${input.publicBaseUrl.replace(/\/+$/, '')}/api/v1/unsubscribe?token=${encodeURIComponent(token)}`;
  return { url, headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

/** Does nothing but look, because mail scanners open links on their own. */
export async function unsubscribeLinkIsValid(deps: Pick<AuthDeps, 'db' | 'limiter' | 'limits'>, input: { token: string | undefined; ip: string }): Promise<boolean> {
  await enforce(deps.limiter, await limitKeyForIp(deps, 'unsubscribe-ip', input.ip), LIMITS.unsubscribeIp);
  return input.token ? unsubscribeLinkExists(deps.db, await hashOpaqueToken(input.token)) : false;
}

export async function confirmUnsubscribe(deps: Pick<AuthDeps, 'db' | 'limiter' | 'limits'>, input: { token: string | undefined; ip: string }): Promise<boolean> {
  if (!(await unsubscribeLinkIsValid(deps, input))) return false;
  await unsubscribeByLink(deps.db, await hashOpaqueToken(input.token!));
  return true;
}

export function listEmailSuppressions(db: Database, ctx: WorkspaceContext, input: { cursor?: string | undefined; limit: number }) {
  requireCapability(ctx, 'suppression.manage');
  return suppressionRepository(db, ctx).list(input);
}

export async function addEmailSuppression(db: Database, ctx: WorkspaceContext, email: string) {
  requireCapability(ctx, 'suppression.manage');
  await suppressionRepository(db, ctx).add(email);
}

export async function removeEmailSuppression(db: Database, ctx: WorkspaceContext, email: string) {
  requireCapability(ctx, 'suppression.manage');
  if (!(await suppressionRepository(db, ctx).removeManual(email))) throw new AppError(409, 'suppression_locked', 'This address asked not to be emailed, so it stays on the list');
}
