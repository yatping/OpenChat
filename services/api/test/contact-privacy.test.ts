// Contact export and erasure: for a data subject's request. See docs/architecture/data-model.md#contact-export-and-erasure.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { emailRecipientHash } from '@openchat/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const PASSWORD = 'correct horse battery';
const W = '/api/v1/workspaces/work_1';
const testEnv = env as unknown as Env;
const ANN = `${W}/contacts/cont_ann`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let counter = 0;
async function call(method: string, path: string, token: string | null, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${++counter}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    ctx,
  );
  // Erasure deletes files after it answers.
  await waitOnExecutionContext(ctx);
  return response;
}

let hash = '';
const tokens = { admin: '', agent: '', outsider: '' };
const login = async (email: string) => ((await (await call('POST', '/api/v1/auth/login', null, { email, password: PASSWORD, clientType: 'mobile' })).json()) as { accessToken: string }).accessToken;

const TABLES = ['failed_jobs', 'email_deliveries', 'email_unsubscribe_links', 'email_suppressions', 'audit_log', 'outbox', 'attachments', 'messages', 'conversation_events', 'contact_tags', 'tags', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'];
const key = (conversation: string, file: string) => `w/work_1/c/${conversation}/${file}`;
const count = async (sql: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const annHash = await emailRecipientHash('Ann@Example.com');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1)`),
    env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES
       ('user_admin', 'admin@example.com', 'Admin', ?1, 1, 1, 1), ('user_agent', 'agent@example.com', 'Agent Smith', ?1, 0, 1, 1),
       ('user_outsider', 'outsider@example.com', 'Outsider', ?1, 1, 1, 1)`,
    ).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_admin', 'work_1', 'user_admin', 'agent', 'active', 1, 1), ('mem_agent', 'work_1', 'user_agent', 'supervisor', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_1', 1, 1)`),
    env.DB.prepare(
      `INSERT INTO contacts (id, workspace_id, name, email, phone, attributes_json, follow_up_consent_at, follow_up_consent_source, first_seen_at, last_seen_at, created_at, updated_at) VALUES
       ('cont_ann', 'work_1', 'Ann', 'ann@example.com', '123', '{"plan":"pro"}', 5000, 'widget', 1000, 2000, 1000, 1),
       ('cont_bob', 'work_1', 'Bob', 'bob@example.com', NULL, '{}', NULL, NULL, 1000, 2000, 1000, 1)`,
    ),
    env.DB.prepare(`INSERT INTO visitors (id, workspace_id, website_id, contact_id, refresh_token_hash, created_at, last_seen_at) VALUES ('vis_ann', 'work_1', 'site_1', 'cont_ann', 'h_ann', 1000, 2000), ('vis_bob', 'work_1', 'site_1', 'cont_bob', 'h_bob', 1000, 2000)`),
    env.DB.prepare(
      `INSERT INTO conversations (id, workspace_id, website_id, contact_id, subject, last_message_seq, last_public_seq, last_message_at, created_at, updated_at) VALUES
       ('conv_ann', 'work_1', 'site_1', 'cont_ann', 'Order', 3, 2, 3000, 1000, 1), ('conv_bob', 'work_1', 'site_1', 'cont_bob', NULL, 1, 1, 3000, 1000, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, sender_type, sender_id, message_type, visibility, content, created_at) VALUES
       ('msg_1', 'work_1', 'conv_ann', 1, 1, 'visitor', 'vis_ann', 'text', 'public', 'Where is order 1042?', 1000),
       ('msg_2', 'work_1', 'conv_ann', 2, NULL, 'member', 'mem_agent', 'internal_note', 'internal', 'Seems upset', 2000),
       ('msg_3', 'work_1', 'conv_ann', 3, 2, 'member', 'mem_agent', 'image', 'public', '', 3000),
       ('msg_b', 'work_1', 'conv_bob', 1, 1, 'visitor', 'vis_bob', 'text', 'public', 'Hello from Bob', 1000)`,
    ),
    env.DB.prepare(
      `INSERT INTO attachments (id, workspace_id, conversation_id, message_id, storage_key, filename, content_type, size, status, uploaded_by_type, uploaded_by_id, created_at) VALUES
       ('att_ann', 'work_1', 'conv_ann', 'msg_3', ?1, 'label.png', 'image/png', 11, 'ready', 'member', 'mem_agent', 3000),
       ('att_bob', 'work_1', 'conv_bob', 'msg_b', ?2, 'bob.png', 'image/png', 11, 'ready', 'visitor', 'vis_bob', 3000)`,
    ).bind(key('conv_ann', 'att_ann'), key('conv_bob', 'att_bob')),
    env.DB.prepare(`INSERT INTO tags (id, workspace_id, name, created_at) VALUES ('tag_vip', 'work_1', 'vip', 1)`),
    env.DB.prepare(`INSERT INTO contact_tags (workspace_id, contact_id, tag_id, created_at) VALUES ('work_1', 'cont_ann', 'tag_vip', 1), ('work_1', 'cont_bob', 'tag_vip', 1)`),
    env.DB.prepare(`INSERT INTO email_suppressions (workspace_id, email, reason, created_at) VALUES ('work_1', 'ann@example.com', 'unsubscribe', 4000)`),
    env.DB.prepare(`INSERT INTO email_unsubscribe_links (token_hash, workspace_id, email, created_at) VALUES ('t_ann', 'work_1', 'ANN@example.com', 1), ('t_bob', 'work_1', 'bob@example.com', 1)`),
    env.DB.prepare(
      `INSERT INTO email_deliveries (id, workspace_id, dedupe_key, template, recipient_hash, status, created_at, updated_at) VALUES
       ('ed_ann', 'work_1', 'follow_up:r:conv_ann:1', 'follow_up', ?1, 'sent', 1, 1), ('ed_bob', 'work_1', 'follow_up:r:conv_bob:1', 'follow_up', 'other', 'sent', 1, 1)`,
    ).bind(annHash),
    env.DB.prepare(
      `INSERT INTO failed_jobs (id, workspace_id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at) VALUES
       ('fj_ann', 'work_1', 'q', 'notification.dispatch', 'k1', 5, '{"payload":{"notifications":[{"conversationId":"conv_ann"}]}}', 1),
       ('fj_bob', 'work_1', 'q', 'notification.dispatch', 'k2', 5, '{"payload":{"notifications":[{"conversationId":"conv_bob"}]}}', 1)`,
    ),
  ]);
  await Promise.all([testEnv.ATTACHMENTS.put(key('conv_ann', 'att_ann'), PNG), testEnv.ATTACHMENTS.put(key('conv_ann', 'att_pending'), PNG), testEnv.ATTACHMENTS.put(key('conv_bob', 'att_bob'), PNG)]);
  tokens.admin = await login('admin@example.com');
  tokens.agent = await login('agent@example.com');
  tokens.outsider = await login('outsider@example.com');
});

describe('who may', () => {
  it('refuses a member who is not an installation admin, even a supervisor, and changes nothing', async () => {
    expect((await call('GET', `${ANN}/export`, tokens.agent)).status).toBe(403);
    expect((await call('DELETE', ANN, tokens.agent)).status).toBe(403);
    expect(await count(`contacts WHERE id = 'cont_ann'`)).toBe(1);
    expect(await count('audit_log')).toBe(0);
  });

  it('answers 404 to an installation admin who has not joined the workspace (ADR-0016)', async () => {
    expect((await call('GET', `${ANN}/export`, tokens.outsider)).status).toBe(404);
    expect((await call('DELETE', ANN, tokens.outsider)).status).toBe(404);
    expect(await count(`contacts WHERE id = 'cont_ann'`)).toBe(1);
  });

  it('answers 404 for an unknown contact', async () => {
    expect((await call('GET', `${W}/contacts/cont_none/export`, tokens.admin)).status).toBe(404);
    expect((await call('DELETE', `${W}/contacts/cont_none`, tokens.admin)).status).toBe(404);
  });
});

describe('export', () => {
  it('gives everything about the contact, as a download, without colleagues’ names or internal notes', async () => {
    const response = await call('GET', `${ANN}/export`, tokens.admin);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="contact-cont_ann.json"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      includesInternalNotes: false,
      contact: { id: 'cont_ann', name: 'Ann', email: 'ann@example.com', phone: '123', attributes: { plan: 'pro' }, followUpConsentAt: new Date(5000).toISOString(), followUpConsentSource: 'widget' },
      tags: ['vip'],
      browsers: [{ id: 'vis_ann', websiteId: 'site_1', firstSeenAt: new Date(1000).toISOString(), lastSeenAt: new Date(2000).toISOString() }],
      conversations: [
        {
          id: 'conv_ann',
          subject: 'Order',
          messages: [
            { id: 'msg_1', from: 'visitor', internal: false, content: 'Where is order 1042?', attachments: [] },
            { id: 'msg_3', from: 'member', type: 'image', attachments: [{ filename: 'label.png', contentType: 'image/png', size: 11 }] },
          ],
        },
      ],
      emailSuppressions: [{ email: 'ann@example.com', reason: 'unsubscribe' }],
    });
    const text = JSON.stringify(body);
    for (const absent of ['Seems upset', 'Agent Smith', 'mem_agent', 'Bob', 'conv_bob']) expect(text).not.toContain(absent);
  });

  it('includes internal notes only when asked', async () => {
    const body = (await (await call('GET', `${ANN}/export?include=notes`, tokens.admin)).json()) as { includesInternalNotes: boolean; conversations: { messages: { id: string; internal: boolean; content: string }[] }[] };
    expect(body.includesInternalNotes).toBe(true);
    expect(body.conversations[0]!.messages.map((m) => [m.id, m.internal])).toEqual([['msg_1', false], ['msg_2', true], ['msg_3', false]]);
    expect((await call('GET', `${ANN}/export?include=everything`, tokens.admin)).status).toBe(400);
  });

  it('changes nothing', async () => {
    await call('GET', `${ANN}/export`, tokens.admin);
    expect(await count('audit_log')).toBe(0);
    expect(await count(`contacts WHERE id = 'cont_ann'`)).toBe(1);
  });
});

describe('erasure', () => {
  it('removes the contact and everything about them, and leaves others alone', async () => {
    expect((await call('DELETE', ANN, tokens.admin)).status).toBe(204);
    expect({
      contact: await count(`contacts WHERE id = 'cont_ann'`),
      browsers: await count(`visitors WHERE contact_id = 'cont_ann'`),
      conversations: await count(`conversations WHERE id = 'conv_ann'`),
      messages: await count(`messages WHERE conversation_id = 'conv_ann'`),
      files: await count(`attachments WHERE conversation_id = 'conv_ann'`),
      tags: await count(`contact_tags WHERE contact_id = 'cont_ann'`),
      unsubscribeLinks: await count(`email_unsubscribe_links WHERE token_hash = 't_ann'`),
      deliveries: await count(`email_deliveries WHERE id = 'ed_ann'`),
      failedJobs: await count(`failed_jobs WHERE id = 'fj_ann'`),
    }).toEqual({ contact: 0, browsers: 0, conversations: 0, messages: 0, files: 0, tags: 0, unsubscribeLinks: 0, deliveries: 0, failedJobs: 0 });
    expect({
      contact: await count(`contacts WHERE id = 'cont_bob'`),
      messages: await count(`messages WHERE conversation_id = 'conv_bob'`),
      tag: await count('tags'),
      link: await count(`email_unsubscribe_links WHERE token_hash = 't_bob'`),
      delivery: await count(`email_deliveries WHERE id = 'ed_bob'`),
      failedJob: await count(`failed_jobs WHERE id = 'fj_bob'`),
    }).toEqual({ contact: 1, messages: 1, tag: 1, link: 1, delivery: 1, failedJob: 1 });
  });

  it('keeps the suppression, so an address that opted out stays out', async () => {
    await call('DELETE', ANN, tokens.admin);
    expect(await count(`email_suppressions WHERE email = 'ann@example.com'`)).toBe(1);
  });

  it('deletes the files from storage, including one never sent', async () => {
    await call('DELETE', ANN, tokens.admin);
    expect((await testEnv.ATTACHMENTS.list({ prefix: 'w/work_1/c/conv_ann/' })).objects).toEqual([]);
    expect(await testEnv.ATTACHMENTS.head(key('conv_bob', 'att_bob'))).not.toBeNull();
    expect(await count(`outbox WHERE topic = 'contact.erased' AND dispatched_at IS NOT NULL`)).toBe(1);
  });

  it('records who did it, with IDs and nothing about the person', async () => {
    await call('DELETE', ANN, tokens.admin);
    const audit = await env.DB.prepare(`SELECT * FROM audit_log`).all<Record<string, unknown>>();
    expect(audit.results).toEqual([expect.objectContaining({ workspace_id: 'work_1', actor_type: 'user', actor_id: 'user_admin', action: 'contact.erased', target_type: 'contact', target_id: 'cont_ann', metadata_json: '{}' })]);
    const outbox = await env.DB.prepare(`SELECT payload_json AS p FROM outbox WHERE topic = 'contact.erased'`).first<{ p: string }>();
    expect(JSON.parse(outbox!.p)).toEqual({ conversationIds: ['conv_ann'] });
  });

  it('is gone afterwards: reading, exporting, or erasing again answers 404', async () => {
    await call('DELETE', ANN, tokens.admin);
    expect((await call('GET', ANN, tokens.admin)).status).toBe(404);
    expect((await call('GET', `${ANN}/export`, tokens.admin)).status).toBe(404);
    expect((await call('DELETE', ANN, tokens.admin)).status).toBe(404);
    expect((await call('GET', `${W}/conversations/conv_ann`, tokens.admin)).status).toBe(404);
  });

  it('erases nothing if the caller stops being an admin in between', async () => {
    await env.DB.prepare(`UPDATE users SET is_installation_admin = 0 WHERE id = 'user_admin'`).run();
    expect((await call('DELETE', ANN, tokens.admin)).status).toBe(403);
    expect(await count(`contacts WHERE id = 'cont_ann'`)).toBe(1);
    expect(await count('audit_log')).toBe(0);
  });
});
