import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import type { JobEnvelope } from '@openchat/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';
const JOBS = '/api/v1/admin/failed-jobs';

const sent: { queue: string; job: JobEnvelope }[] = [];
let refuse = false;
const fakeQueue = (queue: string) => ({
  send: async (job: JobEnvelope) => {
    if (refuse) throw new Error('Queue send failed');
    sent.push({ queue, job });
  },
});
const testEnv = { ...env, NOTIFICATIONS_QUEUE: fakeQueue('notifications'), EMAIL_QUEUE: fakeQueue('email'), JOBS_QUEUE: fakeQueue('jobs') } as unknown as Env;

let counter = 0;
const call = (method: string, path: string, token?: string) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: { 'cf-connecting-ip': `198.51.100.${++counter % 250}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } }),
    testEnv,
    createExecutionContext(),
  );

async function signIn(email: string): Promise<string> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++counter % 250}` },
      body: JSON.stringify({ email, password: PASSWORD, clientType: 'mobile' }),
    }),
    testEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

interface FailedJob {
  id: string;
  jobType: string;
  queue: string;
  workspace: { id: string; name: string } | null;
  attempts: number;
  failedAt: string;
  replayedAt: string | null;
  replayable: boolean;
}

const envelope = (type: string, key: string, extra: Partial<JobEnvelope> = {}): JobEnvelope => ({
  v: 1,
  type,
  id: `job_${key}`,
  idempotencyKey: key,
  workspaceId: 'work_1',
  occurredAt: '2026-11-01T00:00:00.000Z',
  payload: { conversationId: 'conv_1' },
  ...extra,
});

const insert = (id: string, queue: string, failedAt: number, envelopeJson: string, workspaceId: string | null = 'work_1', jobType = 'automation.evaluate') =>
  env.DB.prepare(`INSERT INTO failed_jobs (id, workspace_id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at) VALUES (?1, ?2, ?3, ?4, ?1, 5, ?5, ?6)`).bind(id, workspaceId, queue, jobType, envelopeJson, failedAt);

const tokens: Record<string, string> = {};
let hash = '';

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  sent.length = 0;
  refuse = false;
  await env.DB.batch(['failed_jobs', 'audit_log', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  const future = new Date(Date.now() + 3_600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1)`),
    ...['boss', 'owner'].map((u) => env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)`).bind(`user_${u}`, `${u}@example.com`, u, hash, u === 'boss' ? 1 : 0)),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_owner', 'work_1', 'user_owner', 'supervisor', 'active', 1, 1)`),
    insert('fjob_email', 'oc-test-email-dlq', 5_000, JSON.stringify(envelope('email.follow_up', 'follow-up:1', { notAfter: future })), 'work_1', 'email.follow_up'),
    insert('fjob_jobs', 'oc-test-jobs', 4_000, JSON.stringify(envelope('automation.evaluate', 'evaluate:1'))),
    insert('fjob_expired', 'oc-test-email', 3_000, JSON.stringify(envelope('email.follow_up', 'follow-up:2', { notAfter: '2026-01-01T00:00:00.000Z' }))),
    insert('fjob_malformed', 'oc-test-notifications-dlq', 2_000, '{}', null, 'unknown'),
    insert('fjob_elsewhere', 'someone-elses-queue', 1_000, JSON.stringify(envelope('automation.evaluate', 'evaluate:2')), 'work_gone'),
  ]);
  tokens.boss = await signIn('boss@example.com');
  tokens.owner = await signIn('owner@example.com');
});

const list = async (query = '') => {
  const response = await call('GET', `${JOBS}${query}`, tokens.boss);
  expect(response.status).toBe(200);
  return (await response.json()) as { data: FailedJob[]; nextCursor: string | null };
};
const code = async (response: Response) => ((await response.json()) as { code: string }).code;
const audit = async () => (await env.DB.prepare(`SELECT action, actor_id AS actorId, target_id AS targetId, workspace_id AS workspaceId FROM audit_log ORDER BY created_at, id`).all()).results;

describe('failed jobs', () => {
  it('lists them newest first, with no contents, and says which can be replayed', async () => {
    const { data, nextCursor } = await list();
    expect(nextCursor).toBeNull();
    expect(data.map((j) => [j.id, j.replayable])).toEqual([
      ['fjob_email', true],
      ['fjob_jobs', true],
      ['fjob_expired', false],
      ['fjob_malformed', false],
      ['fjob_elsewhere', false],
    ]);
    expect(data[0]).toEqual({ id: 'fjob_email', jobType: 'email.follow_up', queue: 'oc-test-email-dlq', workspace: { id: 'work_1', name: 'One' }, attempts: 5, failedAt: new Date(5_000).toISOString(), replayedAt: null, replayable: true });
    // A workspace that is gone, and an installation job, both show no workspace.
    expect(data.slice(3).map((j) => j.workspace)).toEqual([null, null]);
    expect(JSON.stringify(data)).not.toContain('conv_1');
  });

  it('pages through them', async () => {
    const first = await list('?limit=2');
    expect(first.data.map((j) => j.id)).toEqual(['fjob_email', 'fjob_jobs']);
    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.data.map((j) => j.id)).toEqual(['fjob_expired', 'fjob_malformed']);
    const third = await list(`?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`);
    expect([third.data.map((j) => j.id), third.nextCursor]).toEqual([['fjob_elsewhere'], null]);
  });

  it('replays a job once, to the queue it came from, with the same idempotency key, and audits it', async () => {
    const response = await call('POST', `${JOBS}/fjob_email/replay`, tokens.boss);
    expect(response.status).toBe(200);
    const job = (await response.json()) as FailedJob;
    expect([job.replayable, typeof job.replayedAt]).toEqual([false, 'string']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.queue).toBe('email');
    expect(sent[0]!.job).toMatchObject({ type: 'email.follow_up', idempotencyKey: 'follow-up:1', id: 'job_follow-up:1' });

    const again = await call('POST', `${JOBS}/fjob_email/replay`, tokens.boss);
    expect([again.status, await code(again)]).toEqual([409, 'already_replayed']);
    expect(sent).toHaveLength(1);

    await call('POST', `${JOBS}/fjob_jobs/replay`, tokens.boss);
    expect(sent.map((s) => s.queue)).toEqual(['email', 'jobs']);
    expect(await audit()).toEqual([
      { action: 'failed_job.replayed', actorId: 'user_boss', targetId: 'fjob_email', workspaceId: null },
      { action: 'failed_job.replayed', actorId: 'user_boss', targetId: 'fjob_jobs', workspaceId: null },
    ]);
  });

  it('refuses a job that is past its deadline, unreadable, or from an unknown queue', async () => {
    for (const id of ['fjob_expired', 'fjob_malformed', 'fjob_elsewhere']) {
      const response = await call('POST', `${JOBS}/${id}/replay`, tokens.boss);
      expect([id, response.status, await code(response)]).toEqual([id, 409, 'not_replayable']);
    }
    expect(sent).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  it('can replay again when the queue refused the job', async () => {
    refuse = true;
    const refused = await call('POST', `${JOBS}/fjob_jobs/replay`, tokens.boss);
    expect([refused.status, await code(refused)]).toEqual([503, 'queue_unavailable']);
    expect((await list()).data.find((j) => j.id === 'fjob_jobs')).toMatchObject({ replayedAt: null, replayable: true });

    refuse = false;
    expect((await call('POST', `${JOBS}/fjob_jobs/replay`, tokens.boss)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('dismisses a job, and audits it', async () => {
    const response = await call('DELETE', `${JOBS}/fjob_expired`, tokens.boss);
    expect(response.status).toBe(204);
    expect((await list()).data.map((j) => j.id)).not.toContain('fjob_expired');
    expect(await audit()).toEqual([{ action: 'failed_job.dismissed', actorId: 'user_boss', targetId: 'fjob_expired', workspaceId: null }]);
    expect((await call('DELETE', `${JOBS}/fjob_expired`, tokens.boss)).status).toBe(404);
    expect((await call('POST', `${JOBS}/fjob_expired/replay`, tokens.boss)).status).toBe(404);
  });

  it('is not there for anyone but an installation admin', async () => {
    for (const [method, path] of [['GET', JOBS], ['POST', `${JOBS}/fjob_email/replay`], ['DELETE', `${JOBS}/fjob_email`]] as const) {
      expect([path, (await call(method, path, tokens.owner)).status]).toEqual([path, 404]);
    }
    expect(sent).toEqual([]);
    expect((await list()).data).toHaveLength(5);
  });
});
