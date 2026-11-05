/** A member's own devices and choices. Talking to the relay is the Worker's job. See services/api/src/push. */
import { pushRepository, type Database, type PushSubscriptionRow, type WorkspaceContext } from '@openchat/database';
import { EMAIL_ALERT_EVENTS } from '@openchat/api-contracts';
import { NOTIFICATION_EVENTS } from '@openchat/notification-protocol';
import { AppError, notFound, toIso } from '@openchat/shared';

const toSubscription = (row: PushSubscriptionRow) => ({
  id: row.id,
  relaySubscriptionId: row.relaySubscriptionId,
  platform: row.platform,
  deviceLabel: row.deviceLabel,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

export const listPushSubscriptions = async (db: Database, ctx: WorkspaceContext) => ({ data: (await pushRepository(db, ctx).listSubscriptions()).map(toSubscription) });

export async function recordPushSubscription(db: Database, ctx: WorkspaceContext, input: { relayId: string; relaySubscriptionId: string; deviceLabel?: string | undefined }) {
  const row = await pushRepository(db, ctx).recordSubscription({ relayId: input.relayId, relaySubscriptionId: input.relaySubscriptionId, deviceLabel: input.deviceLabel ?? null });
  if (!row) throw new AppError(409, 'subscription_taken', 'This device is registered to someone else');
  return toSubscription(row);
}

export async function removePushSubscription(db: Database, ctx: WorkspaceContext, id: string): Promise<void> {
  if (!(await pushRepository(db, ctx).removeSubscription(id))) throw notFound();
}

/** Every choice, so that a client can show its switches. Push starts on, and email starts off. */
export async function getNotificationPreferences(db: Database, ctx: WorkspaceContext) {
  const chosen = new Map((await pushRepository(db, ctx).listPreferences()).map((p) => [`${p.channel}:${p.eventType}`, p.enabled]));
  return {
    preferences: [
      ...NOTIFICATION_EVENTS.map((eventType) => ({ eventType, channel: 'push' as const, enabled: chosen.get(`push:${eventType}`) ?? true })),
      ...EMAIL_ALERT_EVENTS.map((eventType) => ({ eventType, channel: 'email' as const, enabled: chosen.get(`email:${eventType}`) ?? false })),
    ],
  };
}

export const setNotificationPreferences = (db: Database, ctx: WorkspaceContext, input: { preferences: { eventType: string; channel: 'push' | 'email'; enabled: boolean }[] }) =>
  pushRepository(db, ctx).replacePreferences(input.preferences);
