import {
  assignPersonRoute,
  createPersonRoute,
  deactivatePersonRoute,
  listAdminWorkspacesRoute,
  listPeopleRoute,
  reactivatePersonRoute,
  unassignPersonRoute,
  updatePersonRoute,
} from '@openchat/api-contracts';
import {
  adminContext,
  assignPerson,
  createPerson,
  deactivatePerson,
  listAdminWorkspaces,
  listPeople,
  reactivatePerson,
  setInstallationAdmin,
  unassignPerson,
} from '@openchat/core';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
import { dispatchSoon } from '../dispatch';
import { requireAuth } from './auth';

/** Deps plus proof of being an installation admin. Every route here starts with this. */
async function admin(c: Context<AppEnv>) {
  const deps = await authDeps(c.env);
  return { deps, ctx: await adminContext(deps.db, c.get('principal')) };
}

export function registerAdminRoutes(app: App) {
  // By prefix, so a route added here later cannot forget authentication.
  app.use('/api/v1/admin/*', requireAuth);

  app.openapi(listPeopleRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await listPeople(deps.db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(createPersonRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await createPerson(deps, ctx, c.req.valid('json')), 201);
  });

  app.openapi(updatePersonRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await setInstallationAdmin(deps.db, ctx, c.req.valid('param').userId, c.req.valid('json').isInstallationAdmin), 200);
  });

  app.openapi(deactivatePersonRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    const person = await deactivatePerson(deps.db, ctx, c.req.valid('param').userId);
    for (const membership of person.memberships) dispatchSoon(c, membership.workspaceId, [membership.memberId]);
    return c.json(person, 200);
  });

  app.openapi(reactivatePersonRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await reactivatePerson(deps.db, ctx, c.req.valid('param').userId), 200);
  });

  app.openapi(assignPersonRoute, async (c) => {
    const { userId, workspaceId } = c.req.valid('param');
    const { deps, ctx } = await admin(c);
    const person = await assignPerson(deps.db, ctx, userId, workspaceId, c.req.valid('json').role);
    for (const membership of person.memberships) if (membership.workspaceId === workspaceId) dispatchSoon(c, workspaceId, [membership.memberId]);
    return c.json(person, 200);
  });

  app.openapi(unassignPersonRoute, async (c) => {
    const { userId, workspaceId } = c.req.valid('param');
    const { deps, ctx } = await admin(c);
    const person = await unassignPerson(deps.db, ctx, userId, workspaceId);
    for (const membership of person.memberships) if (membership.workspaceId === workspaceId) dispatchSoon(c, workspaceId, [membership.memberId]);
    return c.json(person, 200);
  });

  app.openapi(listAdminWorkspacesRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await listAdminWorkspaces(deps.db, ctx, c.req.valid('query')), 200);
  });
}
