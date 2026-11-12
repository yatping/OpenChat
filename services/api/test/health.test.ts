import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { generateSerializedKey } from '@openchat/auth';
import { importPublicKey, verifyRequest } from '@openchat/notification-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const RELAY = 'https://relay.example.org';
const TOKEN = 'operator-token-for-tests';
const key = await generateSerializedKey('k1');
const operatorEnv = { ...env, OPERATOR_TOKEN: TOKEN } as unknown as Env;
const relayEnv = { ...operatorEnv, RELAY_URL: RELAY, RELAY_ID: 'managed', RELAY_BUNDLE_IDS: 'org.example.app', RELAY_SIGNING_KEY: JSON.stringify({ active: key }) } as unknown as Env;

const get = (path: string, options: { token?: string | null; env?: Env } = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, { headers: options.token === null ? {} : { authorization: `Bearer ${options.token ?? TOKEN}` } }),
    options.env ?? operatorEnv,
    createExecutionContext(),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;
const minute = () => Math.floor(Date.now() / 60_000);

beforeEach(async () => {
  await env.DB.batch(['job_receipts', 'outbox', 'failed_jobs', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`).run();
});

afterEach(() => vi.unstubAllGlobals());

describe('operator health checks', () => {
  it('do not exist without the operator token, or with the wrong one', async () => {
    for (const path of ['/health/database', '/health/queues', '/health/realtime', '/health/notifications']) {
      expect((await get(path, { token: null })).status).toBe(404);
      expect((await get(path, { token: 'wrong' })).status).toBe(404);
      expect((await get(path, { env: env as unknown as Env })).status).toBe(404);
    }
  });

  it('leave the public health check as it was', async () => {
    const response = await get('/health', { token: null });
    expect([response.status, await response.json()]).toEqual([200, { status: 'ok' }]);
  });

  it('report the database, its latest migration, and its size', async () => {
    const response = await get('/health/database');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await body(response);
    expect(result).toMatchObject({ status: 'ok', problems: [], sizeLimitBytes: 10 * 1024 ** 3 });
    expect(result.migration).toMatch(/^\d{4}_.+\.sql$/);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('fail background work when no heartbeat has come through the queue', async () => {
    const response = await get('/health/queues');
    expect(response.status).toBe(503);
    expect(await body(response)).toMatchObject({ status: 'fail', problems: ['no_heartbeat'], heartbeatAgeSeconds: null });
  });

  it('pass with a recent heartbeat, and use the newest one', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES (?1, 'system.heartbeat', 'claimed', ?2)`).bind(`heartbeat:${minute() - 30}`, Date.now() - 1_800_000),
      env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES (?1, 'system.heartbeat', 'claimed', ?2)`).bind(`heartbeat:${minute()}`, Date.now() - 20_000),
      env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES ('notification:zzz', 'notification.dispatch', 'claimed', 1)`),
    ]);
    const response = await get('/health/queues');
    expect(response.status).toBe(200);
    const result = await body(response);
    expect(result).toMatchObject({ status: 'ok', problems: [], oldestPendingOutboxSeconds: null, unreviewedFailedJobs: 0 });
    expect(result.heartbeatAgeSeconds).toBeGreaterThanOrEqual(19);
    expect(result.heartbeatAgeSeconds).toBeLessThan(60);
  });

  it('fail a stale heartbeat or a stuck outbox, and warn about failed jobs', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES (?1, 'system.heartbeat', 'claimed', ?2)`).bind(`heartbeat:${minute() - 10}`, Date.now() - 600_000),
      env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at) VALUES ('out_1', 'work_1', 'message.created', 'conv_1', '{}', ?1)`).bind(Date.now() - 900_000),
      env.DB.prepare(`INSERT INTO failed_jobs (id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at) VALUES ('fjob_1', 'oc-jobs-dlq', 'x', 'k1', 3, '{}', 1)`),
      env.DB.prepare(`INSERT INTO failed_jobs (id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at, replayed_at) VALUES ('fjob_2', 'oc-jobs-dlq', 'x', 'k2', 3, '{}', 1, 2)`),
    ]);
    const response = await get('/health/queues');
    expect(response.status).toBe(503);
    expect(await body(response)).toMatchObject({ status: 'fail', problems: ['heartbeat_stale', 'outbox_stuck', 'failed_jobs'], unreviewedFailedJobs: 1 });
  });

  it('only warn when the outbox is slow', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES (?1, 'system.heartbeat', 'claimed', ?2)`).bind(`heartbeat:${minute()}`, Date.now()),
      env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at) VALUES ('out_1', 'work_1', 'message.created', 'conv_1', '{}', ?1)`).bind(Date.now() - 240_000),
    ]);
    const response = await get('/health/queues');
    expect([response.status, (await body(response)).problems]).toEqual([200, ['outbox_slow']]);
  });

  it('reach a Durable Object', async () => {
    const response = await get('/health/realtime');
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ status: 'ok', problems: [] });
  });

  describe('push', () => {
    let relayStatus = 404;
    let verified: boolean[] = [];
    beforeEach(() => {
      verified = [];
      relayStatus = 404;
      const real = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== RELAY) return real(input, init);
        const h = request.headers;
        const verdict = await verifyRequest(
          await importPublicKey(key.publicKey),
          { method: request.method, path: url.pathname, installationId: h.get('x-installation-id')!, keyId: h.get('x-key-id')!, requestId: h.get('x-request-id')!, timestamp: h.get('x-timestamp')!, body: new Uint8Array(await request.arrayBuffer()) },
          h.get('x-signature')!,
        );
        verified.push(verdict.ok && request.method === 'GET' && url.pathname.startsWith('/v1/notifications/') && h.get('x-installation-id') === 'inst_test');
        return new Response(JSON.stringify({ code: 'x' }), { status: relayStatus });
      });
    });

    it('is off without a relay, and does not call one', async () => {
      const response = await get('/health/notifications');
      expect([response.status, await body(response)]).toEqual([200, { status: 'ok', problems: [], relay: 'off', roundTripMs: null }]);
      expect(verified).toEqual([]);
    });

    it('says when the installation is not registered yet, or was disconnected', async () => {
      expect((await body(await get('/health/notifications', { env: relayEnv }))).relay).toBe('unregistered');
      await env.DB.prepare(`UPDATE installation SET relay_disconnected_id = 'managed'`).run();
      expect((await body(await get('/health/notifications', { env: relayEnv }))).relay).toBe('disconnected');
      expect(verified).toEqual([]);
    });

    it('checks the signature with a signed request that sends nothing', async () => {
      await env.DB.prepare(`UPDATE installation SET relay_registered_id = 'managed'`).run();
      const response = await get('/health/notifications', { env: relayEnv });
      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({ status: 'ok', problems: [], relay: 'ok' });
      expect(verified).toEqual([true]);
    });

    it('only warns when the relay refuses or cannot be reached', async () => {
      await env.DB.prepare(`UPDATE installation SET relay_registered_id = 'managed'`).run();
      relayStatus = 401;
      const refused = await get('/health/notifications', { env: relayEnv });
      expect([refused.status, await body(refused)]).toMatchObject([200, { status: 'warn', problems: ['relay_rejected'], relay: 'rejected' }]);
      relayStatus = 502;
      const down = await get('/health/notifications', { env: relayEnv });
      expect([down.status, await body(down)]).toEqual([200, { status: 'warn', problems: ['relay_unreachable'], relay: 'unreachable', roundTripMs: null }]);
    });
  });
});
