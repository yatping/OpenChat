// Ported from the SQLite checks in the architecture review, now against generated migrations in workerd.
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { authorizeWorkspaceMember, openDatabase, repositories, type WorkspaceContext } from '../src/index';
import * as schema from '../src/schema/index';

const db = openDatabase(env.DB);
const d1 = env.DB;

// Plugin 1.x shares storage between tests in a file, so each test starts by clearing it.
async function seed() {
  await d1.batch(
    [
      `DELETE FROM workspaces`,
      `DELETE FROM users`,
      `DELETE FROM outbox`,
      `INSERT OR IGNORE INTO users (id,email,name,password_hash,created_at,updated_at) VALUES ('u1','one@x.test','One','!',1,1),('u2','two@x.test','Two','!',1,1),('u3','off@x.test','Off','!',1,1)`,
      `INSERT OR IGNORE INTO workspaces (id,name,slug,created_at,updated_at) VALUES ('w1','A','a',1,1),('w2','B','b',1,1)`,
      `INSERT OR IGNORE INTO workspace_members (id,workspace_id,user_id,role,created_at,updated_at) VALUES ('m1','w1','u1','owner',1,1),('m2','w2','u2','owner',1,1)`,
      `INSERT OR IGNORE INTO workspace_members (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ('m3','w1','u3','agent','suspended',1,1)`,
      `INSERT OR IGNORE INTO websites (id,workspace_id,name,website_key,created_at,updated_at) VALUES ('s1','w1','s','k1',1,1),('s2','w2','s','k2',1,1)`,
      `INSERT OR IGNORE INTO contacts (id,workspace_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES ('p1','w1',1,1,1,1),('p2','w2',1,1,1,1)`,
      `INSERT OR IGNORE INTO conversations (id,workspace_id,website_id,contact_id,created_at,updated_at) VALUES ('c1','w1','s1','p1',1,1),('c2','w2','s2','p2',1,1)`,
    ].map((s) => d1.prepare(s)),
  );
}

async function contextFor(user: string, workspace: string): Promise<WorkspaceContext> {
  const ctx = await authorizeWorkspaceMember(db, user, workspace);
  if (!ctx) throw new Error('expected a context');
  return ctx;
}

const count = async (table: string) =>
  (await d1.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

const member = { type: 'member', id: 'm1' } as const;

beforeEach(seed);

describe('schema', () => {
  const tables = Object.values(schema).filter((v) => is(v, SQLiteTable)) as SQLiteTable[];

  it('has workspace_id on every table outside the allowlist', () => {
    const missing = tables
      .filter((t) => !(schema.TABLES_WITHOUT_WORKSPACE as readonly string[]).includes(getTableName(t)))
      .filter((t) => !Object.values(getTableColumns(t)).some((c) => c.name === 'workspace_id'))
      .map(getTableName);
    expect(tables.length).toBeGreaterThanOrEqual(29);
    expect(missing).toEqual([]);
  });

  it('has an allowlist containing only real tables', () => {
    const names = tables.map(getTableName);
    for (const t of schema.TABLES_WITHOUT_WORKSPACE) expect(names).toContain(t);
  });

  it('applies case-insensitive email uniqueness', async () => {
    await expect(
      d1.prepare(`INSERT INTO users (id,email,name,password_hash,created_at,updated_at) VALUES ('u9','ONE@X.TEST','x','!',1,1)`).run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});

describe('tenancy enforced by the schema', () => {
  const rejected: [string, string][] = [
    ['a conversation using another tenant contact', `INSERT INTO conversations (id,workspace_id,website_id,contact_id,created_at,updated_at) VALUES ('cx','w1','s1','p2',1,1)`],
    ['a conversation using another tenant website', `INSERT INTO conversations (id,workspace_id,website_id,contact_id,created_at,updated_at) VALUES ('cx','w1','s2','p1',1,1)`],
    ['a conversation assigned to another tenant member', `INSERT INTO conversations (id,workspace_id,website_id,contact_id,assigned_member_id,created_at,updated_at) VALUES ('cx','w1','s1','p1','m2',1,1)`],
    ['a message in another tenant conversation', `INSERT INTO messages (id,workspace_id,conversation_id,seq,public_seq,sender_type,message_type,visibility,created_at) VALUES ('mx','w2','c1',1,1,'visitor','text','public',1)`],
  ];
  it.each(rejected)('rejects %s', async (_name, statement) => {
    await expect(d1.prepare(statement).run()).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('internal notes enforced by the schema', () => {
  const insert = (publicSeq: string, sender: string, type: string, visibility: string) =>
    d1.prepare(`INSERT INTO messages (id,workspace_id,conversation_id,seq,public_seq,sender_type,message_type,visibility,created_at) VALUES ('mz','w1','c1',500,${publicSeq},'${sender}','${type}','${visibility}',1)`).run();

  it('rejects a public internal note', () => expect(insert('1', 'member', 'internal_note', 'public')).rejects.toThrow(/CHECK/));
  it('rejects an internal text message', () => expect(insert('NULL', 'member', 'text', 'internal')).rejects.toThrow(/CHECK/));
  it('rejects a visitor-authored note', () => expect(insert('NULL', 'visitor', 'internal_note', 'internal')).rejects.toThrow(/CHECK/));
  it('rejects a note with a public sequence', () => expect(insert('1', 'member', 'internal_note', 'internal')).rejects.toThrow(/CHECK/));
  it('rejects a public message with no public sequence', () => expect(insert('NULL', 'member', 'text', 'public')).rejects.toThrow(/CHECK/));
});

describe('authorisation', () => {
  it('builds a context for an active member', async () => {
    expect(await contextFor('u1', 'w1')).toMatchObject({ workspaceId: 'w1', memberId: 'm1', role: 'owner' });
  });
  it('returns null across tenants', async () => expect(await authorizeWorkspaceMember(db, 'u1', 'w2')).toBeNull());
  it('returns null for a suspended member', async () => expect(await authorizeWorkspaceMember(db, 'u3', 'w1')).toBeNull());
  it('returns null for a disabled user', async () => {
    await d1.prepare(`UPDATE users SET disabled_at = 1 WHERE id = 'u1'`).run();
    expect(await authorizeWorkspaceMember(db, 'u1', 'w1')).toBeNull();
  });
});

describe('message sending (Pattern 1)', () => {
  const send = (ctx: WorkspaceContext, clientMessageId: string, type: 'text' | 'internal_note' = 'text', conversationId = 'c1') =>
    repositories(db, ctx).messages.send({ conversationId, clientMessageId, sender: member, type, content: `body ${clientMessageId}` });

  it('assigns sequences, and internal notes do not consume the public sequence', async () => {
    const ctx = await contextFor('u1', 'w1');
    const results = [await send(ctx, 'a'), await send(ctx, 'b', 'internal_note'), await send(ctx, 'c')];
    const seqs = results.map((r) => (r.outcome === 'created' ? [r.message.seq, r.message.publicSeq] : null));
    expect(seqs).toEqual([[1, 1], [2, null], [3, 2]]);
    const c = await repositories(db, ctx).conversations.get('c1');
    expect(c).toMatchObject({ lastMessageSeq: 3, lastPublicSeq: 2 });
    expect(await count('outbox')).toBe(3);
  });

  it('treats a replay as the original, changing nothing', async () => {
    const ctx = await contextFor('u1', 'w1');
    const first = await send(ctx, 'a');
    const version = (await repositories(db, ctx).conversations.get('c1'))!.version;
    const replay = await send(ctx, 'a');
    expect(replay.outcome).toBe('replayed');
    if (!('message' in first) || !('message' in replay)) throw new Error('unexpected');
    expect(replay.message.id).toBe(first.message.id);
    expect(await count('messages')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect((await repositories(db, ctx).conversations.get('c1'))!.version).toBe(version);
  });

  it('treats another tenant conversation as not found, writing nothing', async () => {
    const ctx = await contextFor('u2', 'w2');
    expect((await send(ctx, 'x', 'text', 'c1')).outcome).toBe('not_found');
    expect(await count('messages')).toBe(0);
    expect(await count('outbox')).toBe(0);
  });

  it('assigns a gapless order to concurrent sends', async () => {
    const ctx = await contextFor('u1', 'w1');
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => send(ctx, `client-${i}`)));
    expect(results.every((r) => r.outcome === 'created')).toBe(true);
    const seqs = (await repositories(db, ctx).messages.listAfter('c1', 0, 100)).map((m) => m.seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('creates one message when the same send races itself', async () => {
    const ctx = await contextFor('u1', 'w1');
    const results = await Promise.all(Array.from({ length: 10 }, () => send(ctx, 'same')));
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'replayed')).toHaveLength(9);
    expect(await count('messages')).toBe(1);
  });
});

describe('assignment (Pattern 2)', () => {
  it('updates and records one event', async () => {
    const ctx = await contextFor('u1', 'w1');
    expect(await repositories(db, ctx).conversations.assign('c1', 'm1', 1)).toEqual({ outcome: 'updated', version: 2 });
    expect(await count('conversation_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
  });

  it('writes no event for a stale version, the bug the design review caught', async () => {
    const ctx = await contextFor('u1', 'w1');
    const repo = repositories(db, ctx).conversations;
    await repo.assign('c1', 'm1', 1);
    expect(await repo.assign('c1', null, 1)).toEqual({ outcome: 'conflict', currentVersion: 2 });
    expect(await count('conversation_events')).toBe(1);
    expect(await count('outbox')).toBe(1);
    expect((await repo.get('c1'))!.assignedMemberId).toBe('m1');
  });

  it('lets exactly one of several concurrent writers win', async () => {
    const ctx = await contextFor('u1', 'w1');
    const repo = repositories(db, ctx).conversations;
    const results = await Promise.all(Array.from({ length: 10 }, () => repo.assign('c1', 'm1', 1)));
    expect(results.filter((r) => r.outcome === 'updated')).toHaveLength(1);
    expect(await count('conversation_events')).toBe(1);
  });

  it('treats another tenant conversation as not found', async () => {
    const ctx = await contextFor('u2', 'w2');
    expect(await repositories(db, ctx).conversations.assign('c1', 'm2', 1)).toEqual({ outcome: 'not_found' });
    expect((await d1.prepare(`SELECT version FROM conversations WHERE id='c1'`).first<{ version: number }>())!.version).toBe(1);
  });

  it('refuses an assignee in another tenant, and changes nothing', async () => {
    const ctx = await contextFor('u1', 'w1');
    expect(await repositories(db, ctx).conversations.assign('c1', 'm2', 1)).toEqual({ outcome: 'invalid_assignee' });
    expect(await count('conversation_events')).toBe(0);
    expect((await repositories(db, ctx).conversations.get('c1'))!.version).toBe(1);
  });
});

describe('scoped reads', () => {
  it('does not list another tenant websites', async () => {
    const list = await repositories(db, await contextFor('u1', 'w1')).websites.list();
    expect(list.map((s) => s.id)).toEqual(['s1']);
  });
  it('does not read another tenant conversation or its messages', async () => {
    const owner = await contextFor('u1', 'w1');
    await repositories(db, owner).messages.send({ conversationId: 'c1', clientMessageId: 'a', sender: member, type: 'text', content: 'secret' });
    const other = repositories(db, await contextFor('u2', 'w2'));
    expect(await other.conversations.get('c1')).toBeNull();
    expect(await other.messages.listAfter('c1', 0)).toEqual([]);
  });
  it('does not expose the raw handle from the public entry point', async () => {
    const api = await import('../src/index');
    expect(Object.keys(api)).not.toContain('rawHandle');
  });
});

describe('cascades', () => {
  it('removes a conversation and its children, including attachments that reference messages', async () => {
    const ctx = await contextFor('u1', 'w1');
    await repositories(db, ctx).messages.send({ conversationId: 'c1', clientMessageId: 'a', sender: member, type: 'text', content: 'x' });
    const m = await d1.prepare(`SELECT id FROM messages LIMIT 1`).first<{ id: string }>();
    await d1.prepare(`INSERT INTO attachments (id,workspace_id,conversation_id,message_id,storage_key,filename,content_type,size,uploaded_by_type,uploaded_by_id,created_at) VALUES ('a1','w1','c1',?1,'k','f','t',1,'member','m1',1)`).bind(m!.id).run();
    await d1.prepare(`DELETE FROM conversations WHERE id='c1'`).run();
    expect(await count('messages')).toBe(0);
    expect(await count('attachments')).toBe(0);
  });

  it('removes a workspace, leaving other tenants intact', async () => {
    const ctx = await contextFor('u1', 'w1');
    await repositories(db, ctx).messages.send({ conversationId: 'c1', clientMessageId: 'a', sender: member, type: 'text', content: 'x' });
    await d1.prepare(`DELETE FROM workspaces WHERE id='w1'`).run();
    for (const t of ['websites', 'contacts', 'conversations', 'workspace_members']) expect(await count(t)).toBe(1);
    expect(await count('messages')).toBe(0);
    expect((await d1.prepare(`SELECT workspace_id FROM conversations`).first<{ workspace_id: string }>())!.workspace_id).toBe('w2');
  });
});

describe('query plans', () => {
  const plan = async (q: string) =>
    (await d1.prepare(`EXPLAIN QUERY PLAN ${q}`).all<{ detail: string }>()).results.map((r) => r.detail).join(' | ');

  it.each([
    ['inbox', `SELECT id FROM conversations WHERE workspace_id='w1' AND status='open' AND (last_message_at,id)<(9,'z') ORDER BY last_message_at DESC,id DESC LIMIT 25`],
    ['assignee', `SELECT id FROM conversations WHERE workspace_id='w1' AND assigned_member_id='m' AND status='open' ORDER BY last_message_at DESC,id DESC LIMIT 25`],
    ['history', `SELECT id FROM messages WHERE workspace_id='w1' AND conversation_id='c1' AND seq<100 ORDER BY seq DESC LIMIT 50`],
    ['public history', `SELECT id FROM messages WHERE workspace_id='w1' AND conversation_id='c1' AND public_seq>0 ORDER BY public_seq LIMIT 50`],
    ['sync', `SELECT id FROM conversations WHERE workspace_id='w1' AND (updated_at,id)>(1,'a') ORDER BY updated_at,id LIMIT 100`],
    ['automation', `SELECT id FROM conversations WHERE next_automation_at<=5 AND next_automation_at IS NOT NULL ORDER BY next_automation_at LIMIT 100`],
    ['outbox', `SELECT id FROM outbox WHERE dispatched_at IS NULL AND created_at<5 ORDER BY created_at LIMIT 100`],
  ])('%s uses an index with no sort or scan', async (_name, q) => {
    const detail = await plan(q);
    expect(detail).toMatch(/SEARCH/);
    expect(detail).not.toMatch(/TEMP B-TREE|SCAN/);
  });
});
