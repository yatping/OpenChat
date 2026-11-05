import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const SECRET = 'test-turnstile-secret';
const configured = { ...env, TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: 'test-site-key' } as unknown as Env;
const unconfigured = env as unknown as Env;

let counter = 0;
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string; env?: Env } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `203.0.113.${++counter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.env ?? configured,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

let hash = '';
/** What Cloudflare is asked, and how it answers. Only siteverify is replaced. */
let siteverify: (body: { secret: string; response: string; remoteip?: string }) => Response | Promise<Response>;
const asked: { secret: string; response: string; remoteip?: string }[] = [];
const verdict = (success: boolean, codes: string[] = []) => () => new Response(JSON.stringify({ success, 'error-codes': codes }), { status: success ? 200 : 400 });

const visitors = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM visitors`).first<{ n: number }>())!.n;
const startSession = (body: Record<string, unknown>, target?: Env) => call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_checked', ...body }, ...(target ? { env: target } : {}) });

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  asked.length = 0;
  siteverify = verdict(true);
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/turnstile/v0/siteverify')) {
      const body = JSON.parse(String(init?.body)) as { secret: string; response: string };
      asked.push(body);
      return siteverify(body);
    }
    return real(input, init);
  });
  await env.DB.batch(['outbox', 'audit_log', 'conversation_read_cursors', 'conversation_events', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('user_a', 'agent@example.com', 'Ana', ?1, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_a', 'work_1', 'user_a', 'supervisor', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at) VALUES ('site_c', 'work_1', 'Checked', 'key_checked', ?1, '{"requireTurnstile":true}', 1, 1), ('site_o', 'work_1', 'Open', 'key_open', ?1, '{}', 1, 1)`).bind(JSON.stringify([SITE])),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('starting a new visitor on a website that requires it', () => {
  it('needs a token, and makes nothing without one', async () => {
    const response = await startSession({});
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('turnstile_required');
    expect(await visitors()).toBe(0);
    expect(asked).toEqual([]);
  });

  it('asks Cloudflare, with the secret, and starts the visitor if it says yes', async () => {
    const response = await startSession({ turnstileToken: 'good-token' });
    expect(response.status).toBe(200);
    expect(await visitors()).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ secret: SECRET, response: 'good-token' });
    expect(asked[0]!.remoteip).toMatch(/^203\.0\.113\./);
    expect(await response.clone().text()).not.toContain(SECRET);
  });

  it('refuses a token Cloudflare refuses', async () => {
    siteverify = verdict(false, ['timeout-or-duplicate']);
    const response = await startSession({ turnstileToken: 'used-token' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('turnstile_failed');
    expect(await visitors()).toBe(0);
  });

  it.each([
    ['the network fails', () => Promise.reject(new Error('down'))],
    ['it answers with something else', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['it reports its own error', verdict(false, ['internal-error'])],
    ['the secret is wrong', verdict(false, ['invalid-input-secret'])],
  ])('keeps new visitors out when %s, and says it is not their fault', async (_name, answer) => {
    siteverify = answer;
    const response = await startSession({ turnstileToken: 'any-token' });
    expect(response.status).toBe(503);
    expect(await visitors()).toBe(0);
  });

  it('keeps new visitors out if the keys have since been removed', async () => {
    const response = await startSession({ turnstileToken: 'any-token' }, unconfigured);
    expect(response.status).toBe(503);
    expect(await visitors()).toBe(0);
  });
});

describe('a visitor it already knows', () => {
  const known = async () => ((await (await startSession({ turnstileToken: 'first-token' })).json()) as { refreshToken: string; visitorId: string });

  it('resumes with no check, even during an outage', async () => {
    const { refreshToken, visitorId } = await known();
    asked.length = 0;
    siteverify = () => Promise.reject(new Error('down'));
    const response = await startSession({ refreshToken });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { visitorId: string }).visitorId).toBe(visitorId);
    expect(asked).toEqual([]);
  });

  it('an unknown refresh token is a new visitor, so it needs the check', async () => {
    expect((await startSession({ refreshToken: 'made-up-token-value' })).status).toBe(403);
    expect(await visitors()).toBe(0);
  });
});

describe('a website that does not require it', () => {
  it('never asks, and never mentions a site key', async () => {
    const session = await call('POST', '/api/v1/widget/sessions', { origin: SITE, body: { websiteKey: 'key_open' } });
    expect(session.status).toBe(200);
    expect(asked).toEqual([]);
    const bootstrap = await call('GET', '/api/v1/widget/bootstrap?websiteKey=key_open', { origin: SITE });
    expect(((await bootstrap.json()) as { turnstileSiteKey?: string }).turnstileSiteKey).toBeUndefined();
  });
});

describe('settings', () => {
  it('gives the site key, and never the secret, to a website that requires it', async () => {
    const bootstrap = await call('GET', '/api/v1/widget/bootstrap?websiteKey=key_checked', { origin: SITE });
    const text = await bootstrap.text();
    expect(JSON.parse(text)).toMatchObject({ turnstileSiteKey: 'test-site-key', settings: { requireTurnstile: true } });
    expect(text).not.toContain(SECRET);
  });

  it('will not turn it on where it could not work, which would shut out every new visitor', async () => {
    const login = await call('POST', '/api/v1/auth/login', { body: { email: 'agent@example.com', password: PASSWORD, clientType: 'mobile' } });
    const { accessToken: token } = (await login.json()) as { accessToken: string };
    await env.DB.prepare(`UPDATE users SET is_installation_admin = 1 WHERE id = 'user_a'`).run();
    const path = '/api/v1/admin/workspaces/work_1/websites/site_o';
    const on = { settings: { requireTurnstile: true } };
    const refused = await call('PATCH', path, { token, body: on, env: unconfigured });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('turnstile_not_configured');
    expect((await call('PATCH', path, { token, body: on })).status).toBe(200);
    const created = { name: 'New', allowedOrigins: [SITE], ...on };
    expect((await call('POST', '/api/v1/admin/workspaces/work_1/websites', { token, body: created, env: unconfigured })).status).toBe(400);
    expect((await call('POST', '/api/v1/admin/workspaces/work_1/websites', { token, body: created })).status).toBe(201);
  });
});
