/**
 * Push, as the installation sees it: opaque subscription handles, preferences, and what the relay already knows.
 * Device tokens never reach this database. See docs/notification-relay/protocol.md.
 */
import { newId } from '@openchat/shared';
import type { WorkspaceContext } from './context';
import { DB_NOW_MS, rawHandle, type Database } from './internal/handle';

export interface PushSubscriptionRow {
  id: string;
  relaySubscriptionId: string;
  platform: 'ios';
  deviceLabel: string | null;
  createdAt: number;
  updatedAt: number;
}

const COLUMNS = `id, relay_subscription_id AS relaySubscriptionId, platform, device_label AS deviceLabel, created_at AS createdAt, updated_at AS updatedAt`;

/** Rows are not told when a relay drops a dead token, so reinstalling would otherwise add them without end. */
const MAX_SUBSCRIPTIONS_PER_MEMBER = 20;

export function pushRepository(database: Database, ctx: WorkspaceContext) {
  const d1 = rawHandle(database);
  const w = ctx.workspaceId;
  return {
    async listSubscriptions(): Promise<PushSubscriptionRow[]> {
      const { results } = await d1
        .prepare(`SELECT ${COLUMNS} FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2 ORDER BY id`)
        .bind(w, ctx.memberId)
        .all<PushSubscriptionRow>();
      return results;
    },

    /** The same handle again answers the row it has, so an app can repeat this. Null if it is someone else's. */
    async recordSubscription(input: { relayId: string; relaySubscriptionId: string; deviceLabel: string | null }): Promise<PushSubscriptionRow | null> {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO push_subscriptions (id, workspace_id, member_id, relay_id, relay_subscription_id, platform, device_label, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ios', ?6, ${DB_NOW_MS}, ${DB_NOW_MS})
             ON CONFLICT (relay_id, relay_subscription_id) DO NOTHING`,
          )
          .bind(newId('pushSubscription'), w, ctx.memberId, input.relayId, input.relaySubscriptionId, input.deviceLabel),
        d1
          .prepare(
            `DELETE FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2 AND id NOT IN
               (SELECT id FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2 ORDER BY id DESC LIMIT ?3)`,
          )
          .bind(w, ctx.memberId, MAX_SUBSCRIPTIONS_PER_MEMBER),
      ]);
      return d1
        .prepare(`SELECT ${COLUMNS} FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2 AND relay_id = ?3 AND relay_subscription_id = ?4`)
        .bind(w, ctx.memberId, input.relayId, input.relaySubscriptionId)
        .first<PushSubscriptionRow>();
    },

    /** Only the caller's own. The outbox row carries the handle, because the relay still has to hear of this. */
    async removeSubscription(id: string): Promise<boolean> {
      const mine = `workspace_id = ?1 AND member_id = ?2 AND id = ?3`;
      const [outbox] = await d1.batch([
        d1
          .prepare(
            `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
             SELECT ?4, workspace_id, 'push.subscription_removed', id, json_object('relaySubscriptionId', relay_subscription_id), ${DB_NOW_MS}
               FROM push_subscriptions WHERE ${mine}`,
          )
          .bind(w, ctx.memberId, id, newId('outbox')),
        d1.prepare(`DELETE FROM push_subscriptions WHERE ${mine}`).bind(w, ctx.memberId, id),
      ]);
      return outbox?.meta.changes === 1;
    },

    async listPreferences(): Promise<{ eventType: string; enabled: boolean }[]> {
      const { results } = await d1
        .prepare(`SELECT event_type AS eventType, enabled FROM notification_preferences WHERE workspace_id = ?1 AND member_id = ?2 AND channel = 'push'`)
        .bind(w, ctx.memberId)
        .all<{ eventType: string; enabled: number }>();
      return results.map((row) => ({ eventType: row.eventType, enabled: row.enabled === 1 }));
    },

    async replacePreferences(preferences: { eventType: string; enabled: boolean }[]): Promise<void> {
      await d1.batch([
        d1.prepare(`DELETE FROM notification_preferences WHERE workspace_id = ?1 AND member_id = ?2 AND channel = 'push'`).bind(w, ctx.memberId),
        ...preferences.map((p) =>
          d1
            .prepare(
              `INSERT INTO notification_preferences (workspace_id, member_id, event_type, channel, enabled, updated_at) VALUES (?1, ?2, ?3, 'push', ?4, ${DB_NOW_MS})
               ON CONFLICT (workspace_id, member_id, event_type, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
            )
            .bind(w, ctx.memberId, p.eventType, p.enabled ? 1 : 0),
        ),
      ]);
    },
  };
}

// The rest runs with no user, from a queue job, so each query filters on an ID from the job.

export interface RelayRegistration {
  installationId: string;
  installationRelayId: string | null;
  workspaceName: string;
  workspaceStatus: 'unregistered' | 'registered' | 'revoked';
  workspaceDisplayName: string | null;
}

export function relayRegistration(database: Database, workspaceId: string): Promise<RelayRegistration | null> {
  return rawHandle(database)
    .prepare(
      `SELECT i.id AS installationId, i.relay_registered_id AS installationRelayId, w.name AS workspaceName,
              w.relay_workspace_status AS workspaceStatus, w.relay_display_name AS workspaceDisplayName
         FROM workspaces w, installation i WHERE w.id = ?1`,
    )
    .bind(workspaceId)
    .first<RelayRegistration>();
}

/** Workspaces were accepted by whichever relay came before, so they register again with this one. */
export async function markInstallationRegistered(database: Database, relayId: string): Promise<void> {
  const d1 = rawHandle(database);
  await d1.batch([
    d1.prepare(`UPDATE workspaces SET relay_workspace_status = 'unregistered', relay_display_name = NULL WHERE (SELECT relay_registered_id FROM installation) IS NOT ?1`).bind(relayId),
    d1.prepare(`UPDATE installation SET relay_registered_id = ?1, updated_at = ${DB_NOW_MS}`).bind(relayId),
  ]);
}

export async function markWorkspaceRegistered(database: Database, workspaceId: string, displayName: string): Promise<void> {
  await rawHandle(database).prepare(`UPDATE workspaces SET relay_workspace_status = 'registered', relay_display_name = ?2 WHERE id = ?1`).bind(workspaceId, displayName).run();
}

/** For a relay that no longer knows this installation. The next attempt registers everything again. */
export async function forgetRelayRegistration(database: Database): Promise<void> {
  await rawHandle(database).prepare(`UPDATE installation SET relay_registered_id = NULL, updated_at = ${DB_NOW_MS}`).run();
}

/**
 * Who gets a push: active members with a device who have not turned this event off. Reading the conversation
 * needs only active membership, so nobody here learns of something they could not open.
 */
export async function pushRecipients(database: Database, input: { workspaceId: string; eventType: string; onlyMemberId: string | null; exceptMemberId: string | null }): Promise<string[]> {
  const { results } = await rawHandle(database)
    .prepare(
      `SELECT DISTINCT s.member_id AS memberId
         FROM push_subscriptions s
         JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.id = s.member_id AND m.status = 'active'
         JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
         LEFT JOIN notification_preferences p ON p.workspace_id = s.workspace_id AND p.member_id = s.member_id AND p.event_type = ?2 AND p.channel = 'push'
        WHERE s.workspace_id = ?1 AND COALESCE(p.enabled, 1) = 1
          AND (?3 IS NULL OR s.member_id = ?3) AND (?4 IS NULL OR s.member_id <> ?4)`,
    )
    .bind(input.workspaceId, input.eventType, input.onlyMemberId, input.exceptMemberId)
    .all<{ memberId: string }>();
  return results.map((row) => row.memberId);
}

export function conversationAssignee(database: Database, workspaceId: string, conversationId: string) {
  return rawHandle(database)
    .prepare(`SELECT assigned_member_id AS assignedMemberId FROM conversations WHERE workspace_id = ?1 AND id = ?2`)
    .bind(workspaceId, conversationId)
    .first<{ assignedMemberId: string | null }>();
}

/** Someone removed, or with every session gone, has no way to read what a push would announce. */
export async function memberStillReachable(database: Database, workspaceId: string, memberId: string): Promise<boolean> {
  const row = await rawHandle(database)
    .prepare(
      `SELECT 1 AS yes FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.disabled_at IS NULL
        WHERE m.workspace_id = ?1 AND m.id = ?2 AND m.status = 'active'
          AND EXISTS (SELECT 1 FROM auth_sessions a WHERE a.user_id = m.user_id AND a.revoked_at IS NULL AND a.expires_at > ${DB_NOW_MS})`,
    )
    .bind(workspaceId, memberId)
    .first();
  return row !== null;
}

export async function deleteMemberSubscriptions(database: Database, workspaceId: string, memberId: string): Promise<void> {
  await rawHandle(database).prepare(`DELETE FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2`).bind(workspaceId, memberId).run();
}
