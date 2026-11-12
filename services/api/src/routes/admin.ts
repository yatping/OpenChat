import {
  assignPersonRoute,
  createPersonRoute,
  createWebsiteRoute,
  createWorkspaceRoute,
  deactivatePersonRoute,
  disconnectRelayRoute,
  dismissFailedJobRoute,
  getRelayStatusRoute,
  listFailedJobsRoute,
  replayFailedJobRoute,
  listAdminWebsitesRoute,
  listAdminWorkspacesRoute,
  listPeopleRoute,
  reactivatePersonRoute,
  reconnectRelayRoute,
  unassignPersonRoute,
  updateWebsiteRoute,
  updatePersonRoute,
  updateWorkspaceRoute,
} from '@openchat/api-contracts';
import {
  adminContext,
  assignPerson,
  createPerson,
  createWebsite,
  createWorkspace,
  deactivatePerson,
  disconnectRelay,
  dismissFailedJob,
  listAdminWebsites,
  listFailedJobs,
  listAdminWorkspaces,
  listPeople,
  reactivatePerson,
  reconnectRelay,
  relayState,
  replayFailedJob,
  type ReplayQueue,
  setInstallationAdmin,
  unassignPerson,
  updateWebsite,
  updateWorkspace,
} from '@openchat/core';
import { AppError, createLogger } from '@openchat/shared';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
import type { Env } from '../env';
import { dispatchSoon } from '../dispatch';
import { eraseAtRelay, RelayError, relayConfig } from '../push/relay-client';
import { requireAuth } from './auth';

/** Deps plus proof of being an installation admin. Every route here starts with this. */
async function admin(c: Context<AppEnv>) {
  const deps = await authDeps(c.env);
  return { deps, ctx: await adminContext(deps.db, c.get('principal')) };
}

async function relayStatus(c: Context<AppEnv>, db: Awaited<ReturnType<typeof authDeps>>['db'], ctx: Awaited<ReturnType<typeof adminContext>>) {
  const relay = relayConfig(c.env);
  const state = await relayState(db, ctx);
  return {
    state: !relay ? ('not_configured' as const) : state.disconnectedId === relay.id ? ('disconnected' as const) : ('connected' as const),
    relay: relay && { id: relay.id, url: relay.url },
    registered: relay !== null && state.registeredId === relay.id,
    subscriptions: state.subscriptions,
  };
}

function replayQueue(env: Env, queue: ReplayQueue): Queue {
  return queue === 'notifications' ? env.NOTIFICATIONS_QUEUE : queue === 'email' ? env.EMAIL_QUEUE : env.JOBS_QUEUE;
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

  app.openapi(createWorkspaceRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await createWorkspace(deps.db, ctx, c.req.valid('json').name), 201);
  });

  app.openapi(updateWorkspaceRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await updateWorkspace(deps.db, ctx, c.req.valid('param').workspaceId, c.req.valid('json')), 200);
  });

  app.openapi(getRelayStatusRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await relayStatus(c, deps.db, ctx), 200);
  });

  app.openapi(disconnectRelayRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    const relay = relayConfig(c.env);
    if (!relay) throw new AppError(409, 'push_not_configured', 'This installation has no notification relay');
    await disconnectRelay(deps.db, ctx, relay.id);
    try {
      await eraseAtRelay(deps.db, relay);
    } catch (error) {
      createLogger().warn('relay_erasure_failed', { errorName: (error as Error).name, ...(error instanceof RelayError ? { status: error.status, errorCode: error.code } : {}) });
      throw new AppError(503, 'relay_unavailable', 'Push is off, but the relay could not be reached to erase its records. Try again.');
    }
    return c.json(await relayStatus(c, deps.db, ctx), 200);
  });

  app.openapi(reconnectRelayRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    await reconnectRelay(deps.db, ctx);
    return c.json(await relayStatus(c, deps.db, ctx), 200);
  });

  app.openapi(listAdminWebsitesRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await listAdminWebsites(deps.db, ctx, c.req.valid('param').workspaceId), 200);
  });

  app.openapi(createWebsiteRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await createWebsite(deps.db, ctx, c.req.valid('param').workspaceId, c.req.valid('json'), { turnstileAvailable: deps.turnstile !== undefined }), 201);
  });

  app.openapi(updateWebsiteRoute, async (c) => {
    const { workspaceId, websiteId } = c.req.valid('param');
    const { deps, ctx } = await admin(c);
    return c.json(await updateWebsite(deps.db, ctx, workspaceId, websiteId, c.req.valid('json'), { turnstileAvailable: deps.turnstile !== undefined }), 200);
  });

  app.openapi(listFailedJobsRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    return c.json(await listFailedJobs(deps.db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(replayFailedJobRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    const job = await replayFailedJob(deps.db, ctx, c.req.valid('param').failedJobId, async (queue, envelope) => {
      try {
        await replayQueue(c.env, queue).send(envelope);
      } catch (error) {
        createLogger().warn('failed_job_replay_send_failed', { jobType: envelope.type, errorName: (error as Error).name });
        throw new AppError(503, 'queue_unavailable', 'The job could not be queued. Try again.');
      }
    });
    return c.json(job, 200);
  });

  app.openapi(dismissFailedJobRoute, async (c) => {
    const { deps, ctx } = await admin(c);
    await dismissFailedJob(deps.db, ctx, c.req.valid('param').failedJobId);
    return c.body(null, 204);
  });
}
