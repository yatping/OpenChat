import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { EmailSendError, type EmailMessage } from '@openchat/email';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from '../src/background';
import { sweepOutbox } from '../src/dispatch';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = 'work_a';

type Job = { type: string; workspaceId: string; idempotencyKey: string; notAfter?: string; payload: Record<string, unknown> };
let queued: Job[] = [];
const queue = { send: async (job: Job) => void queued.push(job), sendBatch: async (jobs: { body: Job }[]) => void queued.push(...jobs.map((j) => j.body)) } as unknown as Queue;
const configured = { ...env, EMAIL_QUEUE: queue, NOTIFICATIONS_QUEUE: queue, EMAIL_PROVIDER: 'console', SYSTEM_EMAIL_FROM: 'no-reply@mail.example.com' } as unknown as Env;
const unconfigured = { ...env, EMAIL_QUEUE: queue, NOTIFICATIONS_QUEUE: queue, EMAIL_PROVIDER: undefined } as unknown as Env;

let counter = 0;
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string; env?: Env } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `192.0.2.${++counter % 250}`, ...(options.origin ? { origin: options.origin } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.env ?? configured,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let sent: EmailMessage[] = [];
let sendImpl: (m: EmailMessage) => Promise<{ messageId: string }>;
const provider = { send: (m: EmailMessage) => sendImpl(m) };

async function runQueue() {
  const outcomes: { job: Job; acked: boolean }[] = [];
  while (queued.length > 0) {
    const jobs = queued;
    queued = [];
    const messages = jobs.map((body) => {
      const outcome = { job: body, acked: false };
      outcomes.push(outcome);
      return { id: crypto.randomUUID(), body, attempts: 1, ack: () => { outcome.acked = true; }, retry: () => undefined };
    });
    await handleQueue({ queue: 'oc-local-email', messages } as unknown as MessageBatch, configured, { email: provider });
  }
  return outcomes;
}

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

const tokens: Record<string, string> = {};
beforeEach(async () => {
  queued = [];
  sent = [];
  sendImpl = async (m) => {
    sent.push(m);
    return { messageId: `id-${sent.length}` };
  };
  const tables = ['email_deliveries', 'notification_preferences', 'push_subscriptions', 'outbox', 'audit_log', 'conversation_events', 'messages', 'conversation_read_cursors', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_tokens', 'auth_sessions', 'workspaces', 'users', 'installation', 'failed_jobs'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', ?1, 1, 1)`).bind(ORIGIN),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, 'Acme', 'acme', 1, 1)`).bind(W),
    ...['one', 'two'].flatMap((name) => [
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${name}`, `${name}@example.com`, name, hash),
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'supervisor', 'active', 1, 1)`).bind(`mem_${name}`, W, `user_${name}`),
    ]),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_a', ?1, 'Site', 'key_a', json_array(?2), 1, 1)`).bind(W, SITE),
  ]);
  for (const name of ['one', 'two']) {
    const login = await call('POST', '/api/v1/auth/login', { body: { email: `${name}@example.com`, password: PASSWORD, clientType: 'dashboard' } });
    tokens[name] = ((await login.json()) as { accessToken: string }).accessToken;
  }
});

const turnOn = (name: string, ...events: string[]) =>
  call('PUT', `/api/v1/workspaces/${W}/notification-preferences`, { token: tokens[name]!, body: { preferences: events.map((eventType) => ({ eventType, channel: 'email', enabled: true })) } });

async function visitorStarts(options: { env?: Env } = {}) {
  const session = await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_a' }, ...options });
  const token = ((await session.json()) as { accessToken: string }).accessToken;
  const created = await call('POST', '/api/v1/widget/conversations', { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'private words' }, ...options });
  expect(created.status).toBe(201);
  return { token, id: ((await created.json()) as { id: string }).id };
}
const makeDue = (id: string) => env.DB.prepare(`UPDATE conversations SET next_unanswered_alert_at = 1 WHERE id = ?1`).bind(id).run();
const dueAt = async (id: string) => (await env.DB.prepare(`SELECT next_unanswered_alert_at AS at FROM conversations WHERE id = ?1`).bind(id).first<{ at: number | null }>())!.at;
const reply = (id: string, type = 'text') => call('POST', `/api/v1/workspaces/${W}/conversations/${id}/messages`, { token: tokens.one!, body: { clientMessageId: crypto.randomUUID(), type, content: 'answer' } });

describe('a new conversation', () => {
  it('emails only those who asked, with no message text and no address in any job', async () => {
    await turnOn('one', 'new_conversation');
    await visitorStarts();
    const seen = JSON.stringify(queued);
    const outcomes = await runQueue();
    expect(sent.map((m) => m.to)).toEqual(['one@example.com']);
    expect(sent[0]).toMatchObject({ subject: 'New conversation in Acme', from: { name: 'Acme', email: 'no-reply@mail.example.com' } });
    expect(`${sent[0]!.text}${sent[0]!.html}`).not.toContain('private words');
    expect(`${sent[0]!.text}`).toContain(`${ORIGIN}/`);
    expect(JSON.stringify(outcomes.map((o) => o.job))).not.toContain('@example.com');
    expect(seen).not.toContain('private words');
  });

  it('emails nobody by default', async () => {
    await visitorStarts();
    await runQueue();
    expect(sent).toEqual([]);
  });

  it('queues nothing with no provider, and the visitor is unaffected', async () => {
    await turnOn('one', 'new_conversation');
    await visitorStarts({ env: unconfigured });
    expect(queued.filter((j) => j.type.startsWith('email.'))).toEqual([]);
  });

  it('leaves out someone suspended, deactivated, or who has since turned it off', async () => {
    await turnOn('one', 'new_conversation');
    await turnOn('two', 'new_conversation');
    await visitorStarts();
    await env.DB.prepare(`UPDATE workspace_members SET status = 'suspended' WHERE id = 'mem_one'`).run();
    await env.DB.prepare(`UPDATE users SET disabled_at = 1 WHERE id = 'user_two'`).run();
    await runQueue();
    expect(sent).toEqual([]);
  });

  it('checks again just before sending', async () => {
    await turnOn('one', 'new_conversation');
    await visitorStarts();
    const alert = queued.filter((j) => j.type === 'email.alert');
    queued = alert;
    const first = queued.splice(0);
    queued = first;
    const messages = queued.splice(0).map((body) => ({ id: 'x', body, attempts: 1, ack: () => undefined, retry: () => undefined }));
    await handleQueue({ queue: 'oc-local-email', messages } as unknown as MessageBatch, configured, { email: provider });
    await call('PUT', `/api/v1/workspaces/${W}/notification-preferences`, { token: tokens.one!, body: { preferences: [] } });
    await runQueue();
    expect(sent).toEqual([]);
  });
});

describe('a visitor left waiting', () => {
  beforeEach(async () => {
    await turnOn('one', 'conversation_unanswered');
    await turnOn('two', 'conversation_unanswered');
  });
  const sweep = () => sweepOutbox(configured, Date.now());

  it('starts a clock with their message, about 15 minutes out', async () => {
    const { id } = await visitorStarts();
    const at = await dueAt(id);
    expect(at).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(at).toBeLessThan(Date.now() + 16 * 60_000);
  });

  it('does not push the clock back with each further message', async () => {
    const { id, token } = await visitorStarts();
    await env.DB.prepare(`UPDATE conversations SET next_unanswered_alert_at = 12345678 WHERE id = ?1`).bind(id).run();
    await call('POST', `/api/v1/widget/conversations/${id}/messages`, { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'still there?' } });
    expect(await dueAt(id)).toBe(12345678);
  });

  it('stops the clock on a public reply, and not on an internal note', async () => {
    const { id } = await visitorStarts();
    await reply(id, 'internal_note');
    expect(await dueAt(id)).not.toBeNull();
    await reply(id);
    expect(await dueAt(id)).toBeNull();
  });

  it('still emails after an internal note, which the visitor never sees', async () => {
    const { id } = await visitorStarts();
    expect((await reply(id, 'internal_note')).status).toBe(201);
    queued = [];
    await makeDue(id);
    await sweep();
    await runQueue();
    expect(sent.map((m) => m.to).sort()).toEqual(['one@example.com', 'two@example.com']);
  });

  it('emails when due, and only once however often the sweep runs', async () => {
    const { id } = await visitorStarts();
    queued = [];
    await makeDue(id);
    await sweep();
    expect(await dueAt(id)).toBeNull();
    await sweep();
    await runQueue();
    expect(sent.map((m) => m.to).sort()).toEqual(['one@example.com', 'two@example.com']);
    expect(sent[0]!.subject).toBe('A visitor is waiting in Acme');
  });

  it('goes only to the person who has the conversation', async () => {
    const { id } = await visitorStarts();
    queued = [];
    await env.DB.prepare(`UPDATE conversations SET assigned_member_id = 'mem_two' WHERE id = ?1`).bind(id).run();
    await makeDue(id);
    await sweep();
    await runQueue();
    expect(sent.map((m) => m.to)).toEqual(['two@example.com']);
  });

  it('sends nothing if answered or resolved before it runs', async () => {
    const answered = await visitorStarts();
    const resolved = await visitorStarts();
    queued = [];
    await makeDue(answered.id);
    await makeDue(resolved.id);
    await sweep();
    await env.DB.prepare(`UPDATE conversations SET last_agent_message_at = last_visitor_message_at + 1 WHERE id = ?1`).bind(answered.id).run();
    await env.DB.prepare(`UPDATE conversations SET status = 'resolved' WHERE id = ?1`).bind(resolved.id).run();
    await runQueue();
    expect(sent).toEqual([]);
  });

  it('clears the clock with no provider, rather than letting it pile up', async () => {
    const { id } = await visitorStarts({ env: unconfigured });
    await makeDue(id);
    queued = [];
    await sweepOutbox(unconfigured, Date.now());
    expect(queued).toEqual([]);
    expect(await dueAt(id)).toBeNull();
  });
});

describe('sending once', () => {
  beforeEach(() => turnOn('one', 'new_conversation'));

  const sendJob = async () => {
    await visitorStarts();
    const fanout = queued.filter((j) => j.type === 'email.alert');
    queued = fanout;
    const first = queued.splice(0);
    const messages = first.map((body) => ({ id: 'x', body, attempts: 1, ack: () => undefined, retry: () => undefined }));
    await handleQueue({ queue: 'oc-local-email', messages } as unknown as MessageBatch, configured, { email: provider });
    const [job] = queued.filter((j) => j.type === 'email.send');
    queued = [];
    return job!;
  };

  it('a repeated job sends nothing more, and logs a hash and no address', async () => {
    const job = await sendJob();
    queued = [job, job];
    await runQueue();
    queued = [job];
    await runQueue();
    expect(sent).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status, recipient_hash AS h, provider_message_id AS m FROM email_deliveries`).first<{ status: string; h: string; m: string }>();
    expect(row).toMatchObject({ status: 'sent', m: 'id-1' });
    expect(row!.h).not.toContain('@');
  });

  it('a failed send retries, and succeeds', async () => {
    const job = await sendJob();
    sendImpl = () => Promise.reject(new EmailSendError(503));
    queued = [job];
    expect((await runQueue())[0]!.acked).toBe(false);
    expect((await env.DB.prepare(`SELECT status FROM email_deliveries`).first<{ status: string }>())!.status).toBe('failed');
    sendImpl = async (m) => {
      sent.push(m);
      return { messageId: 'later' };
    };
    queued = [job];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('does not send again after dying between sending and recording it', async () => {
    const job = await sendJob();
    await env.DB.prepare(`INSERT INTO email_deliveries (id, workspace_id, dedupe_key, template, recipient_hash, status, created_at, updated_at) VALUES ('mail_x', ?1, ?2, 'new_conversation', 'h', 'claimed', 1, 1)`).bind(W, `alert:${String(job.payload.eventId)}:mem_one`).run();
    queued = [job];
    expect((await runQueue())[0]!.acked).toBe(true);
    expect(sent).toEqual([]);
  });

  it('an email outage leaves messaging alone', async () => {
    sendImpl = () => Promise.reject(new EmailSendError(503));
    const { id } = await visitorStarts();
    await runQueue();
    expect((await reply(id)).status).toBe(201);
  });
});

it('the template keeps a workspace name out of the headers and the markup', async () => {
  const { alertEmail } = await import('@openchat/core');
  const mail = alertEmail({ kind: 'new_conversation', workspaceName: 'Ev<i>l\r\nBcc: x@example.com', publicBaseUrl: 'https://chat.example.com/' });
  expect(mail.subject).not.toMatch(/[\r\n]/);
  expect(mail.html).not.toContain('<i>');
  expect(mail.text).toContain('https://chat.example.com/');
  vi.restoreAllMocks();
});
