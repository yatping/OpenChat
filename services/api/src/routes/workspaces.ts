import { getWorkspaceRoute, listMembersRoute, listWebsitesRoute } from '@openchat/api-contracts';
import { getWorkspace, listMembers, listWebsites, workspaceContext } from '@openchat/core';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
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

  app.openapi(getWorkspaceRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await getWorkspace(deps.db, ctx), 200);
  });

  app.openapi(listMembersRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listMembers(deps.db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(listWebsitesRoute, async (c) => {
    const { deps, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listWebsites(deps.db, ctx), 200);
  });
}
