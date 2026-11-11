import { MAX_NOTIFICATION_PAYLOADS, NOTIFICATION_EVENTS, NOTIFICATION_SEALED_PATTERN, type NotificationAccepted, type NotificationStatus, RELAY_PROTOCOL_VERSION } from '@openchat/notification-protocol';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { newOpaqueId } from '../devices/crypto';
import type { Env } from '../env';
import { ID_PATTERN } from '../requests/schemas';
import { isWorkspaceActive } from '../requests/store';
import { admitToGuard, type Rejection, readSignedHeaders, type SignedHeaders, verifyKnownInstallation } from '../requests/verify';
import type { DeliveryMessage } from './consumer';

type Ctx = Context<{ Bindings: Env }>;

const DEFAULT_LIFETIME_MS = 60 * 60_000;
const MAX_LIFETIME_MS = 24 * 60 * 60_000;
const BATCH_MAX = 100;
/** A full batch: 100 notifications, each with 20 sealed payloads of about 450 bytes. */
export const NOTIFICATION_MAX_BODY_BYTES = 1024 * 1024;
const id = z.string().regex(ID_PATTERN);

/**
 * Closed on purpose. The only content is fixed-size ciphertext for each phone, which the relay cannot decrypt
 * (ADR-0017). A readable field added here would break the promise that the relay receives no readable content.
 */
export const notificationBody = z.strictObject({
  workspaceId: id,
  event: z.enum(NOTIFICATION_EVENTS),
  recipientId: id,
  conversationId: id,
  notificationId: id,
  payloads: z
    .array(z.strictObject({ subscriptionId: id, ciphertext: z.string().regex(NOTIFICATION_SEALED_PATTERN) }))
    .min(1)
    .max(MAX_NOTIFICATION_PAYLOADS)
    .refine((items) => new Set(items.map((item) => item.subscriptionId)).size === items.length),
  expiresAt: z.iso.datetime().optional(),
  metadata: z.strictObject({ websiteId: id.optional() }).optional(),
});
type NotificationBody = z.infer<typeof notificationBody>;
const batchBody = z.strictObject({ notifications: z.array(notificationBody).min(1).max(BATCH_MAX) });

function problem(c: Ctx, r: Rejection | { status: 400 | 404 | 413; code: string }) {
  if ('retryAfterSeconds' in r) c.header('Retry-After', String(r.retryAfterSeconds));
  return c.json({ code: r.code, status: r.status, title: r.code.replaceAll('_', ' '), protocolVersion: RELAY_PROTOCOL_VERSION }, r.status);
}

async function authenticate(c: Ctx): Promise<{ ok: true; signed: SignedHeaders; bytes: Uint8Array } | { ok: false; response: Response }> {
  const signed = readSignedHeaders(c.req.raw.headers);
  if (!signed) return { ok: false, response: problem(c, { status: 400, code: 'malformed_request' }) };
  if (Number(c.req.header('content-length') ?? 0) > NOTIFICATION_MAX_BODY_BYTES) return { ok: false, response: problem(c, { status: 413, code: 'body_too_large' }) };
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > NOTIFICATION_MAX_BODY_BYTES) return { ok: false, response: problem(c, { status: 413, code: 'body_too_large' }) };
  const rejected = await verifyKnownInstallation(c.env, { method: c.req.method, path: new URL(c.req.url).pathname, body: bytes }, signed);
  if (rejected) return { ok: false, response: problem(c, rejected) };
  return { ok: true, signed, bytes };
}

function parse<T extends z.ZodType>(schema: T, bytes: Uint8Array): z.infer<T> | null {
  try {
    const result = schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Commits before queueing, and a duplicate of something still `queued` is queued again: a crash between the two
 * would otherwise lose it, because the installation's retry looks like a duplicate. Delivery tolerates the repeat.
 * The ciphertext travels only in the queue message. It is never written to D1.
 */
async function accept(env: Env, installationId: string, item: NotificationBody): Promise<NotificationAccepted> {
  const now = Date.now();
  const requested = item.expiresAt ? Date.parse(item.expiresAt) : now + DEFAULT_LIFETIME_MS;
  const expiresAt = Math.min(requested, now + MAX_LIFETIME_MS);
  const recordId = newOpaqueId('ntf');
  const inserted = await env.DB.prepare(
    `INSERT INTO notifications (id, installation_id, workspace_id, notification_id, event, recipient_id, conversation_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (installation_id, workspace_id, notification_id) DO NOTHING`,
  )
    .bind(recordId, installationId, item.workspaceId, item.notificationId, item.event, item.recipientId, item.conversationId, expiresAt, now, now)
    .run();
  const payloads = Object.fromEntries(item.payloads.map((payload) => [payload.subscriptionId, payload.ciphertext]));
  if (inserted.meta.changes === 1) {
    await env.DELIVERY_QUEUE.send({ id: recordId, installationId, attempt: 1, payloads } satisfies DeliveryMessage, { contentType: 'json' });
    return { id: recordId, notificationId: item.notificationId, status: 'queued' };
  }
  const existing = await env.DB.prepare('SELECT id, status FROM notifications WHERE installation_id = ? AND workspace_id = ? AND notification_id = ?')
    .bind(installationId, item.workspaceId, item.notificationId)
    .first<{ id: string; status: string }>();
  if (!existing) throw new Error('A notification record vanished');
  if (existing.status === 'queued') await env.DELIVERY_QUEUE.send({ id: existing.id, installationId, attempt: 1, payloads } satisfies DeliveryMessage, { contentType: 'json' });
  return { id: existing.id, notificationId: item.notificationId, status: 'duplicate' };
}

export function notificationRoutes() {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/v1/notifications/send', async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const { signed, bytes } = auth;
    const admitted = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (admitted) return problem(c, admitted);
    const body = parse(notificationBody, bytes);
    if (!body || body.workspaceId !== signed.workspaceId) return problem(c, { status: 400, code: 'malformed_request' });
    if (!(await isWorkspaceActive(c.env.DB, signed.installationId, body.workspaceId))) return problem(c, { status: 403, code: 'workspace_not_registered' });
    const quota = await c.env.RELAY_GUARD.getByName(signed.installationId).takeNotificationQuota([body.recipientId]);
    if (!quota.ok) return problem(c, { status: 429, code: 'rate_limited', retryAfterSeconds: quota.retryAfterSeconds });
    return c.json(await accept(c.env, signed.installationId, body), 202);
  });

  routes.post('/v1/notifications/batch', async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const { signed, bytes } = auth;
    const admitted = await admitToGuard(c.env, signed.installationId, signed.requestId);
    if (admitted) return problem(c, admitted);
    const body = parse(batchBody, bytes);
    if (!body || body.notifications.some((item) => item.workspaceId !== signed.workspaceId)) return problem(c, { status: 400, code: 'malformed_request' });
    if (!(await isWorkspaceActive(c.env.DB, signed.installationId, signed.workspaceId!))) return problem(c, { status: 403, code: 'workspace_not_registered' });
    const quota = await c.env.RELAY_GUARD.getByName(signed.installationId).takeNotificationQuota(body.notifications.map((item) => item.recipientId));
    if (!quota.ok) return problem(c, { status: 429, code: 'rate_limited', retryAfterSeconds: quota.retryAfterSeconds });
    const results: NotificationAccepted[] = [];
    for (const item of body.notifications) results.push(await accept(c.env, signed.installationId, item));
    return c.json({ results }, 202);
  });

  // Counts per outcome, and never tokens or device data. Another installation's record answers 404.
  routes.get('/v1/notifications/:id', async (c) => {
    const auth = await authenticate(c);
    if (!auth.ok) return auth.response;
    const admitted = await admitToGuard(c.env, auth.signed.installationId, auth.signed.requestId);
    if (admitted) return problem(c, admitted);
    const row = await c.env.DB.prepare(
      'SELECT id, notification_id AS notificationId, status, delivered, invalid_token AS invalidToken, failed, muted, updated_at AS updatedAt FROM notifications WHERE id = ? AND installation_id = ?',
    )
      .bind(c.req.param('id'), auth.signed.installationId)
      .first<{ id: string; notificationId: string; status: NotificationStatus['status']; delivered: number; invalidToken: number; failed: number; muted: number; updatedAt: number }>();
    if (!row) return problem(c, { status: 404, code: 'not_found' });
    const answer: NotificationStatus = {
      id: row.id,
      notificationId: row.notificationId,
      status: row.status,
      outcomes: { delivered: row.delivered, invalidToken: row.invalidToken, failed: row.failed, muted: row.muted },
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
    return c.json(answer);
  });

  return routes;
}

/** Records are kept for 30 days, which also bounds how long a repeat is recognised. */
export async function deleteOldNotifications(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM notifications WHERE created_at < ?').bind(now - 30 * 24 * 60 * 60_000).run();
  return result.meta.changes;
}
