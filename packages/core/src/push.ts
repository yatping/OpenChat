/** A member's own devices and choices. Talking to the relay is the Worker's job. See services/api/src/push. */
import { pushRepository, type Database, type PushSubscriptionRow, type WorkspaceContext } from '@openchat/database';
import { NOTIFICATION_EVENTS, type NotificationEvent } from '@openchat/notification-protocol';
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

export async function recordPushSubscription(db: Database, ctx: WorkspaceContext, input: { relayId: string; relaySubscriptionId: string; previewKey: string; deviceLabel?: string | undefined }) {
  const row = await pushRepository(db, ctx).recordSubscription({ relayId: input.relayId, relaySubscriptionId: input.relaySubscriptionId, previewKey: input.previewKey, deviceLabel: input.deviceLabel ?? null });
  if (!row) throw new AppError(409, 'subscription_taken', 'This device is registered to someone else');
  return toSubscription(row);
}

export async function removePushSubscription(db: Database, ctx: WorkspaceContext, id: string): Promise<void> {
  if (!(await pushRepository(db, ctx).removeSubscription(id))) throw notFound();
}

/** Every event, so that an app can show its switches. One with no choice made is on. */
export async function getNotificationPreferences(db: Database, ctx: WorkspaceContext) {
  const chosen = new Map((await pushRepository(db, ctx).listPreferences()).map((p) => [p.eventType, p.enabled]));
  return { preferences: NOTIFICATION_EVENTS.map((eventType) => ({ eventType, channel: 'push' as const, enabled: chosen.get(eventType) ?? true })) };
}

export const setNotificationPreferences = (db: Database, ctx: WorkspaceContext, input: { preferences: { eventType: NotificationEvent; enabled: boolean }[] }) =>
  pushRepository(db, ctx).replacePreferences(input.preferences);
