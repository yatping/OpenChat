import { type ApnsTransport, RELAY_PROTOCOL_VERSION } from '@openchat/notification-protocol';
import { createLogger, securityTxt } from '@openchat/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { runApnsSelfCheck } from './apns/self-check';
import { WorkersFetchTransport } from './apns/transport';
import { type DeliveryMessage, handleDeliveryBatch } from './delivery/consumer';
import { deleteOldNotifications, notificationRoutes } from './delivery/routes';
import { deviceRoutes } from './devices/routes';
import type { Env } from './env';
import { relayRoutes } from './requests/routes';
import { ID_PATTERN } from './requests/schemas';
import { deleteOrphanDevices, eraseInstallation } from './requests/store';
import { clearKeyCache } from './requests/verify';

export { ApnsCredential } from './apns/credential';
export { RelayGuard } from './requests/guard';

const log = createLogger();
const operatorEraseBody = z.strictObject({ installationId: z.string().regex(ID_PATTERN) });

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(presented), await digest(expected));
}

export function createApp(transportFor: () => ApnsTransport = () => new WorkersFetchTransport(), fetcher: typeof fetch = (input, init) => fetch(input, init)) {
  const app = new Hono<{ Bindings: Env }>();
  const notFound = { code: 'not_found', status: 404, title: 'Not found', protocolVersion: RELAY_PROTOCOL_VERSION };

  app.get('/health', (c) => c.json({ status: 'ok' as const }));

  // RFC 9116. Only when the relay's operator has set a contact.
  app.get('/.well-known/security.txt', (c) => {
    const body = securityTxt({ contact: c.env.SECURITY_CONTACT, policy: c.env.SECURITY_POLICY, canonical: `${new URL(c.req.url).origin}/.well-known/security.txt`, now: new Date(), subject: 'relay' });
    if (!body) return c.json(notFound, 404);
    return c.text(body, 200, { 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
  });

  // For the relay's operator. Answers 404 to everyone else, or if no operator token is set.
  const isOperator = async (c: Context<{ Bindings: Env }>) => {
    const expected = c.env.RELAY_OPERATOR_TOKEN;
    const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    return Boolean(expected && presented && (await tokenMatches(presented, expected)));
  };

  app.post('/v1/operator/apns-check', async (c) => {
    if (!(await isOperator(c))) return c.json(notFound, 404);
    return c.json(await runApnsSelfCheck(c.env, transportFor()));
  });

  // For a request to erase that reaches the operator some other way, such as by email.
  app.post('/v1/operator/erase', async (c) => {
    if (!(await isOperator(c))) return c.json(notFound, 404);
    const body = operatorEraseBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'malformed_request', status: 400, title: 'malformed request', protocolVersion: RELAY_PROTOCOL_VERSION }, 400);
    const erased = await eraseInstallation(c.env.DB, body.data.installationId);
    clearKeyCache();
    return c.json(erased);
  });

  app.route('/', relayRoutes(fetcher));
  app.route('/', deviceRoutes());
  app.route('/', notificationRoutes());

  app.notFound((c) => c.json(notFound, 404));
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    await handleDeliveryBatch(batch, env, new WorkersFetchTransport());
  },
  async scheduled(_controller, env) {
    await deleteOldNotifications(env.DB, Date.now());
    await deleteOrphanDevices(env.DB, Date.now());
    const result = await runApnsSelfCheck(env, new WorkersFetchTransport());
    if (result.outcome === 'not_configured') return;
    const fields = { jobType: 'apns_self_check', errorCode: result.outcome, durationMs: result.durationMs, ...(result.status ? { status: result.status } : {}) };
    if (result.outcome === 'ok') log.info('apns.self_check', fields);
    else log.error('apns.self_check', fields);
  },
} satisfies ExportedHandler<Env, DeliveryMessage>;
