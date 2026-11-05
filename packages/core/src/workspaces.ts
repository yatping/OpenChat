/**
 * What a member can see of their workspace. Changing a workspace, its websites, or its people belongs to the
 * installation admin, in admin.ts. The role checks here give a clear 403 early.
 */
import { can, type Capability } from '@openchat/auth';
import { authorizeWorkspaceMember, repositories, type Database, type Principal, type WorkspaceContext } from '@openchat/database';
import { AppError, notFound, toIso } from '@openchat/shared';

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

export async function getWorkspace(db: Database, ctx: WorkspaceContext) {
  const row = await repositories(db, ctx).workspace.get();
  if (!row) throw notFound();
  return { id: row.id, name: row.name, slug: row.slug, createdAt: toIso(row.createdAt) };
}

export const listMembers = (db: Database, ctx: WorkspaceContext, input: { cursor?: string | undefined; limit: number }) => repositories(db, ctx).members.list(input);

export const listWebsites = async (db: Database, ctx: WorkspaceContext) => ({ data: await repositories(db, ctx).websites.list() });
