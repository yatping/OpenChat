import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { MAX_ATTACHMENT_BYTES } from '@openchat/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleScheduled } from '../src/background';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = '/api/v1/workspaces/work_1';
const testEnv = env as unknown as Env;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const text = (value: string) => new TextEncoder().encode(value);

let counter = 0;
interface Options {
  token?: string;
  body?: unknown;
  origin?: string;
  file?: Uint8Array;
  type?: string;
  length?: string | null;
}
async function call(method: string, path: string, options: Options = {}) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {
    'cf-connecting-ip': `203.0.113.${++counter % 250}`,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.type ? { 'content-type': options.type } : {}),
  };
  if (options.file && options.length !== null) headers['content-length'] = options.length ?? String(options.file.length);
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), ...(options.file ? { body: options.file } : {}) }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

let hash = '';
let agent = '';
let otherAgent = '';
let visitor = '';
let otherVisitor = '';
let conversationId = '';
let otherConversationId = '';

const widget = (path: string) => `/api/v1/widget/conversations/${path}`;
const uploadAs = (who: 'visitor' | 'agent', conversation: string, options: Partial<Options> = {}, filename = 'photo.png') =>
  call('POST', `${who === 'agent' ? `${W}/conversations/` : '/api/v1/widget/conversations/'}${conversation}/attachments?filename=${encodeURIComponent(filename)}`, {
    token: who === 'agent' ? agent : visitor,
    ...(who === 'visitor' ? { origin: SITE } : {}),
    file: PNG,
    type: 'image/png',
    ...options,
  });
const uploaded = async (who: 'visitor' | 'agent', conversation = conversationId) => {
  const response = await uploadAs(who, conversation);
  expect(response.status).toBe(201);
  return json<{ id: string; url: string; status: string; filename: string }>(response);
};
const visitorSend = (clientMessageId: string, attachmentIds: string[], content = '', token = visitor, conversation = conversationId) =>
  call('POST', widget(`${conversation}/messages`), { token, origin: SITE, body: { clientMessageId, content, attachmentIds } });
const agentSend = (clientMessageId: string, attachmentIds: string[], type = 'text', content = '') =>
  call('POST', `${W}/conversations/${conversationId}/messages`, { token: agent, body: { clientMessageId, type, content, attachmentIds } });
const visitorGet = (id: string, token = visitor) => call('GET', `/api/v1/widget/attachments/${id}`, { token, origin: SITE });
const agentGet = (id: string, token = agent) => call('GET', `${W}/attachments/${id}`, { token });

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['outbox', 'audit_log', 'attachments', 'conversation_read_cursors', 'conversation_events', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('user_a', 'agent@example.com', 'Ana', ?1, 1, 1), ('user_b', 'other@example.com', 'Bo', ?1, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_a', 'work_1', 'user_a', 'supervisor', 'active', 1, 1), ('mem_b', 'work_2', 'user_b', 'supervisor', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_at', ?1, 1, 1)`).bind(JSON.stringify([SITE])),
  ]);
  const login = async (email: string) => (await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD, clientType: 'mobile' } }))).accessToken;
  agent = await login('agent@example.com');
  otherAgent = await login('other@example.com');
  const start = async (clientMessageId: string) => {
    const token = (await json<{ accessToken: string }>(await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_at' }, origin: SITE }))).accessToken;
    const { id } = await json<{ id: string }>(await call('POST', '/api/v1/widget/conversations', { token, origin: SITE, body: { clientMessageId, content: 'Hello' } }));
    return { token, id };
  };
  ({ token: visitor, id: conversationId } = await start('first-message'));
  ({ token: otherVisitor, id: otherConversationId } = await start('other-message'));
});

describe('what may be uploaded', () => {
  it('stores a file under the workspace and the conversation, as ready', async () => {
    const file = await uploaded('visitor');
    expect(file).toMatchObject({ status: 'ready', filename: 'photo.png', url: `/api/v1/widget/attachments/${file.id}` });
    const row = await env.DB.prepare(`SELECT storage_key AS k, size, message_id AS m FROM attachments WHERE id = ?1`).bind(file.id).first<{ k: string; size: number; m: null }>();
    expect(row).toEqual({ k: `w/work_1/c/${conversationId}/${file.id}`, size: PNG.length, m: null });
    expect(new Uint8Array(await (await testEnv.ATTACHMENTS.get(row!.k))!.arrayBuffer())).toEqual(PNG);
  });

  it.each([
    ['HTML, by type', 'text/html', text('<html><script>alert(1)</script>')],
    ['SVG, by type', 'image/svg+xml', text('<svg onload="alert(1)"></svg>')],
    ['XML, by type', 'application/xml', text('<?xml version="1.0"?>')],
    ['a script, by type', 'text/javascript', text('alert(1)')],
    ['anything unnamed', 'application/octet-stream', PNG],
    ['HTML named as a picture', 'image/png', text('<html><script>alert(1)</script></html>')],
    ['HTML named as text', 'text/plain', text('\n  <html><script>alert(1)</script></html>')],
    ['HTML with a byte order mark, named as text', 'text/plain', text('﻿<svg onload=alert(1)>')],
    ['binary named as text', 'text/csv', new Uint8Array([97, 0, 98])],
    ['a program named as a PDF', 'application/pdf', new Uint8Array([0x4d, 0x5a, 0x90, 0])],
    ['a program named as a document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array([0x4d, 0x5a, 0x90, 0])],
  ])('refuses %s', async (_name, type, file) => {
    const response = await uploadAs('visitor', conversationId, { type, file });
    expect(response.status).toBe(415);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments`).first<{ n: number }>())!.n).toBe(0);
  });

  it.each([
    ['text/plain', text('Order 1234, please see the note'), 'note.txt'],
    ['text/csv; charset=utf-8', text('a,b\n1,2'), 'table.csv'],
    ['application/pdf', text('%PDF-1.7 rest'), 'order.pdf'],
    ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), 'photo.jpg'],
    ['image/webp', text('RIFF....WEBPVP8 '), 'photo.webp'],
  ])('accepts %s', async (type, file, filename) => {
    expect((await uploadAs('agent', conversationId, { type, file }, filename)).status).toBe(201);
  });

  it('refuses a file over the limit from its declared size, before reading it', async () => {
    expect((await uploadAs('visitor', conversationId, { length: String(MAX_ATTACHMENT_BYTES + 1) })).status).toBe(413);
  });

  it('refuses an empty file', async () => {
    expect((await uploadAs('visitor', conversationId, { file: new Uint8Array(0), type: 'text/plain', length: '0' })).status).toBe(400);
  });

  it('keeps nothing of a body shorter than it said', async () => {
    const response = await uploadAs('visitor', conversationId, { length: '100000' });
    expect(response.status).toBe(400);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments`).first<{ n: number }>())!.n).toBe(0);
    expect((await testEnv.ATTACHMENTS.list({ prefix: `w/work_1/c/${conversationId}/` })).objects).toEqual([]);
  });

  it('keeps only a safe name', async () => {
    const response = await uploadAs('agent', conversationId, {}, '../../etc/pass"wd\r\n.png');
    expect((await json<{ filename: string }>(response)).filename).toBe('passwd.png');
  });

  it('is limited for a visitor', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await uploadAs('visitor', conversationId)).status;
    expect(last).toBe(429);
  }, 30_000);
});

describe('the name of a file', () => {
  it.each([
    ['a batch file as text', 'invoice.bat', 'text/plain', text('del /q *')],
    ['a page as text', 'invoice.html', 'text/plain', text('hello <script>alert(1)</script>')],
    ['a script as text', 'invoice.js', 'text/plain', text('alert(1)')],
    ['a shortcut as CSV', 'invoice.hta', 'text/csv', text('a,b')],
    ['a program as a picture', 'photo.exe', 'image/png', PNG],
    ['a hidden second extension', 'photo.png.exe', 'image/png', PNG],
    ['a Windows trailing dot', 'notes.bat.', 'text/plain', text('del /q *')],
    ['no extension', 'invoice', 'text/plain', text('words')],
  ])('refuses %s', async (_name, filename, type, file) => {
    const response = await uploadAs('visitor', conversationId, { file, type }, filename);
    expect(response.status).toBe(415);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('applies to agents as well, whose account could be the stolen one', async () => {
    expect((await uploadAs('agent', conversationId, { file: text('del /q *'), type: 'text/plain' }, 'run.bat')).status).toBe(415);
  });

  it.each([
    ['txt', 'text/plain', text('words')],
    ['LOG', 'text/plain', text('words')],
    ['csv', 'text/csv', text('a,b')],
    ['JPEG', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0])],
  ])('accepts .%s, in either case', async (extension, type, file) => {
    expect((await uploadAs('visitor', conversationId, { file, type }, `file.${extension}`)).status).toBe(201);
  });

  it('takes out characters that make a name read as something else', async () => {
    const response = await uploadAs('visitor', conversationId, { file: text('words'), type: 'text/plain' }, 'exe\u202e\u200bgnp.\u2066txt');
    expect(response.status).toBe(201);
    expect(await json<{ filename: string }>(response)).toMatchObject({ filename: 'exegnp.txt' });
  });
});

describe('who may upload where', () => {
  it('not to a conversation of another visitor', async () => {
    expect((await uploadAs('visitor', otherConversationId)).status).toBe(404);
  });

  it('not to a conversation in another workspace', async () => {
    const response = await call('POST', `/api/v1/workspaces/work_2/conversations/${conversationId}/attachments?filename=a.png`, { token: otherAgent, file: PNG, type: 'image/png' });
    expect(response.status).toBe(404);
  });

  it('needs a website the origin is allowed on', async () => {
    expect((await uploadAs('visitor', conversationId, { origin: 'https://elsewhere.example' })).status).toBe(403);
  });
});

describe('putting a file on a message', () => {
  it('attaches it, and it comes back with the message, by REST', async () => {
    const file = await uploaded('visitor');
    const response = await visitorSend('with-a-file', [file.id]);
    expect(response.status).toBe(201);
    const message = await json<{ type: string; content: string; attachments: { id: string; url: string }[] }>(response);
    expect(message).toMatchObject({ type: 'image', content: '' });
    expect(message.attachments).toEqual([{ id: file.id, filename: 'photo.png', contentType: 'image/png', size: PNG.length, url: `/api/v1/widget/attachments/${file.id}` }]);
    const seenByAgent = await json<{ data: { attachments: { id: string; url: string }[] }[] }>(await call('GET', `${W}/conversations/${conversationId}/messages?limit=10`, { token: agent }));
    expect(seenByAgent.data.at(-1)!.attachments[0]).toMatchObject({ id: file.id, url: `${W}/attachments/${file.id}`, status: 'ready' });
  });

  it('calls a mix a file, and keeps words with it', async () => {
    const picture = await uploaded('agent');
    const pdf = await json<{ id: string }>(await uploadAs('agent', conversationId, { type: 'application/pdf', file: text('%PDF-1.7') }, 'a.pdf'));
    const message = await json<{ type: string; content: string; attachments: unknown[] }>(await agentSend('mixed-files', [picture.id, pdf.id], 'text', 'Both of these'));
    expect(message).toMatchObject({ type: 'file', content: 'Both of these' });
    expect(message.attachments).toHaveLength(2);
  });

  it('still needs words or a file', async () => {
    expect((await visitorSend('with-nothing', [])).status).toBe(400);
  });

  it('a replay changes nothing, and answers with the same message', async () => {
    const file = await uploaded('visitor');
    const first = await json<{ id: string }>(await visitorSend('replayed-send', [file.id]));
    const again = await visitorSend('replayed-send', [file.id]);
    expect(again.status).toBe(200);
    expect((await json<{ id: string }>(again)).id).toBe(first.id);
    expect((await env.DB.prepare(`SELECT message_id AS m FROM attachments WHERE id = ?1`).bind(file.id).first<{ m: string }>())!.m).toBe(first.id);
  });

  it('refuses, and sends nothing, for a file that is not theirs to send', async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
    const theirs = await json<{ id: string }>(await uploadAs('visitor', otherConversationId, { token: otherVisitor }));
    const agents = await uploaded('agent');
    const used = await uploaded('visitor');
    expect((await visitorSend('claim-used', [used.id])).status).toBe(201);

    expect((await visitorSend('claim-other', [theirs.id])).status).toBe(400);
    expect((await visitorSend('claim-agents', [agents.id])).status).toBe(400);
    expect((await visitorSend('claim-again', [used.id])).status).toBe(400);
    expect((await visitorSend('claim-unknown', ['att_nothing'])).status).toBe(400);
    // One good and one bad, in the same message: all or nothing.
    const good = await uploaded('visitor');
    expect((await visitorSend('claim-mixed', [good.id, theirs.id], 'words')).status).toBe(400);
    expect((await env.DB.prepare(`SELECT message_id AS m FROM attachments WHERE id = ?1`).bind(good.id).first<{ m: null }>())!.m).toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>())!.n).toBe(before!.n + 1);

    const visitorsFile = await uploaded('visitor');
    expect((await agentSend('agent-claims-visitors', [visitorsFile.id])).status).toBe(400);
  });

  it('refuses one still arriving, and one old enough to be swept', async () => {
    const pending = await uploaded('visitor');
    await env.DB.prepare(`UPDATE attachments SET status = 'pending' WHERE id = ?1`).bind(pending.id).run();
    expect((await visitorSend('claim-pending', [pending.id])).status).toBe(400);
    const old = await uploaded('visitor');
    await env.DB.prepare(`UPDATE attachments SET created_at = ?2 WHERE id = ?1`).bind(old.id, Date.now() - 23.5 * 60 * 60 * 1000).run();
    expect((await visitorSend('claim-old', [old.id])).status).toBe(400);
  });
});

describe('who may download', () => {
  const body = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  it('an agent gets any file in the workspace, with safe headers', async () => {
    const file = await uploaded('visitor');
    const response = await agentGet(file.id);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(PNG);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''photo.png");
  });

  it('anything not a raster image is only ever a download, with its name encoded', async () => {
    const pdf = await json<{ id: string }>(await uploadAs('agent', conversationId, { type: 'application/pdf', file: text('%PDF-1.7') }, 'Invoice "May" é.pdf'));
    const response = await agentGet(pdf.id);
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''Invoice%20May%20%C3%A9.pdf");
  });

  it('another workspace gets 404, for a file that exists', async () => {
    const file = await uploaded('agent');
    expect((await call('GET', `/api/v1/workspaces/work_2/attachments/${file.id}`, { token: otherAgent })).status).toBe(404);
    expect((await agentGet(file.id, otherAgent)).status).toBe(404);
  });

  it('needs a token', async () => {
    const file = await uploaded('agent');
    expect((await call('GET', `${W}/attachments/${file.id}`)).status).toBe(401);
    expect((await call('GET', `/api/v1/widget/attachments/${file.id}`, { origin: SITE })).status).toBe(401);
  });

  it('a visitor gets a file on a public message of theirs, and answers CORS', async () => {
    const file = await uploaded('agent');
    expect((await agentSend('public-file', [file.id])).status).toBe(201);
    const response = await visitorGet(file.id);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(PNG);
    expect(response.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('a visitor never gets the file on a note, or one an agent has not sent', async () => {
    const onNote = await uploaded('agent');
    expect((await agentSend('note-file', [onNote.id], 'internal_note', 'For the team')).status).toBe(201);
    expect((await agentGet(onNote.id)).status).toBe(200);
    expect((await visitorGet(onNote.id)).status).toBe(404);
    const unsent = await uploaded('agent');
    expect((await visitorGet(unsent.id)).status).toBe(404);
  });

  it('a note and its file stay out of what a visitor reads', async () => {
    const onNote = await uploaded('agent');
    await agentSend('note-file-list', [onNote.id], 'internal_note', 'SECRET');
    const messages = await call('GET', widget(`${conversationId}/messages?limit=50`), { token: visitor, origin: SITE });
    expect(await messages.text()).not.toContain(onNote.id);
  });

  it('another visitor of the same website gets 404', async () => {
    const file = await uploaded('agent');
    await agentSend('for-one-visitor', [file.id]);
    expect((await visitorGet(file.id, otherVisitor)).status).toBe(404);
    const own = await uploaded('visitor');
    await visitorSend('own-file', [own.id]);
    expect((await visitorGet(own.id, otherVisitor)).status).toBe(404);
    expect((await visitorGet(own.id)).status).toBe(200);
  });
});

describe('the orphan sweep', () => {
  const onTheHour = { cron: '* * * * *', scheduledTime: Date.UTC(2026, 10, 4, 12, 0, 0), noRetry: () => undefined } as unknown as ScheduledController;
  const offTheHour = { ...onTheHour, scheduledTime: Date.UTC(2026, 10, 4, 12, 7, 0) } as unknown as ScheduledController;

  it('removes an old unclaimed file from storage and the database, on the hour only', async () => {
    const old = await uploaded('visitor');
    const recent = await uploaded('visitor');
    const sent = await uploaded('visitor');
    await visitorSend('kept-file', [sent.id]);
    await env.DB.prepare(`UPDATE attachments SET created_at = ?1 WHERE id IN (?2, ?3)`).bind(Date.now() - 25 * 60 * 60 * 1000, old.id, sent.id).run();
    const key = (id: string) => `w/work_1/c/${conversationId}/${id}`;

    await handleScheduled(offTheHour, testEnv);
    expect(await testEnv.ATTACHMENTS.head(key(old.id))).not.toBeNull();

    await handleScheduled(onTheHour, testEnv);
    expect(await testEnv.ATTACHMENTS.head(key(old.id))).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM attachments WHERE id = ?1`).bind(old.id).first()).toBeNull();
    expect(await testEnv.ATTACHMENTS.head(key(recent.id))).not.toBeNull();
    expect(await testEnv.ATTACHMENTS.head(key(sent.id))).not.toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM attachments WHERE id = ?1`).bind(sent.id).first()).not.toBeNull();
  });
});
