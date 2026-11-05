import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { newUnsubscribeHeaders } from '@openchat/core';
import { openDatabase } from '@openchat/database';
import { EmailSendError } from '@openchat/email';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleQueue } from '../src/background';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = 'work_a';

let counter = 0;
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string; raw?: string } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `198.51.100.${++counter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.raw === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.raw === undefined ? {} : { body: options.raw }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

const tokens: Record<string, string> = {};
beforeEach(async () => {
  const tables = ['email_unsubscribe_links', 'email_suppressions', 'email_deliveries', 'outbox', 'audit_log', 'conversation_events', 'messages', 'conversation_read_cursors', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_tokens', 'auth_sessions', 'workspaces', 'users', 'installation'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', ?1, 1, 1)`).bind(ORIGIN),
    ...['work_a', 'work_b'].map((id) => env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?1, ?1, ?1, 1, 1)`).bind(id)),
    ...[['boss', 'supervisor'], ['agent', 'agent']].flatMap(([name, role]) => [
      env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)`).bind(`user_${name}`, `${name}@example.com`, name, hash),
      env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'active', 1, 1)`).bind(`mem_${name}`, W, `user_${name}`, role),
    ]),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_a', ?1, 'Site', 'key_a', json_array(?2), 1, 1)`).bind(W, SITE),
    env.DB.prepare(`INSERT INTO contacts (id, workspace_id, email, follow_up_consent_at, follow_up_consent_source, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('c_a', 'work_a', 'vera@example.com', 5, 'widget', 1, 1, 1, 1)`),
    env.DB.prepare(`INSERT INTO contacts (id, workspace_id, email, follow_up_consent_at, follow_up_consent_source, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('c_b', 'work_b', 'vera@example.com', 5, 'widget', 1, 1, 1, 1)`),
  ]);
  for (const name of ['boss', 'agent']) {
    const login = await call('POST', '/api/v1/auth/login', { body: { email: `${name}@example.com`, password: PASSWORD, clientType: 'dashboard' } });
    tokens[name] = ((await login.json()) as { accessToken: string }).accessToken;
  }
});

const link = async (email = 'vera@example.com', workspaceId = W) => newUnsubscribeHeaders(openDatabase(env.DB), { workspaceId, email, publicBaseUrl: `${ORIGIN}/` });
const pathOf = (url: string) => url.slice(ORIGIN.length);
const suppressed = async () => (await env.DB.prepare(`SELECT workspace_id AS w, email, reason FROM email_suppressions ORDER BY 1, 2`).all()).results;
const consent = async (id: string) => (await env.DB.prepare(`SELECT follow_up_consent_at AS at, follow_up_consent_source AS source FROM contacts WHERE id = ?1`).bind(id).first<{ at: number | null; source: string | null }>())!;

describe('an unsubscribe link', () => {
  it('holds no address, and the database keeps only a hash of its token', async () => {
    const { url, headers } = await link();
    expect(url).not.toContain('vera');
    expect(headers).toEqual({ 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    const token = new URL(url).searchParams.get('token')!;
    const row = await env.DB.prepare(`SELECT token_hash AS h FROM email_unsubscribe_links`).first<{ h: string }>();
    expect(row!.h).not.toBe(token);
  });

  it('changes nothing when opened, because mail scanners open links', async () => {
    const { url } = await link();
    const page = await call('GET', pathOf(url));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<form method="post"');
    expect(html).not.toContain('vera');
    expect(await suppressed()).toEqual([]);
    expect((await consent('c_a')).at).toBe(5);
  });

  it('unsubscribes when confirmed, in this workspace only, with no sign-in', async () => {
    const { url } = await link();
    expect((await call('POST', pathOf(url))).status).toBe(200);
    expect(await suppressed()).toEqual([{ w: W, email: 'vera@example.com', reason: 'unsubscribe' }]);
    expect(await consent('c_a')).toEqual({ at: null, source: null });
    expect((await consent('c_b')).at).toBe(5);
  });

  it('takes a one-click press from a mail app, and repeating it is harmless', async () => {
    const { url } = await link();
    expect((await call('POST', pathOf(url), { raw: 'List-Unsubscribe=One-Click' })).status).toBe(200);
    expect((await call('POST', pathOf(url), { raw: 'List-Unsubscribe=One-Click' })).status).toBe(200);
    expect(await suppressed()).toHaveLength(1);
  });

  it('finds the address whatever its capitals', async () => {
    const { url } = await link('VERA@example.com');
    await call('POST', pathOf(url));
    expect((await consent('c_a')).at).toBeNull();
  });

  it('turns an address added by hand into an unsubscribe', async () => {
    expect((await call('POST', `/api/v1/workspaces/${W}/email-suppressions`, { token: tokens.boss!, body: { email: 'vera@example.com' } })).status).toBe(204);
    const { url } = await link();
    await call('POST', pathOf(url));
    expect((await suppressed())[0]).toMatchObject({ reason: 'unsubscribe' });
  });

  it.each([['/api/v1/unsubscribe'], ['/api/v1/unsubscribe?token=wrong']])('answers 404 for %s, and does nothing', async (path) => {
    expect((await call('GET', path)).status).toBe(404);
    expect((await call('POST', path)).status).toBe(404);
    expect(await suppressed()).toEqual([]);
  });
});

describe('the list', () => {
  const path = `/api/v1/workspaces/${W}/email-suppressions`;
  const add = (email: string) => call('POST', path, { token: tokens.boss!, body: { email } });

  it('adds, lists a page at a time, and removes what was added by hand', async () => {
    await add('a@example.com');
    await add('b@example.com');
    await add('a@example.com');
    const first = (await (await call('GET', `${path}?limit=1`, { token: tokens.boss! })).json()) as { data: { email: string }[]; nextCursor: string };
    expect(first.data.map((r) => r.email)).toEqual(['a@example.com']);
    const second = (await (await call('GET', `${path}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, { token: tokens.boss! })).json()) as { data: { email: string }[]; nextCursor: null };
    expect(second.data.map((r) => r.email)).toEqual(['b@example.com']);
    expect(second.nextCursor).toBeNull();
    expect((await call('POST', `${path}/remove`, { token: tokens.boss!, body: { email: 'a@example.com' } })).status).toBe(204);
    expect(await suppressed()).toHaveLength(1);
  });

  it('refuses to remove someone who unsubscribed, and adding by hand cannot unlock them', async () => {
    const { url } = await link();
    await call('POST', pathOf(url));
    await add('vera@example.com');
    expect((await call('POST', `${path}/remove`, { token: tokens.boss!, body: { email: 'VERA@example.com' } })).status).toBe(409);
    expect(await suppressed()).toHaveLength(1);
  });

  it('is for supervisors', async () => {
    expect((await call('GET', path, { token: tokens.agent! })).status).toBe(403);
    expect((await call('POST', path, { token: tokens.agent!, body: { email: 'a@example.com' } })).status).toBe(403);
    expect((await call('POST', `${path}/remove`, { token: tokens.agent!, body: { email: 'a@example.com' } })).status).toBe(403);
  });
});

describe('consent in the widget', () => {
  async function visitor() {
    const session = await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_a' } });
    return ((await session.json()) as { accessToken: string }).accessToken;
  }
  const save = (token: string, body: unknown) => call('PATCH', '/api/v1/widget/me', { origin: SITE, token, body });
  const mine = async () => (await env.DB.prepare(`SELECT email, follow_up_consent_at AS at, follow_up_consent_source AS source FROM contacts WHERE id NOT IN ('c_a', 'c_b')`).first<{ email: string; at: number | null; source: string | null }>())!;

  it('records nothing for an unticked box', async () => {
    await save(await visitor(), { email: 'v@example.com', followUpConsent: false });
    expect(await mine()).toEqual({ email: 'v@example.com', at: null, source: null });
  });

  it('records the time and source for a ticked box', async () => {
    await save(await visitor(), { email: 'v@example.com', followUpConsent: true });
    const row = await mine();
    expect(row.at).toBeGreaterThan(0);
    expect(row.source).toBe('widget');
  });

  it('does not carry consent to a new address', async () => {
    const token = await visitor();
    await save(token, { email: 'v@example.com', followUpConsent: true });
    await save(token, { email: 'other@example.com' });
    expect(await mine()).toEqual({ email: 'other@example.com', at: null, source: null });
  });

  it('keeps consent when the address is the same, whatever its capitals', async () => {
    const token = await visitor();
    await save(token, { email: 'v@example.com', followUpConsent: true });
    await save(token, { email: 'V@example.com' });
    expect((await mine()).at).toBeGreaterThan(0);
  });

  it('a member changing the address clears consent, and correcting only its capitals does not', async () => {
    const patch = (email: string) => call('PATCH', `/api/v1/workspaces/${W}/contacts/c_a`, { token: tokens.boss!, body: { email } });
    expect((await patch('VERA@example.com')).status).toBe(200);
    expect((await consent('c_a')).at).toBe(5);
    await patch('new@example.com');
    expect(await consent('c_a')).toEqual({ at: null, source: null });
  });

  it('ticking again does not lift an unsubscribe, because an address here is unverified', async () => {
    const token = await visitor();
    await save(token, { email: 'vera@example.com' });
    const { url } = await link();
    await call('POST', pathOf(url));
    await save(token, { email: 'vera@example.com', followUpConsent: true });
    expect(await suppressed()).toHaveLength(1);
  });
});

it('records a send Cloudflare refuses for a past bounce or complaint, and does not retry', async () => {
  await env.DB.prepare(`INSERT INTO notification_preferences (workspace_id, member_id, event_type, channel, enabled, updated_at) VALUES (?1, 'mem_boss', 'new_conversation', 'email', 1, 1)`).bind(W).run();
  await env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at) VALUES ('conv_x', ?1, 'site_a', 'c_a', 1, 1, 1)`).bind(W).run();
  const body = { v: 1, type: 'email.send', id: 'job_x', idempotencyKey: 'k', workspaceId: W, occurredAt: new Date().toISOString(), notAfter: new Date(Date.now() + 60_000).toISOString(), payload: { kind: 'new_conversation', conversationId: 'conv_x', eventId: 'e1', memberId: 'mem_boss' } };
  let acked = false;
  let retried = false;
  const messages = [{ id: 'x', body, attempts: 1, ack: () => { acked = true; }, retry: () => { retried = true; } }];
  const provider = { send: () => Promise.reject(new EmailSendError(null, 'E_RECIPIENT_SUPPRESSED')) };
  await handleQueue({ queue: 'oc-local-email', messages } as unknown as MessageBatch, { ...env, EMAIL_PROVIDER: 'console' } as never, { email: provider });
  expect({ acked, retried }).toEqual({ acked: true, retried: false });
  expect((await env.DB.prepare(`SELECT status FROM email_deliveries`).first<{ status: string }>())!.status).toBe('suppressed');
});
