import { createExecutionContext, createMessageBatch, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { hashOpaqueToken, hashPassword, type ScryptParams } from '@openchat/auth';
import { limitKey, LIMITS, PASSWORD_RESET_JOB } from '@openchat/core';
import type { EmailMessage } from '@openchat/email';
import type { JobEnvelope } from '@openchat/shared';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from '../src/background';
import type { Env } from '../src/env';
import worker from '../src/index';

const self = (exports as unknown as { default: Fetcher }).default;
const ORIGIN = 'https://example.com';
const PASSWORD = 'correct horse battery';

// Durable Object storage outlives each test, so each test has its own IP address and email addresses.
let run = 0;
let ip = '';
let email = '';
const nextEmail = () => `user${Date.now()}-${++run}@example.com`;

let storedHash = '';
beforeAll(async () => {
  storedHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  run += 1;
  ip = `203.0.113.${run}`;
  email = nextEmail();
  await env.DB.batch(
    ['workspace_members', 'workspaces', 'auth_tokens', 'auth_sessions', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare(
    `INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test installation', '${ORIGIN}', 1, 1)`,
  ).run();
});

async function createUser(address = email, passwordHash = storedHash, id = `usr_${crypto.randomUUID()}`): Promise<string> {
  await env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?1, ?2, 'Test <b>User</b>', ?3, 1, 1)`)
    .bind(id, address, passwordHash)
    .run();
  return id;
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  self.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const login = (address = email, password = PASSWORD, clientType: 'mobile' | 'dashboard' = 'mobile') =>
  post('/api/v1/auth/login', { email: address, password, clientType });

interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
}
const mobileLogin = async (address = email) => {
  const response = await login(address);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens & { refreshToken: string };
};
const me = (accessToken: string) => self.fetch(`${ORIGIN}/api/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } });
const refresh = (refreshToken: string) => post('/api/v1/auth/refresh', { refreshToken });
const cookieOf = (response: Response) => response.headers.get('set-cookie') ?? '';
const cookieValue = (response: Response) => /oc_refresh=([^;]*)/.exec(cookieOf(response))?.[1] ?? '';
const withoutRequestId = async (response: Response) => {
  const body = (await response.json()) as Record<string, unknown>;
  delete body.requestId;
  return body;
};

describe('login', () => {
  it('gives a mobile client its refresh token directly, and no cookie', async () => {
    await createUser();
    const response = await login();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Tokens;
    expect(body.refreshToken).toMatch(/.{32,}/);
    expect(Date.parse(body.accessTokenExpiresAt)).toBeGreaterThan(Date.now());
    expect(cookieOf(response)).toBe('');
    expect((await me(body.accessToken)).status).toBe(200);
  });

  it('gives a dashboard client a cookie that scripts cannot read, and no refresh token in the body', async () => {
    await createUser();
    const response = await login(email, PASSWORD, 'dashboard');
    expect(((await response.json()) as Tokens).refreshToken).toBeUndefined();
    const cookie = cookieOf(response);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/v1/auth']) expect(cookie).toContain(attribute);
  });

  it('stores only a hash of the refresh token', async () => {
    await createUser();
    const { refreshToken } = await mobileLogin();
    const row = await env.DB.prepare('SELECT refresh_token_hash AS hash FROM auth_sessions').first<{ hash: string }>();
    expect(row!.hash).toBe(await hashOpaqueToken(refreshToken));
    expect(row!.hash).not.toBe(refreshToken);
  });

  it('answers the same for a wrong password, an unknown account, a disabled account, and a placeholder hash', async () => {
    await createUser();
    const disabled = nextEmail();
    await createUser(disabled);
    await env.DB.prepare('UPDATE users SET disabled_at = 1 WHERE email = ?1').bind(disabled).run();
    const placeholder = nextEmail();
    await createUser(placeholder, '!');

    const answers = [await login(email, 'wrong password!'), await login(nextEmail()), await login(disabled), await login(placeholder)];
    for (const answer of answers) expect(answer.status).toBe(401);
    const bodies = await Promise.all(answers.map(withoutRequestId));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ code: 'invalid_credentials' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions').first('n')).toBe(0);
  });

  it('matches an email address whatever its case', async () => {
    await createUser();
    expect((await login(email.toUpperCase())).status).toBe(200);
  });

  it('upgrades a hash made with older parameters, and the password still works', async () => {
    const weaker: ScryptParams = { N: 2 ** 12, r: 8, p: 1 };
    const id = await createUser(email, await hashPassword(PASSWORD, weaker));
    expect((await login()).status).toBe(200);
    const row = await env.DB.prepare('SELECT password_hash AS h FROM users WHERE id = ?1').bind(id).first<{ h: string }>();
    expect(row!.h.startsWith('scrypt$32768$8$3$')).toBe(true);
    expect((await login()).status).toBe(200);
  });

  it('rejects unknown fields and an oversized password before any hashing', async () => {
    expect((await post('/api/v1/auth/login', { email, password: PASSWORD, clientType: 'mobile', role: 'owner' })).status).toBe(400);
    expect((await post('/api/v1/auth/login', { email, password: 'x'.repeat(1025), clientType: 'mobile' })).status).toBe(400);
  });
});

describe('throttling', () => {
  it('limits attempts per account, identically for an account that does not exist', async () => {
    await createUser();
    for (const address of [email, nextEmail()]) {
      for (let i = 0; i < LIMITS.loginAccount.limit; i++) expect((await login(address, 'wrong password!')).status).toBe(401);
      const blocked = await login(address, 'wrong password!');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(blocked.headers.get('content-type')).toBe('application/problem+json');
    }
    // The right password does not get through while limited.
    expect((await login()).status).toBe(429);
  });

  it('forgets failed attempts after a successful login', async () => {
    await createUser();
    for (let i = 0; i < LIMITS.loginAccount.limit - 1; i++) await login(email, 'wrong password!');
    expect((await login()).status).toBe(200);
    for (let i = 0; i < LIMITS.loginAccount.limit - 1; i++) await login(email, 'wrong password!');
    expect((await login()).status).toBe(200);
  });

  it('limits attempts per IP address across accounts', async () => {
    const guard = env.AUTH_GUARD.getByName(await limitKey('login-ip', ip));
    for (let i = 0; i < LIMITS.loginIp.limit; i++) await guard.consume(LIMITS.loginIp.limit, LIMITS.loginIp.windowSeconds);
    expect((await login(nextEmail())).status).toBe(429);
  });

  it('opens a new window once the old one ends, and an alarm clears idle keys', async () => {
    const stub = env.AUTH_GUARD.getByName(`window-${crypto.randomUUID()}`);
    expect(await stub.consume(1, 60)).toMatchObject({ allowed: true });
    expect(await stub.consume(1, 60)).toMatchObject({ allowed: false });
    await stub.reset();
    expect(await stub.consume(1, 60)).toMatchObject({ allowed: true });
  });
});

describe('refresh rotation', () => {
  it('rotates, and the new pair works', async () => {
    await createUser();
    const first = await mobileLogin();
    const response = await refresh(first.refreshToken);
    expect(response.status).toBe(200);
    const second = (await response.json()) as Tokens & { refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await me(second.accessToken)).status).toBe(200);
    expect((await refresh(second.refreshToken)).status).toBe(200);
  });

  it('revokes the session when an old token is reused, including the token that replaced it', async () => {
    await createUser();
    const first = await mobileLogin();
    const second = (await (await refresh(first.refreshToken)).json()) as Tokens & { refreshToken: string };

    const reuse = await refresh(first.refreshToken);
    expect(reuse.status).toBe(401);
    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await me(second.accessToken)).status).toBe(401);
  });

  it('lets exactly one of two concurrent refreshes win, and treats the other as reuse', async () => {
    await createUser();
    const { refreshToken } = await mobileLogin();
    const statuses = (await Promise.all([refresh(refreshToken), refresh(refreshToken)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NOT NULL').first('n')).toBe(1);
  });

  it('answers the same for reuse and for a token never issued', async () => {
    await createUser();
    const first = await mobileLogin();
    await refresh(first.refreshToken);
    const bodies = await Promise.all([refresh(first.refreshToken), refresh('never-issued')].map(async (r) => withoutRequestId(await r)));
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it('does not revoke other sessions of the same user', async () => {
    await createUser();
    const stolen = await mobileLogin();
    const other = await mobileLogin();
    await refresh(stolen.refreshToken);
    await refresh(stolen.refreshToken);
    expect((await me(other.accessToken)).status).toBe(200);
  });

  it('refuses an expired session and a disabled user', async () => {
    await createUser();
    const expired = await mobileLogin();
    await env.DB.prepare('UPDATE auth_sessions SET expires_at = 1').run();
    expect((await refresh(expired.refreshToken)).status).toBe(401);
    expect((await me(expired.accessToken)).status).toBe(401);

    const active = await mobileLogin();
    await env.DB.prepare('UPDATE users SET disabled_at = 1').run();
    expect((await refresh(active.refreshToken)).status).toBe(401);
    expect((await me(active.accessToken)).status).toBe(401);
  });

  it('extends the session when it rotates', async () => {
    await createUser();
    const { refreshToken } = await mobileLogin();
    await env.DB.prepare(`UPDATE auth_sessions SET expires_at = expires_at - 1000000`).run();
    const before = await env.DB.prepare('SELECT expires_at AS e FROM auth_sessions').first<{ e: number }>();
    await refresh(refreshToken);
    const after = await env.DB.prepare('SELECT expires_at AS e FROM auth_sessions').first<{ e: number }>();
    expect(after!.e).toBeGreaterThan(before!.e);
  });

  describe('with the dashboard cookie', () => {
    const cookieRefresh = (value: string, origin?: string) =>
      post('/api/v1/auth/refresh', undefined, { cookie: `oc_refresh=${value}`, ...(origin ? { origin } : {}) });

    it('rotates from our own origin, with no body, and replaces the cookie', async () => {
      await createUser();
      const value = cookieValue(await login(email, PASSWORD, 'dashboard'));
      const response = await cookieRefresh(value, ORIGIN);
      expect(response.status).toBe(200);
      expect(((await response.json()) as Tokens).refreshToken).toBeUndefined();
      expect(cookieValue(response)).not.toBe(value);
      expect(cookieValue(response)).not.toBe('');
    });

    it('refuses another origin or a missing one, without spending the token', async () => {
      await createUser();
      const value = cookieValue(await login(email, PASSWORD, 'dashboard'));
      expect((await cookieRefresh(value, 'https://evil.example')).status).toBe(403);
      expect((await cookieRefresh(value)).status).toBe(403);
      expect((await cookieRefresh(value, ORIGIN)).status).toBe(200);
    });

    it('clears the cookie when it fails', async () => {
      const response = await cookieRefresh('never-issued', ORIGIN);
      expect(response.status).toBe(401);
      expect(cookieOf(response)).toMatch(/oc_refresh=;/);
    });

    it('leaves the cookie alone when a body token fails', async () => {
      const response = await post('/api/v1/auth/refresh', { refreshToken: 'never-issued' }, { cookie: 'oc_refresh=kept' });
      expect(response.status).toBe(401);
      expect(cookieOf(response)).toBe('');
    });
  });

  it('asks for sign-in when there is no token at all', async () => {
    expect((await post('/api/v1/auth/refresh')).status).toBe(401);
  });
});

describe('access', () => {
  it('rejects a missing, malformed, or tampered token', async () => {
    await createUser();
    const { accessToken } = await mobileLogin();
    expect((await self.fetch(`${ORIGIN}/api/v1/me`)).status).toBe(401);
    expect((await me('not.a.jwt')).status).toBe(401);
    const [header, payload, signature] = accessToken.split('.') as [string, string, string];
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))), sub: 'usr_other' }))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    expect((await me(`${header}.${forged}.${signature}`)).status).toBe(401);
  });

  it('logout ends the session at once, for both tokens', async () => {
    await createUser();
    const tokens = await mobileLogin();
    const response = await post('/api/v1/auth/logout', undefined, { authorization: `Bearer ${tokens.accessToken}` });
    expect(response.status).toBe(204);
    expect((await me(tokens.accessToken)).status).toBe(401);
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it('lists only the caller’s own active memberships', async () => {
    const mine = await createUser();
    const other = await createUser(nextEmail());
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('ws_a','Alpha','alpha',1,1), ('ws_b','Beta','beta',2,2), ('ws_c','Gamma','gamma',3,3)`),
      env.DB.prepare(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
         ('mem_a','ws_a',?1,'owner','active',1,1), ('mem_b','ws_b',?2,'owner','active',1,1), ('mem_c','ws_c',?1,'agent','suspended',1,1)`,
      ).bind(mine, other),
    ]);
    const { accessToken } = await mobileLogin();
    const body = (await (await me(accessToken)).json()) as { email: string; memberships: { memberId: string; role: string; workspace: { slug: string; createdAt: string } }[] };
    expect(body.email).toBe(email);
    expect(body.memberships).toEqual([
      { memberId: 'mem_a', role: 'owner', workspace: { id: 'ws_a', name: 'Alpha', slug: 'alpha', createdAt: new Date(1).toISOString() } },
    ]);
  });

  it('reports 503 when the signing key is missing', async () => {
    const broken = { ...env, AUTH_SIGNING_KEY: undefined } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/me`, { headers: { authorization: 'Bearer x' } }), broken, ctx);
    expect(response.status).toBe(503);
  });
});

describe('password reset', () => {
  /** Runs the request through waitUntil and captures what is queued, without the real consumer. */
  async function requestReset(address: string, requestIp = ip) {
    const sent: JobEnvelope[] = [];
    const testEnv = { ...env, EMAIL_QUEUE: { send: async (job: JobEnvelope) => void sent.push(job) } } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': requestIp },
        body: JSON.stringify({ email: address }),
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { response, sent };
  }

  /** Delivers one job to the consumer with a fake provider, and returns the token in the email. */
  async function deliver(job: JobEnvelope) {
    const emails: EmailMessage[] = [];
    const batch = createMessageBatch('oc-email', [{ id: job.id, timestamp: new Date(), attempts: 1, body: job }]);
    await handleQueue(batch as never, env as unknown as Env, {
      email: { send: async (message) => (emails.push(message), { messageId: 'test' }) },
    });
    const token = emails[0] ? /#token=([\w-]+)/.exec(emails[0].text!)![1]! : '';
    return { emails, token };
  }

  async function issueResetToken(address = email) {
    const { sent } = await requestReset(address);
    return (await deliver(sent[0]!)).token;
  }

  const confirm = (token: string, password = 'a brand new password') => post('/api/v1/auth/password-reset/confirm', { token, password });

  it('answers 202 identically for known and unknown accounts, and queues only for a known one', async () => {
    const id = await createUser();
    const known = await requestReset(email);
    const unknown = await requestReset(nextEmail());
    expect(known.response.status).toBe(202);
    expect(unknown.response.status).toBe(202);
    expect(await known.response.text()).toBe(await unknown.response.text());
    expect(unknown.sent).toEqual([]);
    expect(known.sent).toHaveLength(1);
    expect(known.sent[0]).toMatchObject({ type: PASSWORD_RESET_JOB, payload: { userId: id }, workspaceId: null });
  });

  it('keeps tokens and addresses out of the job, which can end up in a dead-letter record', async () => {
    await createUser();
    const { sent } = await requestReset(email);
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain('token"');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens').first('n')).toBe(0);
  });

  it('does not queue for a disabled account', async () => {
    await createUser();
    await env.DB.prepare('UPDATE users SET disabled_at = 1').run();
    expect((await requestReset(email)).sent).toEqual([]);
  });

  it('stops queueing silently past the per-address limit, so that nobody can be mail-bombed', async () => {
    await createUser();
    for (let i = 0; i < LIMITS.resetEmail.limit; i++) expect((await requestReset(email)).sent).toHaveLength(1);
    const blocked = await requestReset(email);
    expect(blocked.response.status).toBe(202);
    expect(blocked.sent).toEqual([]);
  });

  it('sends a link holding a token stored only as a hash, in the fragment, with the name escaped', async () => {
    await createUser();
    const { sent } = await requestReset(email);
    const { emails, token } = await deliver(sent[0]!);
    expect(emails[0]!.to).toBe(email);
    expect(emails[0]!.text).toContain(`${ORIGIN}/reset-password#token=${token}`);
    expect(emails[0]!.html).toContain('Test &lt;b&gt;User&lt;/b&gt;');
    const row = await env.DB.prepare('SELECT token_hash AS h FROM auth_tokens').first<{ h: string }>();
    expect(row!.h).toBe(await hashOpaqueToken(token));
  });

  it('changes the password and ends every session', async () => {
    await createUser();
    const session = await mobileLogin();
    const token = await issueResetToken();

    expect((await confirm(token)).status).toBe(204);

    expect((await login()).status).toBe(401);
    expect((await login(email, 'a brand new password')).status).toBe(200);
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });

  it('works once, and other outstanding links die with it', async () => {
    await createUser();
    const first = await issueResetToken();
    const second = await issueResetToken();
    expect((await confirm(first)).status).toBe(204);
    expect((await confirm(first, 'another new password')).status).toBe(400);
    expect((await confirm(second, 'another new password')).status).toBe(400);
    expect((await login(email, 'a brand new password')).status).toBe(200);
  });

  it('lets exactly one of two concurrent confirmations win', async () => {
    await createUser();
    const token = await issueResetToken();
    const statuses = (await Promise.all([confirm(token, 'first new password'), confirm(token, 'second new password')])).map((r) => r.status).sort();
    expect(statuses).toEqual([204, 400]);
  });

  it('refuses an expired token, an unknown token, and a token for another purpose', async () => {
    const id = await createUser();
    const expired = await issueResetToken();
    await env.DB.prepare('UPDATE auth_tokens SET expires_at = 1').run();
    expect((await confirm(expired)).status).toBe(400);
    expect((await confirm('never-issued')).status).toBe(400);

    await env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, 'email_verification', ?3)`)
      .bind(await hashOpaqueToken('verify-token'), id, Date.now() + 60_000)
      .run();
    expect((await confirm('verify-token')).status).toBe(400);
    expect((await login()).status).toBe(200);
  });

  it('refuses a short password', async () => {
    await createUser();
    expect((await confirm(await issueResetToken(), 'short')).status).toBe(400);
  });

  it('limits confirmation guesses per IP address', async () => {
    for (let i = 0; i < LIMITS.confirmIp.limit; i++) expect((await confirm(`guess-${i}`)).status).toBe(400);
    expect((await confirm('another-guess')).status).toBe(429);
  });

  it('retries instead of dropping the email when no provider is configured', async () => {
    await createUser();
    const { sent } = await requestReset(email);
    const batch = createMessageBatch('oc-email', [{ id: 'm1', timestamp: new Date(), attempts: 1, body: sent[0]! }]);
    const retry = vi.spyOn(batch.messages[0]!, 'retry');
    await handleQueue(batch as never, env as unknown as Env);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('sends nothing, and acknowledges, if the account has since been disabled', async () => {
    await createUser();
    const { sent } = await requestReset(email);
    await env.DB.prepare('UPDATE users SET disabled_at = 1').run();
    expect((await deliver(sent[0]!)).emails).toEqual([]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_tokens').first('n')).toBe(0);
  });
});

describe('email verification', () => {
  const insertToken = async (userId: string, token: string, expiresAt = Date.now() + 60_000) =>
    env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, ?2, 'email_verification', ?3)`)
      .bind(await hashOpaqueToken(token), userId, expiresAt)
      .run();
  const confirm = (token: string) => post('/api/v1/auth/email-verification/confirm', { token });
  const verifiedAt = (id: string) => env.DB.prepare('SELECT email_verified_at AS v FROM users WHERE id = ?1').bind(id).first('v');

  it('marks the address verified, once', async () => {
    const id = await createUser();
    await insertToken(id, 'good');
    expect((await confirm('good')).status).toBe(204);
    expect(await verifiedAt(id)).toBeGreaterThan(0);
    expect((await confirm('good')).status).toBe(400);
  });

  it('refuses an expired token and leaves the user unverified', async () => {
    const id = await createUser();
    await insertToken(id, 'old', 1);
    expect((await confirm('old')).status).toBe(400);
    expect(await verifiedAt(id)).toBeNull();
  });
});

describe('choosing an email provider', () => {
  const job = { v: 1, type: PASSWORD_RESET_JOB, id: 'job_1', idempotencyKey: 'k', workspaceId: null, occurredAt: new Date().toISOString(), payload: { userId: '' } };
  const runJob = async (overrides: Partial<Env>, userId: string) => {
    const batch = createMessageBatch('oc-email', [{ id: 'm', timestamp: new Date(), attempts: 1, body: { ...job, payload: { userId } } }]);
    const [ack, retry] = [vi.spyOn(batch.messages[0]!, 'ack'), vi.spyOn(batch.messages[0]!, 'retry')];
    await handleQueue(batch as never, { ...env, ...overrides } as unknown as Env);
    return { acked: ack.mock.calls.length, retried: retry.mock.calls.length };
  };

  it('sends through Resend when configured, and a provider failure retries', async () => {
    const id = await createUser();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ id: 'sent' }), { status: 200 })));
    vi.stubGlobal('fetch', fetcher);
    try {
      expect(await runJob({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'test-key', SYSTEM_EMAIL_FROM: 'no-reply@example.org' }, id)).toEqual({ acked: 1, retried: 0 });
      const init = fetcher.mock.calls[0]![1]!;
      expect(fetcher.mock.calls[0]![0]).toBe('https://api.resend.com/emails');
      expect(JSON.parse(init.body as string)).toMatchObject({ to: [email], from: '"Test installation" <no-reply@example.org>' });
      expect((init.headers as Record<string, string>)['idempotency-key']).toMatch(/^password-reset:[0-9a-f]{64}$/);

      fetcher.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })));
      expect(await runJob({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'bad-key' }, id)).toEqual({ acked: 0, retried: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retries rather than sending when Resend is chosen with no key', async () => {
    const id = await createUser();
    expect(await runJob({ EMAIL_PROVIDER: 'resend' }, id)).toEqual({ acked: 0, retried: 1 });
  });
});
