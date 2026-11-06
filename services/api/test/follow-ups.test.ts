import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { EmailSendError, type EmailMessage } from '@openchat/email';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/background';
import { sweepOutbox } from '../src/dispatch';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = 'work_a';
const LONG_AGO = 1_000;

type Job = { type: string; workspaceId: string; idempotencyKey: string; notAfter?: string; payload: Record<string, unknown> };
let emailJobs: Job[] = [];
let otherJobs: Job[] = [];
const emailQueue = { send: async (job: Job) => void emailJobs.push(job), sendBatch: async (jobs: { body: Job }[]) => void emailJobs.push(...jobs.map((j) => j.body)) } as unknown as Queue;
const jobsQueue = { send: async (job: Job) => void otherJobs.push(job), sendBatch: async (jobs: { body: Job }[]) => void otherJobs.push(...jobs.map((j) => j.body)) } as unknown as Queue;
const configured = { ...env, EMAIL_QUEUE: emailQueue, JOBS_QUEUE: jobsQueue, NOTIFICATIONS_QUEUE: jobsQueue, EMAIL_PROVIDER: 'console', SYSTEM_EMAIL_FROM: 'no-reply@mail.example.com' } as unknown as Env;
const unconfigured = { ...configured, EMAIL_PROVIDER: undefined } as unknown as Env;

let counter = 0;
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${++counter % 250}`, ...(options.origin ? { origin: options.origin } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    configured,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let sent: EmailMessage[] = [];
let sendImpl: (m: EmailMessage) => Promise<{ messageId: string }>;
const provider = { send: (m: EmailMessage) => sendImpl(m) };

async function deliver(queue: string, jobs: Job[]) {
  const outcomes: { job: Job; acked: boolean }[] = [];
  const messages = jobs.map((body) => {
    const outcome = { job: body, acked: false };
    outcomes.push(outcome);
    return { id: crypto.randomUUID(), body, attempts: 1, ack: () => { outcome.acked = true; }, retry: () => undefined };
  });
  await handleQueue({ queue, messages } as unknown as MessageBatch, configured, { email: provider });
  return outcomes;
}

/** Runs sweep, evaluate, and send, as cron and the queues would. */
async function runSweep() {
  await sweepOutbox(configured, Date.now());
  const evaluate = otherJobs.filter((j) => j.type === 'automation.evaluate');
  otherJobs = [];
  if (evaluate.length) await deliver('oc-local-jobs', evaluate);
  const mail = emailJobs.filter((j) => j.type === 'email.follow_up');
  emailJobs = [];
  if (mail.length) await deliver('oc-local-email', mail);
}

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

const tokens: Record<string, string> = {};
beforeEach(async () => {
  emailJobs = [];
  otherJobs = [];
  sent = [];
  sendImpl = async (m) => {
    sent.push(m);
    return { messageId: `id-${sent.length}` };
  };
  const tables = ['automation_runs', 'automation_rules', 'email_unsubscribe_links', 'email_suppressions', 'email_deliveries', 'notification_preferences', 'outbox', 'audit_log', 'conversation_events', 'messages', 'conversation_read_cursors', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_tokens', 'auth_sessions', 'workspaces', 'users', 'installation'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', ?1, 1, 1)`).bind(ORIGIN),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, 'Acme', 'acme', 1, 1)`).bind(W),
    ...[['boss', 'supervisor'], ['agent', 'agent']].flatMap(([name, role]) => [
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${name}`, `${name}@example.com`, name, hash),
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', 1, 1)`).bind(`mem_${name}`, W, `user_${name}`, role),
    ]),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_a', ?1, 'Site', 'key_a', json_array(?2), 1, 1)`).bind(W, SITE),
  ]);
  for (const name of ['boss', 'agent']) {
    const login = await call('POST', '/api/v1/auth/login', { body: { email: `${name}@example.com`, password: PASSWORD, clientType: 'dashboard' } });
    tokens[name] = ((await login.json()) as { accessToken: string }).accessToken;
  }
});

const rules = `/api/v1/workspaces/${W}/follow-up-rules`;
const addRule = async (inactiveMinutes = 30) => (await (await call('POST', rules, { token: tokens.boss!, body: { name: 'Quiet', inactiveMinutes } })).json()) as { id: string; enabled: boolean; inactiveMinutes: number };

async function visitor(options: { email?: string | null; consent?: boolean } = {}) {
  const session = await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_a' } });
  const token = ((await session.json()) as { accessToken: string }).accessToken;
  const email = options.email === undefined ? 'vera@example.com' : options.email;
  if (email) await call('PATCH', '/api/v1/widget/me', { origin: SITE, token, body: { email, followUpConsent: options.consent ?? true } });
  const created = await call('POST', '/api/v1/widget/conversations', { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'private words' } });
  expect(created.status).toBe(201);
  return { token, id: ((await created.json()) as { id: string }).id };
}

/** As if the last public message had been long ago. */
const goQuiet = (id: string) =>
  env.DB.prepare(`UPDATE conversations SET next_automation_at = ?2, last_visitor_message_at = ?2, last_agent_message_at = CASE WHEN last_agent_message_at IS NULL THEN NULL ELSE ?2 END, next_unanswered_alert_at = NULL WHERE id = ?1`).bind(id, LONG_AGO).run();
const dueAt = async (id: string) => (await env.DB.prepare(`SELECT next_automation_at AS at FROM conversations WHERE id = ?1`).bind(id).first<{ at: number | null }>())!.at;
const reply = (id: string, type = 'text') => call('POST', `/api/v1/workspaces/${W}/conversations/${id}/messages`, { token: tokens.boss!, body: { clientMessageId: crypto.randomUUID(), type, content: 'secret note' } });

describe('rules', () => {
  it('are for supervisors', async () => {
    expect((await call('GET', rules, { token: tokens.agent! })).status).toBe(403);
    expect((await call('POST', rules, { token: tokens.agent!, body: { name: 'x', inactiveMinutes: 30 } })).status).toBe(403);
  });

  it('are stored in the shape of the specification, can change, and can go', async () => {
    const rule = await addRule(45);
    expect(rule).toMatchObject({ enabled: true, inactiveMinutes: 45 });
    const row = await env.DB.prepare(`SELECT trigger_type AS t, conditions_json AS c, actions_json AS a FROM automation_rules`).first<{ t: string; c: string; a: string }>();
    expect(row!.t).toBe('conversation_inactive');
    expect(JSON.parse(row!.c)).toEqual({ inactiveMinutes: 45, visitorEmailExists: true, conversationStatus: 'open', followUpConsent: true });
    expect(JSON.parse(row!.a)).toEqual([{ type: 'send_email', template: 'follow_up' }]);
    const changed = await call('PATCH', `${rules}/${rule.id}`, { token: tokens.boss!, body: { enabled: false, inactiveMinutes: 60 } });
    expect(await changed.json()).toMatchObject({ enabled: false, inactiveMinutes: 60 });
    expect((await call('DELETE', `${rules}/${rule.id}`, { token: tokens.boss! })).status).toBe(204);
    expect((await call('DELETE', `${rules}/${rule.id}`, { token: tokens.boss! })).status).toBe(404);
  });

  it.each([[1], [43_201], [1.5]])('refuse a wait of %s minutes', async (inactiveMinutes) => {
    expect((await call('POST', rules, { token: tokens.boss!, body: { name: 'x', inactiveMinutes } })).status).toBe(400);
  });

  it('take no free-form conditions or actions', async () => {
    expect((await call('POST', rules, { token: tokens.boss!, body: { name: 'x', inactiveMinutes: 30, conditions: { followUpConsent: false } } })).status).toBe(400);
  });

  it('stop at ten', async () => {
    for (let i = 0; i < 10; i += 1) await addRule();
    expect((await call('POST', rules, { token: tokens.boss!, body: { name: 'x', inactiveMinutes: 30 } })).status).toBe(409);
  });
});

describe('the clock', () => {
  it('runs from a public message, to the shortest enabled wait', async () => {
    await addRule(120);
    await addRule(30);
    const { id } = await visitor();
    const at = await dueAt(id);
    expect(at).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(at).toBeLessThan(Date.now() + 31 * 60_000);
  });

  it('does not run with no rule enabled', async () => {
    const rule = await addRule();
    await call('PATCH', `${rules}/${rule.id}`, { token: tokens.boss!, body: { enabled: false } });
    expect(await dueAt((await visitor()).id)).toBeNull();
  });

  it('is left alone by an internal note', async () => {
    await addRule();
    const { id } = await visitor();
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = 777 WHERE id = ?1`).bind(id).run();
    expect((await reply(id, 'internal_note')).status).toBe(201);
    expect(await dueAt(id)).toBe(777);
  });

  it('is not started or moved by anything a browser does', async () => {
    await addRule();
    const { id, token } = await visitor();
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = NULL WHERE id = ?1`).bind(id).run();
    await call('POST', `/api/v1/widget/conversations/${id}/read`, { origin: SITE, token, body: { deliveredSeq: 1, readSeq: 1 } });
    await call('GET', `/api/v1/widget/conversations/${id}/messages`, { origin: SITE, token });
    await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_a' } });
    expect(await dueAt(id)).toBeNull();
    await runSweep();
    expect(sent).toEqual([]);
  });
});

describe('a quiet conversation', () => {
  it('emails the visitor once, with fixed text, an unsubscribe link, and nothing anyone wrote', async () => {
    await addRule();
    const { id } = await visitor();
    await reply(id, 'internal_note');
    await goQuiet(id);
    await runSweep();
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail).toMatchObject({ to: 'vera@example.com', from: { name: 'Acme', email: 'no-reply@mail.example.com' }, subject: 'Do you still need help from Acme?' });
    expect(`${mail.text}${mail.html}`).not.toContain('private words');
    expect(`${mail.text}${mail.html}`).not.toContain('secret note');
    expect(mail.text).toContain(SITE);
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = /<(.+)>/.exec(mail.headers!['List-Unsubscribe']!)![1]!;
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(link.replace(/&/g, '&amp;'));
    expect((await call('POST', link.slice(ORIGIN.length))).status).toBe(200);
    expect((await env.DB.prepare(`SELECT reason FROM email_suppressions`).first<{ reason: string }>())!.reason).toBe('unsubscribe');
  });

  it('holds no address or text in a queue job', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await sweepOutbox(configured, Date.now());
    const evaluate = otherJobs.filter((j) => j.type === 'automation.evaluate');
    await deliver('oc-local-jobs', evaluate);
    const jobs = JSON.stringify([...evaluate, ...emailJobs.filter((j) => j.type === 'email.follow_up')]);
    expect(jobs).toContain('email.follow_up');
    expect(jobs).not.toContain('vera');
    expect(jobs).not.toContain('private words');
  });

  it('sends one, with overlapping sweeps and duplicate deliveries of every job', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await sweepOutbox(configured, Date.now());
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = ?2 WHERE id = ?1`).bind(id, LONG_AGO).run();
    await sweepOutbox(configured, Date.now());
    const evaluate = otherJobs.filter((j) => j.type === 'automation.evaluate');
    expect(evaluate).toHaveLength(2);
    await Promise.all([deliver('oc-local-jobs', evaluate), deliver('oc-local-jobs', evaluate)]);
    const mail = emailJobs.filter((j) => j.type === 'email.follow_up');
    expect(mail.length).toBeGreaterThan(1);
    await Promise.all([deliver('oc-local-email', mail), deliver('oc-local-email', mail)]);
    await deliver('oc-local-email', mail);
    expect(sent).toHaveLength(1);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM automation_runs`).first<{ n: number }>())!.n).toBe(1);
  });

  it('does not send a second one for the same quiet period, and an internal note does not start a new one', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await runSweep();
    await reply(id, 'internal_note');
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = ?2 WHERE id = ?1`).bind(id, LONG_AGO).run();
    await runSweep();
    expect(sent).toHaveLength(1);
  });

  it('sends again after a new message and a new quiet period', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await runSweep();
    expect((await reply(id)).status).toBe(201);
    await goQuiet(id);
    await runSweep();
    expect(sent).toHaveLength(2);
  });

  it('gives each rule its time: a longer one comes back later', async () => {
    await addRule(30);
    await addRule(120);
    const { id } = await visitor();
    const lastHour = Date.now() - 60 * 60_000;
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = ?2, last_visitor_message_at = ?2 WHERE id = ?1`).bind(id, lastHour).run();
    await runSweep();
    expect(sent).toHaveLength(1);
    const later = await dueAt(id);
    expect(later).toBeGreaterThan(Date.now() + 59 * 60_000 - 5_000);
    expect(later).toBeLessThan(Date.now() + 61 * 60_000);
    await env.DB.prepare(`UPDATE conversations SET next_automation_at = ?2, last_visitor_message_at = ?2 WHERE id = ?1`).bind(id, LONG_AGO).run();
    await runSweep();
    expect(sent).toHaveLength(2);
  });

  it('leaves a message sent during the check with its own time', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await sweepOutbox(configured, Date.now());
    expect((await reply(id)).status).toBe(201);
    const fresh = await dueAt(id);
    expect(fresh).toBeGreaterThan(Date.now());
    const evaluate = otherJobs.filter((j) => j.type === 'automation.evaluate');
    await deliver('oc-local-jobs', evaluate);
    expect(await dueAt(id)).toBe(fresh);
    expect(emailJobs.filter((j) => j.type === 'email.follow_up')).toEqual([]);
  });

  it.each([
    ['no address', { email: null }],
    ['no consent', { consent: false }],
  ])('sends nothing with %s, and records why', async (_name, options) => {
    await addRule();
    const { id } = await visitor(options);
    await goQuiet(id);
    await runSweep();
    expect(sent).toEqual([]);
    expect((await env.DB.prepare(`SELECT outcome FROM automation_runs`).first<{ outcome: string }>())!.outcome).toBe('skipped_no_consent');
  });

  it('sends nothing for a resolved conversation', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await env.DB.prepare(`UPDATE conversations SET status = 'resolved' WHERE id = ?1`).bind(id).run();
    await runSweep();
    expect(sent).toEqual([]);
  });

  it('queues nothing with no provider, and clears the time', async () => {
    await addRule();
    const { id } = await visitor();
    await goQuiet(id);
    await sweepOutbox(unconfigured, Date.now());
    expect(otherJobs.filter((j) => j.type === 'automation.evaluate')).toEqual([]);
    expect(await dueAt(id)).toBeNull();
  });
});

describe('just before sending', () => {
  /** Stops with the send job queued, so that the state can change before it runs. */
  async function queuedFollowUp() {
    const rule = await addRule();
    const v = await visitor();
    await goQuiet(v.id);
    await sweepOutbox(configured, Date.now());
    await deliver('oc-local-jobs', otherJobs.filter((j) => j.type === 'automation.evaluate'));
    const jobs = emailJobs.filter((j) => j.type === 'email.follow_up');
    emailJobs = [];
    expect(jobs).toHaveLength(1);
    return { ...v, rule, jobs };
  }

  const cases: [string, (c: Awaited<ReturnType<typeof queuedFollowUp>>) => Promise<unknown>][] = [
    ['the visitor unsubscribed', () => env.DB.prepare(`INSERT INTO email_suppressions (workspace_id, email, reason, created_at) VALUES (?1, 'VERA@example.com', 'unsubscribe', 1)`).bind(W).run()],
    ['consent was withdrawn', (c) => call('PATCH', '/api/v1/widget/me', { origin: SITE, token: c.token, body: { followUpConsent: false } })],
    ['the address changed', (c) => call('PATCH', '/api/v1/widget/me', { origin: SITE, token: c.token, body: { email: 'other@example.com' } })],
    ['someone replied', (c) => reply(c.id)],
    ['the visitor wrote', (c) => call('POST', `/api/v1/widget/conversations/${c.id}/messages`, { origin: SITE, token: c.token, body: { clientMessageId: crypto.randomUUID(), content: 'back' } })],
    ['it was resolved', (c) => env.DB.prepare(`UPDATE conversations SET status = 'resolved' WHERE id = ?1`).bind(c.id).run()],
    ['the rule was turned off', (c) => call('PATCH', `${rules}/${c.rule.id}`, { token: tokens.boss!, body: { enabled: false } })],
    ['the rule was deleted', (c) => call('DELETE', `${rules}/${c.rule.id}`, { token: tokens.boss! })],
  ];

  it.each(cases)('sends nothing if %s', async (_name, change) => {
    const queued = await queuedFollowUp();
    await change(queued);
    const outcomes = await deliver('oc-local-email', queued.jobs);
    expect(outcomes[0]!.acked).toBe(true);
    expect(sent).toEqual([]);
  });

  it('a failed send retries, and then sends once', async () => {
    const { jobs } = await queuedFollowUp();
    sendImpl = () => Promise.reject(new EmailSendError(503));
    expect((await deliver('oc-local-email', jobs))[0]!.acked).toBe(false);
    sendImpl = async (m) => {
      sent.push(m);
      return { messageId: 'later' };
    };
    expect((await deliver('oc-local-email', jobs))[0]!.acked).toBe(true);
    await deliver('oc-local-email', jobs);
    expect(sent).toHaveLength(1);
  });

  it('an email outage leaves messaging alone', async () => {
    const { jobs, id, token } = await queuedFollowUp();
    sendImpl = () => Promise.reject(new EmailSendError(503));
    await deliver('oc-local-email', jobs);
    expect((await reply(id)).status).toBe(201);
    expect((await call('POST', `/api/v1/widget/conversations/${id}/messages`, { origin: SITE, token, body: { clientMessageId: crypto.randomUUID(), content: 'still works' } })).status).toBe(201);
  });
});
