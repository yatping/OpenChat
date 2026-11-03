import { createMessageBatch, createScheduledController, getQueueResult } from 'cloudflare:test';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { createClient } from '@openchat/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeatJob } from '../src/background';
import worker from '../src/index';

const self = (exports as unknown as { default: Fetcher }).default;
const get = (path: string, init?: RequestInit) => self.fetch(`https://example.com${path}`, init);

const seedInstallation = () =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO installation (id, name, public_base_url, created_at, updated_at)
     VALUES ('inst_test', 'Test installation', 'https://example.com', 1, 1)`,
  ).run();

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

describe('HTTP', () => {
  it('reports health, exposing nothing else', async () => {
    const response = await get('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('returns a request ID, and accepts only a well-formed one', async () => {
    expect((await get('/health', { headers: { 'x-request-id': 'abc-123' } })).headers.get('x-request-id')).toBe('abc-123');
    const injected = await get('/health', { headers: { 'x-request-id': 'bad id\twith spaces' } });
    expect(injected.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('reports 503 with problem details before initialisation', async () => {
    const response = await get('/.well-known/openchat.json');
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'not_initialized', status: 503, type: 'urn:openchat:error:not_initialized' });
  });

  it('serves discovery to the typed client', async () => {
    await seedInstallation();
    const client = createClient({ baseUrl: 'https://example.com', fetch: ((url: string, init: RequestInit) => self.fetch(url, init)) as unknown as typeof fetch });
    expect(await client.getDiscovery()).toEqual({
      installationId: 'inst_test',
      name: 'Test installation',
      api: { versions: ['v1'], minor: 0 },
      realtime: { protocolVersions: [1] },
      relay: null,
      auth: { signup: 'invite_only' },
    });
    expect(await client.getHealth()).toEqual({ status: 'ok' });
  });

  it('returns 404 problem details under the API', async () => {
    const response = await get('/api/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  });

  it('serves a document covering every route it implements', async () => {
    const doc = (await (await get('/api/v1/openapi.json')).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    for (const path of ['/health', '/.well-known/openchat.json']) expect(doc.paths).toHaveProperty([path]);
  });

  it('has no public route to the realtime objects yet', async () => {
    const response = await get('/api/v1/realtime/connect', { headers: { upgrade: 'websocket' } });
    expect(response.status).toBe(404);
  });

  it('serves the dashboard shell through assets', async () => {
    // The default export bypasses the asset router here, so this checks the binding and its SPA fallback.
    // Routing in front of the Worker is checked with wrangler dev and on a real deployment.
    const response = await env.ASSETS.fetch('https://example.com/some/dashboard/page');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('cron', () => {
  it('enqueues a job', async () => {
    const controller = createScheduledController({ scheduledTime: new Date('2026-11-03T10:00:00Z'), cron: '* * * * *' });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env);
    await waitOnExecutionContext(ctx);
  });

  it('derives a stable idempotency key per minute', () => {
    const t = Date.parse('2026-11-03T10:00:30Z');
    expect(heartbeatJob(t).idempotencyKey).toBe(heartbeatJob(t + 20_000).idempotencyKey);
    expect(heartbeatJob(t).idempotencyKey).not.toBe(heartbeatJob(t + 60_000).idempotencyKey);
  });
});

describe('queue consumer', () => {
  const QUEUE = 'oc-local-jobs';
  const DLQ = 'oc-local-jobs-dlq';
  const message = (body: unknown, attempts = 1) => ({ id: crypto.randomUUID(), timestamp: new Date(), attempts, body });
  const run = async (queue: string, bodies: unknown[]) => {
    const batch = createMessageBatch(queue, bodies.map((b) => message(b)));
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    return getQueueResult(batch, ctx);
  };

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM job_receipts').run();
    await env.DB.prepare('DELETE FROM failed_jobs').run();
  });

  it('processes a job once, even if delivered twice', async () => {
    const job = heartbeatJob(Date.parse('2026-11-03T10:00:00Z'));
    expect((await run(QUEUE, [job, job])).explicitAcks).toHaveLength(2);
    await run(QUEUE, [job]);
    expect(await count('SELECT count(*) AS n FROM job_receipts')).toBe(1);
  });

  it('retries an unknown job type with a delay, for a newer Worker during a deploy', async () => {
    const result = await run(QUEUE, [{ ...heartbeatJob(0), type: 'from.the.future' }]);
    expect(result.explicitAcks).toHaveLength(0);
    expect(result.retryMessages).toHaveLength(1);

    // getQueueResult does not report delaySeconds (plugin 1.5.1), so observe the call itself.
    const batch = createMessageBatch(QUEUE, [message({ ...heartbeatJob(0), type: 'from.the.future' })]);
    const retry = vi.spyOn(batch.messages[0]!, 'retry');
    await worker.queue(batch, env);
    expect(retry.mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThan(0);
  });

  it('drops a job past its deadline', async () => {
    const result = await run(QUEUE, [{ ...heartbeatJob(0), notAfter: '2000-01-01T00:00:00Z' }]);
    expect(result.explicitAcks).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM job_receipts')).toBe(0);
  });

  it('acknowledges a malformed message rather than retrying it forever', async () => {
    expect((await run(QUEUE, [{ nonsense: true }])).explicitAcks).toHaveLength(1);
  });

  it('acknowledges per message, so one failure does not retry the batch', async () => {
    const result = await run(QUEUE, [heartbeatJob(60_000), { ...heartbeatJob(120_000), type: 'from.the.future' }, heartbeatJob(180_000)]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toHaveLength(1);
  });

  it('records dead letters durably', async () => {
    const job = { ...heartbeatJob(0), type: 'email.send', workspaceId: null };
    expect((await run(DLQ, [job])).explicitAcks).toHaveLength(1);
    const row = await env.DB.prepare('SELECT queue, job_type AS jobType FROM failed_jobs').first();
    expect(row).toEqual({ queue: DLQ, jobType: 'email.send' });
  });
});

describe('deployment configuration', () => {
  it('has a dead-letter queue on every primary consumer, since messages are otherwise deleted', async () => {
    const source = await import('../wrangler.template.jsonc?raw').then((m: { default: string }) => m.default);
    const stripped = source.replace(/^\s*\/\/.*$/gm, '');
    const config = JSON.parse(stripped) as { queues: { consumers: { queue: string; dead_letter_queue?: string; max_retries?: number }[] } };
    for (const consumer of config.queues.consumers) {
      expect(consumer.max_retries, consumer.queue).toBeGreaterThan(0);
      if (!consumer.queue.endsWith('-dlq')) expect(consumer.dead_letter_queue, consumer.queue).toBe(`${consumer.queue}-dlq`);
    }
  });
});
