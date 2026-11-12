import { getDatabaseHealthRoute, getNotificationHealthRoute, getQueueHealthRoute, getRealtimeHealthRoute } from '@openchat/api-contracts';
import type { App } from '../context';
import { databaseHealth, notificationHealth, queueHealth, realtimeHealth, requireOperator } from '../health';

/** The operator health checks. See ../health.ts and docs/operations/monitoring.md. */
export function registerHealthRoutes(app: App) {
  app.openapi(getDatabaseHealthRoute, async (c) => {
    await requireOperator(c);
    const { body, code } = await databaseHealth(c.env);
    return c.json(body, code);
  });

  app.openapi(getQueueHealthRoute, async (c) => {
    await requireOperator(c);
    const { body, code } = await queueHealth(c.env);
    return c.json(body, code);
  });

  app.openapi(getRealtimeHealthRoute, async (c) => {
    await requireOperator(c);
    const { body, code } = await realtimeHealth(c.env);
    return c.json(body, code);
  });

  app.openapi(getNotificationHealthRoute, async (c) => {
    await requireOperator(c);
    return c.json(await notificationHealth(c.env), 200);
  });
}
