import { type ApnsTransport, RELAY_PROTOCOL_VERSION } from '@openchat/notification-protocol';
import { createLogger } from '@openchat/shared';
import { Hono } from 'hono';
import { runApnsSelfCheck } from './apns/self-check';
import { WorkersFetchTransport } from './apns/transport';
import type { Env } from './env';

export { ApnsCredential } from './apns/credential';

const log = createLogger();

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(presented), await digest(expected));
}

export function createApp(transportFor: () => ApnsTransport = () => new WorkersFetchTransport()) {
  const app = new Hono<{ Bindings: Env }>();
  const notFound = { code: 'not_found', status: 404, title: 'Not found', protocolVersion: RELAY_PROTOCOL_VERSION };

  app.get('/health', (c) => c.json({ status: 'ok' as const }));

  // For the relay's operator. Answers 404 to everyone else, or if no operator token is set.
  app.post('/v1/operator/apns-check', async (c) => {
    const expected = c.env.RELAY_OPERATOR_TOKEN;
    const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!expected || !presented || !(await tokenMatches(presented, expected))) return c.json(notFound, 404);
    return c.json(await runApnsSelfCheck(c.env, transportFor()));
  });

  app.notFound((c) => c.json(notFound, 404));
  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env) {
    const result = await runApnsSelfCheck(env, new WorkersFetchTransport());
    if (result.outcome === 'not_configured') return;
    const fields = { jobType: 'apns_self_check', errorCode: result.outcome, durationMs: result.durationMs, ...(result.status ? { status: result.status } : {}) };
    if (result.outcome === 'ok') log.info('apns.self_check', fields);
    else log.error('apns.self_check', fields);
  },
} satisfies ExportedHandler<Env>;
