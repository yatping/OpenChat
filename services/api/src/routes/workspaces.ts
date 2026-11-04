import {
  acceptInvitationRoute,
  createInvitationRoute,
  createWebsiteRoute,
  createWorkspaceRoute,
  getWorkspaceRoute,
  listMembersRoute,
  listWebsitesRoute,
  removeMemberRoute,
  updateMemberRoute,
  updateWebsiteRoute,
  updateWorkspaceRoute,
} from '@openchat/api-contracts';
import {
  acceptWorkspaceInvitation,
  createWebsite,
  createWorkspace,
  getWorkspace,
  inviteMember,
  listMembers,
  listWebsites,
  removeMember,
  updateMember,
  updateWebsite,
  updateWorkspace,
  workspaceContext,
} from '@openchat/core';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
import { dispatchSoon } from '../dispatch';
import { requireAuth } from './auth';

/** Deps plus proof of membership. Every route under a workspace ID starts here. */
async function scoped(c: Context<AppEnv>, workspaceId: string) {
  const deps = await authDeps(c.env);
  return { deps, ctx: await workspaceContext(deps.db, c.get('principal'), workspaceId) };
}

export function registerWorkspaceRoutes(app: App) {
  // By prefix, so a route added here later cannot forget authentication.
  app.use('/api/v1/workspaces', requireAuth);
  app.use('/api/v1/workspaces/*', requireAuth);

  app.openapi(createWorkspaceRoute, async (c) => {
    const { db } = await authDeps(c.env);
    return c.json(await createWorkspace(db, c.get('principal'), c.req.valid('json').name), 201);
  });

  app.openapi(getWorkspaceRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await getWorkspace(deps.db, ctx), 200);
  });

  app.openapi(updateWorkspaceRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await updateWorkspace(deps.db, ctx, c.req.valid('json')), 200);
  });

  app.openapi(listMembersRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listMembers(deps.db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(updateMemberRoute, async (c) => {
    const { workspaceId, memberId } = c.req.valid('param');
    const { deps, ctx } = await scoped(c, workspaceId);
    const member = await updateMember(deps.db, ctx, memberId, c.req.valid('json'));
    dispatchSoon(c, workspaceId, [memberId]);
    return c.json(member, 200);
  });

  app.openapi(removeMemberRoute, async (c) => {
    const { workspaceId, memberId } = c.req.valid('param');
    const { deps, ctx } = await scoped(c, workspaceId);
    await removeMember(deps.db, ctx, memberId);
    dispatchSoon(c, workspaceId, [memberId]);
    return c.body(null, 204);
  });

  app.openapi(createInvitationRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await inviteMember(deps, ctx, c.req.valid('json')), 201);
  });

  app.openapi(acceptInvitationRoute, async (c) => {
    const deps = await authDeps(c.env);
    const accepted = await acceptWorkspaceInvitation(deps, { ...c.req.valid('json'), ip: c.req.header('cf-connecting-ip') ?? 'unknown' });
    return c.json(accepted, 200);
  });

  app.openapi(listWebsitesRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listWebsites(deps.db, ctx), 200);
  });

  app.openapi(createWebsiteRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await createWebsite(deps.db, ctx, c.req.valid('json'), { turnstileAvailable: deps.turnstile !== undefined }), 201);
  });

  app.openapi(updateWebsiteRoute, async (c) => {
    const { workspaceId, websiteId } = c.req.valid('param');
    const { deps, ctx } = await scoped(c, workspaceId);
    return c.json(await updateWebsite(deps.db, ctx, websiteId, c.req.valid('json'), { turnstileAvailable: deps.turnstile !== undefined }), 200);
  });
}
