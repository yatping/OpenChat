import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { importPrivateKey, signRequest, toBase64Url } from '@openchat/notification-protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';
import { documentProvesControl, normalizeBaseUrl } from '../src/requests/domain-proof';
import { REQUEST_BURST } from '../src/requests/guard';
import { sanitizeDisplayName } from '../src/requests/schemas';
import { clearKeyCache, MAX_BODY_BYTES } from '../src/requests/verify';

const testEnv = env as unknown as Env;
const openEnv: Env = { ...testEnv, RELAY_MODE: 'open' };
let counter = 0;
const unique = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

async function newKey() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return { privateKey: await importPrivateKey(toBase64Url(pkcs8)), publicKey: toBase64Url(raw) };
}

interface Actor { installationId: string; baseUrl: string; keyId: string; privateKey: CryptoKey; publicKey: string }
async function newActor(): Promise<Actor> {
  const id = unique('inst');
  return { installationId: id, baseUrl: `https://${id.toLowerCase().replaceAll('_', '-')}.example.org`, keyId: 'k1', ...(await newKey()) };
}

const documentFor = (actor: Actor) => JSON.stringify({ installationId: actor.installationId, relay: { publicKeys: [{ id: actor.keyId, alg: 'Ed25519', key: actor.publicKey }] } });

/** A stand-in for the internet, answering only for addresses it has been told about. */
function internet(actors: Actor[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const actor = actors.find((a) => String(input) === `${a.baseUrl}/.well-known/openchat.json`);
    return actor ? new Response(documentFor(actor)) : new Response('', { status: 404 });
  };
  return { fetcher, calls };
}

interface SendOptions { path: string; body: unknown; workspaceId?: string; requestId?: string; timestamp?: string; rawBody?: string; tamper?: (headers: Record<string, string>) => void; method?: string }

async function signedRequest(actor: Actor, options: SendOptions) {
  const bytes = new TextEncoder().encode(options.rawBody ?? JSON.stringify(options.body));
  const requestId = options.requestId ?? crypto.randomUUID();
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = await signRequest(actor.privateKey, { method: 'POST', path: options.path, installationId: actor.installationId, ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), keyId: actor.keyId, requestId, timestamp, body: bytes });
  const headers: Record<string, string> = { 'x-installation-id': actor.installationId, 'x-key-id': actor.keyId, 'x-request-id': requestId, 'x-timestamp': timestamp, 'x-signature': signature, ...(options.workspaceId ? { 'x-workspace-id': options.workspaceId } : {}) };
  options.tamper?.(headers);
  return { bytes, headers };
}

function clientFor(actors: Actor[], environment: Env = openEnv) {
  const net = internet(actors);
  const app = createApp(undefined, net.fetcher);
  const ip = unique('ip');
  const send = async (actor: Actor, options: SendOptions, from = ip) => {
    const { bytes, headers } = await signedRequest(actor, options);
    return app.request(options.path, { method: options.method ?? 'POST', headers: { ...headers, 'cf-connecting-ip': from }, body: bytes }, environment);
  };
  return { app, net, send };
}

const registration = (actor: Actor) => ({ path: '/v1/installations/register', body: { baseUrl: actor.baseUrl, publicKey: { id: actor.keyId, alg: 'Ed25519', key: actor.publicKey } } });
const workspaceBody = (workspaceId: string, displayName?: string) => ({ path: '/v1/workspaces/register', workspaceId, body: { workspaceId, ...(displayName ? { displayName } : {}) } });

async function registered(actor?: Actor) {
  const me = actor ?? (await newActor());
  const client = clientFor([me]);
  expect((await client.send(me, registration(me))).status).toBe(201);
  return { me, ...client };
}

beforeEach(() => clearKeyCache());

describe('registering an installation', () => {
  it('registers after reading the discovery document, without following redirects', async () => {
    const { me, net } = await registered();
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.url).toBe(`${me.baseUrl}/.well-known/openchat.json`);
    expect(net.calls[0]?.init?.redirect).toBe('manual');
  });

  it('answers 200 to the same registration, without reading the document again', async () => {
    const { me, send, net } = await registered();
    expect((await send(me, registration(me))).status).toBe(200);
    expect(net.calls).toHaveLength(1);
  });

  it('refuses another key for a registered ID, even from a domain listing it', async () => {
    const { me } = await registered();
    const thief = { ...(await newActor()), installationId: me.installationId };
    const response = await clientFor([thief]).send(thief, registration(thief));
    expect(response.status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT public_key AS k FROM installation_keys WHERE installation_id = ?').bind(me.installationId).all()).toMatchObject({ results: [{ k: me.publicKey }] });
  });

  it('refuses another ID at a registered address', async () => {
    const { me } = await registered();
    const other = { ...(await newActor()), baseUrl: me.baseUrl };
    const response = await clientFor([other]).send(other, registration(other));
    expect(response.status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT 1 FROM installations WHERE id = ?').bind(other.installationId).first()).toBeNull();
  });

  it('refuses when the document does not list this ID or key', async () => {
    const me = await newActor();
    const other = await newActor();
    const net: typeof fetch = async () => new Response(documentFor({ ...me, publicKey: other.publicKey }));
    const app = createApp(undefined, net);
    const { bytes, headers } = await signedRequest(me, registration(me));
    const response = await app.request('/v1/installations/register', { method: 'POST', headers, body: bytes }, openEnv);
    expect(response.status).toBe(422);
  });

  it('refuses a signature that does not match the key offered', async () => {
    const me = await newActor();
    const other = await newActor();
    const client = clientFor([me]);
    const options = registration(me);
    const forged = await signedRequest({ ...me, privateKey: other.privateKey }, options);
    const response = await client.app.request(options.path, { method: 'POST', headers: forged.headers, body: forged.bytes }, openEnv);
    expect(response.status).toBe(401);
    expect(client.net.calls).toHaveLength(0);
  });

  it('in private mode, accepts only allowlisted installations, before touching the network', async () => {
    const me = await newActor();
    const refused = clientFor([me], { ...testEnv, RELAY_MODE: 'private', RELAY_ALLOWED_INSTALLATIONS: 'inst_other' });
    expect((await refused.send(me, registration(me))).status).toBe(403);
    expect(refused.net.calls).toHaveLength(0);
    const allowed = clientFor([me], { ...testEnv, RELAY_MODE: 'private', RELAY_ALLOWED_INSTALLATIONS: `inst_other, ${me.installationId}` });
    expect((await allowed.send(me, registration(me))).status).toBe(201);
  });

  it('in private mode with no allowlist, accepts nobody', async () => {
    const me = await newActor();
    const empty: Env = { ...testEnv, RELAY_MODE: 'private' };
    delete empty.RELAY_ALLOWED_INSTALLATIONS;
    expect((await clientFor([me], empty).send(me, registration(me))).status).toBe(403);
  });

  it('limits new registrations per IP, before checking anything costly', async () => {
    const client = clientFor([]);
    const from = unique('ip');
    const answers: number[] = [];
    for (let i = 0; i < 25; i++) {
      const me = await newActor();
      answers.push((await client.send(me, registration(me), from)).status);
    }
    expect(answers).toContain(429);
    // It does not spill over to someone else.
    const me = await newActor();
    expect((await clientFor([me]).send(me, registration(me))).status).toBe(201);
  });

  it('refuses an unknown body field', async () => {
    const me = await newActor();
    const options = registration(me);
    expect((await clientFor([me]).send(me, { ...options, body: { ...options.body, note: 'hello' } })).status).toBe(400);
  });
});

describe('the address it will fetch', () => {
  it.each([
    ['https://chat.example.com', 'https://chat.example.com'],
    ['https://chat.example.com/', 'https://chat.example.com'],
    ['https://CHAT.example.com:443', 'https://chat.example.com'],
  ])('accepts %s', (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected));

  it.each(['http://chat.example.com', 'https://chat.example.com:8443', 'https://127.0.0.1', 'https://[::1]', 'https://0x7f.0.0.1', 'https://2130706433', 'https://localhost', 'https://intranet', 'https://a.localhost', 'https://a.internal', 'https://a.local', 'https://u:p@chat.example.com', 'https://chat.example.com/path', 'https://chat.example.com/?a=1', 'not a url'])(
    'refuses %s',
    (input) => expect(normalizeBaseUrl(input)).toBeNull(),
  );

  const expected = { installationId: 'inst_a', keyId: 'k1', publicKey: 'key' };
  const body = JSON.stringify({ installationId: 'inst_a', relay: { publicKeys: [{ id: 'k1', alg: 'Ed25519', key: 'key' }] } });

  it('treats a redirect as failure', async () => {
    expect(await documentProvesControl(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }), 'https://a.example', expected)).toBe(false);
  });
  it('refuses a document over 64 KB', async () => {
    expect(await documentProvesControl(async () => new Response(`${body}${' '.repeat(70_000)}`), 'https://a.example', expected)).toBe(false);
    expect(await documentProvesControl(async () => new Response(body), 'https://a.example', expected)).toBe(true);
  });
  it('treats a network failure or bad JSON as failure', async () => {
    expect(await documentProvesControl(async () => { throw new Error('down'); }, 'https://a.example', expected)).toBe(false);
    expect(await documentProvesControl(async () => new Response('nope'), 'https://a.example', expected)).toBe(false);
  });
  it('passes a timeout', async () => {
    let signal: AbortSignal | null | undefined;
    await documentProvesControl(async (_input, init) => { signal = init?.signal; return new Response(body); }, 'https://a.example', expected);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('every signed field', () => {
  const path = '/v1/workspaces/register';

  async function setup() {
    const context = await registered();
    const workspaceId = unique('work');
    const options = { path, workspaceId, body: { workspaceId } };
    return { ...context, workspaceId, options };
  }

  it('accepts the untampered request', async () => {
    const { me, send, options } = await setup();
    expect((await send(me, options)).status).toBe(201);
  });

  it.each([
    ['workspace ID', (h: Record<string, string>) => { h['x-workspace-id'] = 'work_other'; }],
    ['removed workspace ID', (h: Record<string, string>) => { delete h['x-workspace-id']; }],
    ['key ID', (h: Record<string, string>) => { h['x-key-id'] = 'k2'; }],
    ['request ID', (h: Record<string, string>) => { h['x-request-id'] = 'a-different-request-id'; }],
    ['timestamp', (h: Record<string, string>) => { h['x-timestamp'] = String(Number(h['x-timestamp']) + 1); }],
  ])('rejects a tampered %s', async (_name, tamper) => {
    const { me, send, options } = await setup();
    expect((await send(me, { ...options, tamper })).status).toBe(401);
  });

  it('rejects a signature made for another installation, even a registered one', async () => {
    const { me, send, options } = await setup();
    const other = await registered();
    expect((await send(me, { ...options, tamper: (h) => { h['x-installation-id'] = other.me.installationId; } })).status).toBe(401);
  });

  it('rejects a signature made for another path', async () => {
    const { me, app, options, workspaceId } = await setup();
    const { headers } = await signedRequest(me, options);
    const response = await app.request('/v1/workspaces/revoke', { method: 'POST', headers, body: JSON.stringify({ workspaceId }) }, openEnv);
    expect(response.status).toBe(401);
  });

  it('rejects a tampered body', async () => {
    const { me, app, options } = await setup();
    const { headers } = await signedRequest(me, options);
    const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ workspaceId: options.workspaceId, displayName: 'Bank' }) }, openEnv);
    expect(response.status).toBe(401);
  });

  it('rejects a tampered signature, and an unsigned request', async () => {
    const { me, send, options } = await setup();
    expect((await send(me, { ...options, tamper: (h) => { h['x-signature'] = `v1=${'A'.repeat(86)}`; } })).status).toBe(401);
    expect((await send(me, { ...options, tamper: (h) => { h['x-signature'] = 'v1=short'; } })).status).toBe(401);
    expect((await send(me, { ...options, tamper: (h) => { delete h['x-signature']; } })).status).toBe(400);
  });

  it.each([[-301], [301]])('rejects a timestamp %i seconds away, even signed', async (offset) => {
    const { me, send, options } = await setup();
    const response = await send(me, { ...options, timestamp: String(Math.floor(Date.now() / 1000) + offset) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'stale_timestamp' });
  });

  it('rejects a replay, and writes nothing', async () => {
    const { me, send, options } = await setup();
    const requestId = crypto.randomUUID();
    expect((await send(me, { ...options, requestId })).status).toBe(201);
    const again = await send(me, { ...options, requestId, body: options.body });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'replayed' });
  });

  it('answers an unknown installation the same as a bad signature', async () => {
    const { me, send, options } = await setup();
    const stranger = await newActor();
    const unknown = await send(stranger, { ...options, body: options.body });
    const bad = await send(me, { ...options, tamper: (h) => { h['x-signature'] = `v1=${'A'.repeat(86)}`; } });
    expect(unknown.status).toBe(bad.status);
    expect(await unknown.json()).toEqual(await bad.json());
  });

  it('rejects a revoked key after the cache', async () => {
    const { me, send, options } = await setup();
    await testEnv.DB.prepare(`UPDATE installation_keys SET status = 'revoked' WHERE installation_id = ?`).bind(me.installationId).run();
    clearKeyCache();
    expect((await send(me, options)).status).toBe(401);
  });

  it('rejects a body over the limit', async () => {
    const { me, send, options } = await setup();
    expect((await send(me, { ...options, rawBody: 'x'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
  });
});

describe('workspaces', () => {
  it('needs the header and body to agree', async () => {
    const { me, send } = await registered();
    const first = unique('work');
    expect((await send(me, { path: '/v1/workspaces/register', workspaceId: first, body: { workspaceId: unique('work') } })).status).toBe(400);
  });

  it('refuses unknown fields, so no content can be sent', async () => {
    const { me, send } = await registered();
    const workspaceId = unique('work');
    expect((await send(me, { path: '/v1/workspaces/register', workspaceId, body: { workspaceId, message: 'hello' } })).status).toBe(400);
  });

  it('refuses a display name over 40 characters', async () => {
    const { me, send } = await registered();
    const workspaceId = unique('work');
    expect((await send(me, { path: '/v1/workspaces/register', workspaceId, body: { workspaceId, displayName: 'x'.repeat(41) } })).status).toBe(400);
  });

  it('stores a cleaned display name, and updates it', async () => {
    const { me, send } = await registered();
    const workspaceId = unique('work');
    expect((await send(me, workspaceBody(workspaceId, 'Acme‮ Bank\n'))).status).toBe(201);
    expect((await send(me, workspaceBody(workspaceId, 'Acme'))).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT display_name AS n FROM workspaces WHERE installation_id = ? AND workspace_id = ?').bind(me.installationId, workspaceId).first()).toEqual({ n: 'Acme' });
  });

  it('cleans control, direction, and line characters', () => {
    expect(sanitizeDisplayName('A‮b​c d\ne')).toBe('Abcde');
    expect(sanitizeDisplayName('‮  ')).toBeNull();
    expect(sanitizeDisplayName(undefined)).toBeNull();
  });

  it('keeps the same workspace ID separate between installations', async () => {
    const a = await registered();
    const b = await registered();
    const workspaceId = unique('work');
    expect((await a.send(a.me, workspaceBody(workspaceId, 'A'))).status).toBe(201);
    expect((await b.send(b.me, workspaceBody(workspaceId, 'B'))).status).toBe(201);
    expect((await b.send(b.me, { path: '/v1/workspaces/revoke', workspaceId, body: { workspaceId } })).status).toBe(204);
    const rows = await testEnv.DB.prepare('SELECT installation_id AS i, status AS s FROM workspaces WHERE workspace_id = ?').bind(workspaceId).all<{ i: string; s: string }>();
    expect(rows.results.find((r) => r.i === a.me.installationId)?.s).toBe('active');
    expect(rows.results.find((r) => r.i === b.me.installationId)?.s).toBe('revoked');
  });

  it('cannot be revoked by another installation', async () => {
    const a = await registered();
    const b = await registered();
    const workspaceId = unique('work');
    await a.send(a.me, workspaceBody(workspaceId));
    await b.send(b.me, { path: '/v1/workspaces/revoke', workspaceId, body: { workspaceId } });
    expect(await testEnv.DB.prepare('SELECT status AS s FROM workspaces WHERE installation_id = ? AND workspace_id = ?').bind(a.me.installationId, workspaceId).first()).toEqual({ s: 'active' });
  });
});

describe('RelayGuard', () => {
  const stub = (name: string) => testEnv.RELAY_GUARD.getByName(name);

  it('admits a new request ID once', async () => {
    expect(await stub('once').admit('request-1')).toEqual({ ok: true });
    expect(await stub('once').admit('request-1')).toEqual({ ok: false, reason: 'replayed' });
    expect(await stub('once').admit('request-2')).toEqual({ ok: true });
  });

  it('keeps one installation separate from another', async () => {
    await stub('alpha').admit('same-id');
    expect(await stub('beta').admit('same-id')).toEqual({ ok: true });
  });

  it('rate limits after the burst, and a refused request can be retried', async () => {
    const guard = stub('busy');
    await guard.admit('first');
    const setBucket = (tokens: number, ageMs: number) => runInDurableObject(guard, (_instance, state) => state.storage.sql.exec('UPDATE bucket SET tokens = ?, updated_at = ?', tokens, Date.now() - ageMs));
    await setBucket(0, 0);
    const refused = await guard.admit('one-more');
    expect(refused).toMatchObject({ ok: false, reason: 'rate_limited', retryAfterSeconds: 1 });
    await setBucket(0, 60_000);
    expect(await guard.admit('one-more')).toEqual({ ok: true });
    // Refilling stops at the burst.
    await setBucket(0, 3_600_000);
    await guard.admit('after-an-hour');
    const tokens = await runInDurableObject(guard, (_instance, state) => state.storage.sql.exec<{ tokens: number }>('SELECT tokens FROM bucket').one().tokens);
    expect(tokens).toBe(REQUEST_BURST - 1);
  });

  it('forgets nonces only after they expire, and leaves others', async () => {
    const guard = stub('sweep');
    await guard.admit('old');
    await guard.admit('new');
    const left = await runInDurableObject(guard, async (instance, state) => {
      state.storage.sql.exec(`UPDATE nonces SET expires_at = 1 WHERE id = 'old'`);
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      return state.storage.sql.exec<{ id: string }>('SELECT id FROM nonces').toArray().map((r) => r.id);
    });
    expect(left).toEqual(['new']);
  });
});

describe('what the relay stores', () => {
  it('has no column that could hold content or personal data', async () => {
    const tables = await testEnv.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('installations', 'installation_keys', 'workspaces')`).all<{ name: string }>();
    expect(tables.results).toHaveLength(3);
    for (const { name } of tables.results) {
      const columns = await testEnv.DB.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>();
      for (const column of columns.results) expect(column.name).not.toMatch(/message|content|email|body|text|note|^name$/);
    }
  });
});
