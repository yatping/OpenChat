import type { ApnsTransport, NotificationEvent } from '@openchat/notification-protocol';
import { createLogger } from '@openchat/shared';
import { sendToApns } from '../apns/client';
import { decryptToken } from '../devices/crypto';
import type { Env } from '../env';
import { composePush } from './payload';

const log = createLogger({ queue: 'delivery' });
/** Each invocation can hold only 6 connections. See docs/notification-relay/protocol.md. */
const CONCURRENCY = 6;
const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 900];

export interface DeliveryMessage {
  /** The relay's own record ID. */
  id: string;
  installationId: string;
  /** Starts at 1, and keeps results from being counted twice. */
  attempt: number;
  /** On a retry, only the devices still outstanding. */
  deviceIds?: string[];
  /** Sealed notifications by subscription ID. Held only here, never in D1, and never logged. */
  payloads?: Record<string, string>;
}

interface Record_ {
  id: string;
  installationId: string;
  workspaceId: string;
  notificationId: string;
  event: NotificationEvent;
  recipientId: string;
  conversationId: string;
  status: string;
  processedAttempt: number;
  expiresAt: number;
}

interface Target {
  deviceId: string;
  subscriptionId: string;
  bundleId: string;
  token: string;
  muted: number;
}

export function backoffSeconds(attempt: number): number {
  return BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]!;
}

async function deliverOne(env: Env, transport: ApnsTransport, record: Record_, target: Target, sealed: string): Promise<'delivered' | 'invalid' | 'failed' | 'retry'> {
  const push = await composePush({ ...record, subscriptionId: target.subscriptionId, c: sealed });
  const token = await decryptToken(env.RELAY_TOKEN_KEY!, target.bundleId, target.token);
  const outcome = await sendToApns(env, transport, { deviceToken: token, topic: target.bundleId, ...push });
  const fields = { jobType: 'apns_send', errorCode: outcome.response?.reason ?? ('failure' in outcome ? outcome.failure : outcome.action), ...(outcome.response ? { status: outcome.response.status } : {}), installationId: record.installationId };
  switch (outcome.action) {
    case 'delivered':
      return 'delivered';
    case 'remove_device':
      // A surge of BadDeviceToken often means a mix-up of sandbox and production, not dead tokens.
      log.warn('apns.device_removed', fields);
      return 'invalid';
    case 'permanent_failure':
      log.error('apns.permanent_failure', fields);
      return 'failed';
    case 'credential_error':
    case 'stop_minting':
    case 'refresh_token':
      log.error('apns.credential_error', fields);
      return 'retry';
    default:
      log.warn('apns.retry', fields);
      return 'retry';
  }
}

/**
 * Handles one notification. Delivery is at least once: a crash can resend to a device, which `apns-collapse-id` folds
 * into one alert, and `processed_attempt` keeps the counts right. The next attempt is queued before results are
 * recorded, so a crash in between can repeat work but cannot lose it.
 */
export async function deliver(env: Env, transport: ApnsTransport, message: DeliveryMessage): Promise<void> {
  const { DB: db } = env;
  const record = await db
    .prepare(
      `SELECT n.id, n.installation_id AS installationId, n.workspace_id AS workspaceId, n.notification_id AS notificationId, n.event, n.recipient_id AS recipientId,
              n.conversation_id AS conversationId, n.status, n.processed_attempt AS processedAttempt, n.expires_at AS expiresAt
       FROM notifications n
       WHERE n.id = ? AND n.installation_id = ?`,
    )
    .bind(message.id, message.installationId)
    .first<Record_>();
  if (!record || record.processedAttempt >= message.attempt) return;

  const now = Date.now();
  const rows = await db
    .prepare(
      `SELECT d.id AS deviceId, s.id AS subscriptionId, d.bundle_id AS bundleId, d.apns_token AS token, s.muted
       FROM subscriptions s JOIN devices d ON d.id = s.device_id
       JOIN workspaces w ON w.installation_id = s.installation_id AND w.workspace_id = s.workspace_id AND w.status = 'active'
       WHERE s.installation_id = ? AND s.workspace_id = ? AND s.recipient_id = ?`,
    )
    .bind(record.installationId, record.workspaceId, record.recipientId)
    .all<Target>();
  const wanted = message.deviceIds ? new Set(message.deviceIds) : null;
  // A message queued by an earlier version has none, and so delivers nothing.
  const payloads = message.payloads ?? {};
  // A phone the installation sent no ciphertext for gets nothing: there is no readable fallback to send instead.
  const targets = rows.results.filter((row) => (!wanted || wanted.has(row.deviceId)) && payloads[row.subscriptionId] !== undefined);
  const muted = wanted ? 0 : targets.filter((t) => t.muted).length;
  const active = targets.filter((t) => !t.muted);

  const results = { delivered: 0, invalid: 0, failed: 0 };
  const retry: Target[] = [];
  const invalid: string[] = [];
  const expired = now >= record.expiresAt;
  if (expired) {
    results.failed = active.length;
  } else {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, active.length) }, async () => {
        while (next < active.length) {
          const target = active[next++]!;
          const result = await deliverOne(env, transport, record, target, payloads[target.subscriptionId]!);
          if (result === 'retry') retry.push(target);
          else {
            results[result] += 1;
            if (result === 'invalid') invalid.push(target.deviceId);
          }
        }
      }),
    );
  }

  const delay = backoffSeconds(message.attempt);
  const canRetry = retry.length > 0 && Date.now() + delay * 1000 < record.expiresAt;
  if (retry.length > 0 && !canRetry) results.failed += retry.length;
  if (canRetry) {
    const next: DeliveryMessage = {
      id: record.id,
      installationId: record.installationId,
      attempt: message.attempt + 1,
      deviceIds: retry.map((target) => target.deviceId),
      payloads: Object.fromEntries(retry.map((target) => [target.subscriptionId, payloads[target.subscriptionId]!])),
    };
    await env.DELIVERY_QUEUE.send(next, { delaySeconds: delay, contentType: 'json' });
  }

  const hadNothing = !wanted && targets.length === 0;
  const status = canRetry ? 'delivering' : hadNothing ? 'no_devices' : expired || (retry.length > 0 && !canRetry) ? 'expired' : 'completed';
  await db.batch([
    ...invalid.flatMap((deviceId) => [db.prepare('DELETE FROM subscriptions WHERE device_id = ?').bind(deviceId), db.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId)]),
    db
      .prepare(
        `UPDATE notifications SET status = ?, delivered = delivered + ?, invalid_token = invalid_token + ?, failed = failed + ?, muted = muted + ?, processed_attempt = ?, updated_at = ?
         WHERE id = ? AND processed_attempt < ?`,
      )
      .bind(status, results.delivered, results.invalid, results.failed, muted, message.attempt, Date.now(), record.id, message.attempt),
  ]);
}

export async function handleDeliveryBatch(batch: MessageBatch<DeliveryMessage>, env: Env, transport: ApnsTransport): Promise<void> {
  for (const message of batch.messages) {
    try {
      await deliver(env, transport, message.body);
      message.ack();
    } catch (error) {
      log.error('delivery.failed', { errorName: error instanceof Error ? error.name : 'unknown', attempts: message.attempts });
      message.retry({ delaySeconds: backoffSeconds(message.attempts) });
    }
  }
}
