import {
  createPushGrantRoute,
  getNotificationPreferencesRoute,
  listPushSubscriptionsRoute,
  recordPushSubscriptionRoute,
  removePushSubscriptionRoute,
  setNotificationPreferencesRoute,
} from '@openchat/api-contracts';
import { getNotificationPreferences, listPushSubscriptions, recordPushSubscription, removePushSubscription, setNotificationPreferences, workspaceContext } from '@openchat/core';
import { AppError, createLogger } from '@openchat/shared';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
import { dispatchSoon } from '../dispatch';
import { connectedRelay, issueGrant, RelayDisconnectedError, RelayError } from '../push/relay-client';

/** Authentication comes from the /api/v1/workspaces/* prefix in routes/workspaces.ts. */
async function scoped(c: Context<AppEnv>, workspaceId: string) {
  const { db } = await authDeps(c.env);
  return { db, ctx: await workspaceContext(db, c.get('principal'), workspaceId) };
}

const notConfigured = () => new AppError(409, 'push_not_configured', 'This installation has no notification relay');

export function registerPushRoutes(app: App) {
  app.openapi(createPushGrantRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    const relay = await connectedRelay(c.env, db);
    if (!relay) throw notConfigured();
    try {
      return c.json(await issueGrant(db, relay, ctx.workspaceId, ctx.memberId), 201);
    } catch (error) {
      // Disconnected after the check above.
      if (error instanceof RelayDisconnectedError) throw notConfigured();
      // The app tries again later. Messaging does not depend on any of this.
      createLogger({ workspaceId: ctx.workspaceId }).warn('relay_registration_failed', { errorName: (error as Error).name, ...(error instanceof RelayError ? { status: error.status, errorCode: error.code } : {}) });
      throw new AppError(503, 'relay_unavailable', 'The notification relay cannot be reached right now');
    }
  });

  app.openapi(listPushSubscriptionsRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listPushSubscriptions(db, ctx), 200);
  });

  app.openapi(recordPushSubscriptionRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    const relay = await connectedRelay(c.env, db);
    if (!relay) throw notConfigured();
    return c.json(await recordPushSubscription(db, ctx, { relayId: relay.id, ...c.req.valid('json') }), 201);
  });

  app.openapi(removePushSubscriptionRoute, async (c) => {
    const { workspaceId, subscriptionId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    await removePushSubscription(db, ctx, subscriptionId);
    dispatchSoon(c, workspaceId, [subscriptionId]);
    return c.body(null, 204);
  });

  app.openapi(getNotificationPreferencesRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await getNotificationPreferences(db, ctx), 200);
  });

  app.openapi(setNotificationPreferencesRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    await setNotificationPreferences(db, ctx, c.req.valid('json'));
    return c.body(null, 204);
  });
}
