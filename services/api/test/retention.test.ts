// Retention: a workspace's setting, and the hourly sweep. See docs/architecture/data-model.md#retention.
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { openDatabase } from '@openchat/database';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepOutbox } from '../src/dispatch';
import type { Env } from '../src/env';
import worker from '../src/index';
import { sweepRetention } from '../src/retention';

const ORIGIN = 'https://chat.example.com';
const PASSWORD = 'correct horse battery';
const testEnv = env as unknown as Env;
const DAY = 86_400_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const RETENTION = '/api/v1/admin/workspaces/work_1/retention';

let counter = 0;
const call = (method: string, path: string, token: string, body?: unknown) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'cf-connecting-ip': `203.0.113.${++counter % 250}`, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    createExecutionContext(),
  );

const TABLES = ['failed_jobs', 'job_receipts', 'auth_tokens', 'email_deliveries', 'email_unsubscribe_links', 'audit_log', 'outbox', 'attachments', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'];
const ids = async (table: string) => (await env.DB.prepare(`SELECT ${table === 'job_receipts' ? 'idempotency_key' : table === 'auth_tokens' ? 'token_hash' : table === 'email_unsubscribe_links' ? 'token_hash' : 'id'} AS id FROM ${table} ORDER BY 1`).all<{ id: string }>()).results.map((r) => r.id);
const fileKey = (workspace: string, conversation: string) => `w/${workspace}/c/${conversation}/att_${conversation}`;

let hash = '';
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

/**
 * work_1 keeps closed conversations for 30 days; work_2 keeps everything. `ago(n)` is n days before now.
 */
async function seed() {
  const now = Date.now();
  const ago = (days: number) => now - days * DAY;
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const conversations: [string, string, string, string, number][] = [
    // id, workspace, contact, status, last message
    ['conv_old_closed', 'work_1', 'cont_gone', 'resolved', ago(40)],
    ['conv_old_archived', 'work_1', 'cont_gone', 'archived', ago(31)],
    ['conv_old_open', 'work_1', 'cont_open', 'open', ago(400)],
    ['conv_recent', 'work_1', 'cont_recent', 'resolved', ago(5)],
    ['conv_other', 'work_2', 'cont_other', 'resolved', ago(400)],
  ];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, retention_days, created_at, updated_at) VALUES ('work_1', 'One', 'one', 30, 1, 1), ('work_2', 'Two', 'two', NULL, 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES ('user_admin', 'admin@example.com', 'Admin', ?1, 1, 1, 1), ('user_owner', 'owner@example.com', 'Owner', ?1, 0, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_owner', 'work_1', 'user_owner', 'supervisor', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_1', 1, 1), ('site_2', 'work_2', 'Shop', 'key_2', 1, 1)`),
    env.DB.prepare(
      `INSERT INTO contacts (id, workspace_id, email, merged_into_contact_id, first_seen_at, last_seen_at, created_at, updated_at) VALUES
       ('cont_gone', 'work_1', 'gone@example.com', NULL, 1, ?1, 1, 1),
       ('cont_open', 'work_1', 'open@example.com', NULL, 1, ?1, 1, 1),
       ('cont_recent', 'work_1', 'recent@example.com', 'cont_gone', 1, ?2, 1, 1),
       ('cont_quiet', 'work_1', 'quiet@example.com', NULL, 1, ?3, 1, 1),
       ('cont_other', 'work_2', 'other@example.com', NULL, 1, ?1, 1, 1),
       ('cont_anon_old', 'work_2', NULL, NULL, 1, ?1, 1, 1),
       ('cont_anon_new', 'work_2', NULL, NULL, 1, ?3, 1, 1),
       ('cont_named_old', 'work_2', 'named@example.com', NULL, 1, ?1, 1, 1)`,
    ).bind(ago(40), ago(5), ago(10)),
    env.DB.prepare(`INSERT INTO visitors (id, workspace_id, website_id, contact_id, refresh_token_hash, created_at, last_seen_at) VALUES ('vis_gone', 'work_1', 'site_1', 'cont_gone', 'h_gone', 1, ?1), ('vis_anon', 'work_2', 'site_2', 'cont_anon_old', 'h_anon', 1, ?1)`).bind(ago(40)),
    ...conversations.flatMap(([id, workspace, contact, status, at]) => [
      env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, status, last_message_seq, last_public_seq, last_message_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?6, ?6)`)
        .bind(id, workspace, workspace === 'work_1' ? 'site_1' : 'site_2', contact, status, at),
      env.DB.prepare(`INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, sender_type, sender_id, message_type, visibility, content, created_at) VALUES (?1, ?2, ?3, 1, 1, 'visitor', 'vis', 'text', 'public', 'Hello', ?4)`)
        .bind(`msg_${id}`, workspace, id, at),
      env.DB.prepare(
        `INSERT INTO attachments (id, workspace_id, conversation_id, message_id, storage_key, filename, content_type, size, status, uploaded_by_type, uploaded_by_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'a.png', 'image/png', 11, 'ready', 'visitor', 'vis', ?6)`,
      ).bind(`att_${id}`, workspace, id, `msg_${id}`, fileKey(workspace, id), at),
    ]),
    env.DB.prepare(
      `INSERT INTO failed_jobs (id, workspace_id, queue, job_type, idempotency_key, attempts, envelope_json, failed_at) VALUES
       ('fjob_closed', 'work_1', 'oc-test-jobs', 'automation.evaluate', 'k1', 5, '{"payload":{"conversationId":"conv_old_closed"}}', ?1),
       ('fjob_recent', 'work_1', 'oc-test-jobs', 'automation.evaluate', 'k2', 5, '{"payload":{"conversationId":"conv_recent"}}', ?1),
       ('fjob_ancient', 'work_2', 'oc-test-jobs', 'automation.evaluate', 'k3', 5, '{"payload":{"conversationId":"conv_other"}}', ?2)`,
    ).bind(ago(1), ago(91)),
    env.DB.prepare(`INSERT INTO email_unsubscribe_links (token_hash, workspace_id, email, created_at) VALUES ('t_gone', 'work_1', 'GONE@example.com', ?1), ('t_open', 'work_1', 'open@example.com', ?1), ('t_new', 'work_1', 'new@example.com', ?2), ('t_other', 'work_2', 'x@example.com', ?1)`).bind(ago(40), ago(1)),
    env.DB.prepare(
      `INSERT INTO email_deliveries (id, workspace_id, dedupe_key, template, recipient_hash, status, created_at, updated_at) VALUES
       ('ed_old', 'work_1', 'a', 'follow_up', 'h', 'sent', ?1, ?1), ('ed_new', 'work_1', 'b', 'follow_up', 'h', 'sent', ?2, ?2), ('ed_other', 'work_2', 'c', 'follow_up', 'h', 'sent', ?1, ?1)`,
    ).bind(ago(40), ago(1)),
    env.DB.prepare(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, client_type, created_at, last_used_at, expires_at) VALUES
       ('sess_expired', 'user_owner', 'r1', 'mobile', 1, 1, ?1), ('sess_live', 'user_owner', 'r2', 'mobile', 1, 1, ?2)`,
    ).bind(ago(1), now + DAY),
    env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ('tok_expired', 'user_owner', 'password_reset', ?1), ('tok_live', 'user_owner', 'password_reset', ?2)`).bind(ago(1), now + DAY),
    env.DB.prepare(`INSERT INTO job_receipts (idempotency_key, job_type, status, claimed_at) VALUES ('rcpt_old', 'system.heartbeat', 'done', ?1), ('rcpt_new', 'system.heartbeat', 'done', ?2)`).bind(ago(15), ago(13)),
  ]);
  await Promise.all(conversations.map(([id, workspace]) => testEnv.ATTACHMENTS.put(fileKey(workspace, id), PNG)));
}

beforeEach(seed);

describe('the retention sweep', () => {
  it('deletes closed conversations past the workspace retention, with their messages, files and failed jobs', async () => {
    await sweepRetention(openDatabase(env.DB));
    expect(await ids('conversations')).toEqual(['conv_old_open', 'conv_other', 'conv_recent']);
    expect(await ids('messages')).toEqual(['msg_conv_old_open', 'msg_conv_other', 'msg_conv_recent']);
    expect(await ids('attachments')).toEqual(['att_conv_old_open', 'att_conv_other', 'att_conv_recent']);
    expect(await ids('failed_jobs')).toEqual(['fjob_recent']);

    const audit = await env.DB.prepare(`SELECT workspace_id AS workspaceId, actor_type AS actorType, action, metadata_json AS metadata FROM audit_log ORDER BY action`).all();
    expect(audit.results).toEqual([
      { workspaceId: 'work_1', actorType: 'system', action: 'contacts.expired', metadata: '{"contacts":1,"retentionDays":30}' },
      { workspaceId: 'work_1', actorType: 'system', action: 'conversations.expired', metadata: '{"conversations":2,"retentionDays":30}' },
    ]);

    // Files go through the outbox, as for erasure.
    const outbox = await env.DB.prepare(`SELECT topic, payload_json AS payload FROM outbox`).first<{ topic: string; payload: string }>();
    expect(outbox?.topic).toBe('conversations.expired');
    expect((JSON.parse(outbox!.payload) as { conversationIds: string[] }).conversationIds.sort()).toEqual(['conv_old_archived', 'conv_old_closed']);
    await env.DB.prepare(`UPDATE outbox SET created_at = created_at - 120000`).run();
    await sweepOutbox(testEnv, Date.UTC(2026, 0, 1, 0, 30));
    expect(await testEnv.ATTACHMENTS.get(fileKey('work_1', 'conv_old_closed'))).toBeNull();
    expect(await testEnv.ATTACHMENTS.get(fileKey('work_1', 'conv_old_archived'))).toBeNull();
    expect(await testEnv.ATTACHMENTS.get(fileKey('work_1', 'conv_recent'))).not.toBeNull();
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM outbox WHERE dispatched_at IS NULL`).first('n')).toBe(0);
  });

  it('then deletes contacts left with nothing, and old email records, but keeps addresses still in use', async () => {
    await sweepRetention(openDatabase(env.DB));
    // cont_gone lost its conversations. cont_quiet has none, but was seen within 30 days.
    expect((await ids('contacts')).filter((id) => id !== 'cont_anon_new')).toEqual(['cont_named_old', 'cont_open', 'cont_other', 'cont_quiet', 'cont_recent']);
    expect(await ids('visitors')).toEqual([]);
    expect(await env.DB.prepare(`SELECT merged_into_contact_id AS m FROM contacts WHERE id = 'cont_recent'`).first('m')).toBeNull();
    expect(await ids('email_unsubscribe_links')).toEqual(['t_new', 't_open', 't_other']);
    expect(await ids('email_deliveries')).toEqual(['ed_new', 'ed_other']);
  });

  it('keeps everything in a workspace without retention, except what every installation tidies', async () => {
    await sweepRetention(openDatabase(env.DB));
    expect(await ids('auth_sessions')).toEqual(['sess_live']);
    expect(await ids('auth_tokens')).toEqual(['tok_live']);
    expect(await ids('job_receipts')).toEqual(['rcpt_new']);
    // A visitor who never wrote and gave no address goes after 30 days. One with an address stays.
    expect((await ids('contacts')).filter((id) => id.startsWith('cont_anon') || id === 'cont_named_old' || id === 'cont_other')).toEqual(['cont_anon_new', 'cont_named_old', 'cont_other']);
    expect(await ids('conversations')).toContain('conv_other');
  });

  it('leaves alone a workspace whose retention was removed', async () => {
    await env.DB.prepare(`UPDATE workspaces SET retention_days = NULL WHERE id = 'work_1'`).run();
    await sweepRetention(openDatabase(env.DB));
    expect(await ids('conversations')).toHaveLength(5);
    expect(await ids('outbox')).toEqual([]);
  });

  it('is safe to run again', async () => {
    await sweepRetention(openDatabase(env.DB));
    const after = await ids('conversations');
    await sweepRetention(openDatabase(env.DB));
    expect(await ids('conversations')).toEqual(after);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM outbox`).first('n')).toBe(1);
  });
});

describe('the retention setting', () => {
  const signIn = async (email: string) =>
    ((await (
      await worker.fetch(
        new Request(`${ORIGIN}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${++counter % 250}` }, body: JSON.stringify({ email, password: PASSWORD, clientType: 'mobile' }) }),
        testEnv,
        createExecutionContext(),
      )
    ).json()) as { accessToken: string }).accessToken;

  it('is read and set by an installation admin, and audited', async () => {
    const admin = await signIn('admin@example.com');
    expect(await (await call('GET', RETENTION, admin)).json()).toEqual({ retentionDays: 30 });
    const set = await call('PUT', RETENTION, admin, { retentionDays: 365 });
    expect([set.status, await set.json()]).toEqual([200, { retentionDays: 365 }]);
    expect(await (await call('PUT', RETENTION, admin, { retentionDays: null })).json()).toEqual({ retentionDays: null });
    expect(await env.DB.prepare(`SELECT retention_days AS d FROM workspaces WHERE id = 'work_1'`).first('d')).toBeNull();
    const audit = await env.DB.prepare(`SELECT actor_id AS actor, metadata_json AS metadata FROM audit_log WHERE action = 'workspace.retention_changed' ORDER BY created_at, id`).all();
    expect(audit.results).toEqual([
      { actor: 'user_admin', metadata: '{"from":30,"to":365}' },
      { actor: 'user_admin', metadata: '{"from":365,"to":null}' },
    ]);
  });

  it('refuses less than 30 days, more than ten years, and an unknown workspace', async () => {
    const admin = await signIn('admin@example.com');
    for (const retentionDays of [7, 29, 3651, 30.5]) expect([retentionDays, (await call('PUT', RETENTION, admin, { retentionDays })).status]).toEqual([retentionDays, 400]);
    expect((await call('PUT', '/api/v1/admin/workspaces/work_nope/retention', admin, { retentionDays: 90 })).status).toBe(404);
    expect((await call('GET', '/api/v1/admin/workspaces/work_nope/retention', admin)).status).toBe(404);
  });

  it('is not there for a supervisor of the workspace', async () => {
    const owner = await signIn('owner@example.com');
    expect((await call('GET', RETENTION, owner)).status).toBe(404);
    expect((await call('PUT', RETENTION, owner, { retentionDays: 90 })).status).toBe(404);
    expect(await env.DB.prepare(`SELECT retention_days AS d FROM workspaces WHERE id = 'work_1'`).first('d')).toBe(30);
  });
});
