import { createExecutionContext, runDurableObjectAlarm, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { hashPassword } from '@openchat/auth';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleScheduled } from '../src/background';
import type { Env } from '../src/env';
import worker from '../src/index';

const ORIGIN = 'https://chat.example.com';
const SITE = 'https://shop.example';
const PASSWORD = 'correct horse battery';
const W = '/api/v1/workspaces/work_1';
const testEnv = env as unknown as Env;

let counter = 0;
/** Waits for waitUntil, so that a test sees what dispatch did. */
async function call(method: string, path: string, options: { token?: string; body?: unknown; origin?: string | null; wait?: boolean } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        'cf-connecting-ip': `203.0.113.${++counter}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;

interface Frame { type: string; data: Record<string, never> }
const open: WebSocket[] = [];

/** Connects, and holds the frames. `next` waits for one of a type, and `silence` proves that none arrives. */
async function connect(ticketUrl: string, origin?: string) {
  const ticket = new URL(ticketUrl).searchParams.get('ticket')!;
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/v1/realtime/connect?ticket=${encodeURIComponent(ticket)}`, { headers: { upgrade: 'websocket', ...(origin ? { origin } : {}) } }),
    testEnv,
    createExecutionContext(),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  open.push(socket);
  const frames: Frame[] = [];
  const state = { closed: null as number | null };
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(event.data as string) as Frame);
  });
  socket.addEventListener('close', (event) => {
    state.closed = event.code;
  });
  const until = async (test: () => boolean, what: string) => {
    for (const started = Date.now(); !test(); ) {
      if (Date.now() - started > 3000) throw new Error(`Timed out waiting for ${what}. Saw: ${frames.map((f) => f.type).join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    socket,
    frames,
    state,
    next: async (type: string) => {
      await until(() => frames.some((f) => f.type === type), type);
      return frames.splice(frames.findIndex((f) => f.type === type), 1)[0]!;
    },
    closed: async () => {
      await until(() => state.closed !== null, 'close');
      return state.closed;
    },
  };
}

let hash = '';
let agent = '';
let visitor = '';
let conversationId = '';

const agentSocket = async () => {
  const ticket = await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: agent }));
  const socket = await connect(ticket.url);
  await socket.next('hello');
  return socket;
};
const visitorSocket = async () => {
  const ticket = await json<{ url: string }>(await call('POST', `/api/v1/widget/conversations/${conversationId}/realtime/tickets`, { token: visitor, origin: SITE }));
  const socket = await connect(ticket.url, SITE);
  await socket.next('hello');
  return socket;
};
const agentSend = (clientMessageId: string, type = 'text', content = 'Agent words') => call('POST', `${W}/conversations/${conversationId}/messages`, { token: agent, body: { clientMessageId, type, content } });
const visitorSend = (clientMessageId: string, content = 'Visitor words') => call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token: visitor, origin: SITE, body: { clientMessageId, content } });
const pending = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE dispatched_at IS NULL`).first<{ n: number }>())!.n;

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await env.DB.batch(['outbox', 'audit_log', 'conversation_read_cursors', 'conversation_events', 'messages', 'conversations', 'visitors', 'contacts', 'websites', 'workspace_members', 'auth_sessions', 'workspaces', 'users', 'installation'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_test', 'Test', '${ORIGIN}', 1, 1)`),
    env.DB.prepare(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES ('work_1', 'One', 'one', 1, 1), ('work_2', 'Two', 'two', 1, 1)`),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('user_a', 'agent@example.com', 'Ana Agent', ?1, 1, 1), ('user_b', 'other@example.com', 'Bo Other', ?1, 1, 1), ('user_c', 'peer@example.com', 'Cy Peer', ?1, 1, 1)`).bind(hash),
    env.DB.prepare(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_a', 'work_1', 'user_a', 'owner', 'active', 1, 1), ('mem_b', 'work_2', 'user_b', 'owner', 'active', 1, 1), ('mem_c', 'work_1', 'user_c', 'agent', 'active', 1, 1)`),
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_1', 'work_1', 'Shop', 'key_rt', ?1, 1, 1)`).bind(JSON.stringify([SITE])),
  ]);
  agent = (await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'agent@example.com', password: PASSWORD, clientType: 'mobile' } }))).accessToken;
  const session = await json<{ accessToken: string }>(await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_rt' }, origin: SITE }));
  visitor = session.accessToken;
  conversationId = (await json<{ id: string }>(await call('POST', '/api/v1/widget/conversations', { token: visitor, origin: SITE, body: { clientMessageId: 'first-message', content: 'Hello' } }))).id;
});

afterEach(() => {
  for (const socket of open.splice(0)) {
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }
});

describe('tickets', () => {
  const connectWith = (ticket: string, headers: Record<string, string> = { upgrade: 'websocket' }) =>
    worker.fetch(new Request(`${ORIGIN}/api/v1/realtime/connect?ticket=${encodeURIComponent(ticket)}`, { headers }), testEnv, createExecutionContext());
  const agentTicket = async () => json<{ ticket: string; url: string; expiresAt: string }>(await call('POST', `${W}/realtime/tickets`, { token: agent }));

  it('gives a URL for this installation, with a short life', async () => {
    const { url, expiresAt } = await agentTicket();
    expect(url.startsWith('wss://chat.example.com/api/v1/realtime/connect?ticket=')).toBe(true);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30_000);
  });

  it('refuses a made-up or altered ticket', async () => {
    const { ticket } = await agentTicket();
    expect((await connectWith('not.a.ticket')).status).toBe(401);
    const parts = ticket.split('.');
    const claims = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const forged = btoa(JSON.stringify({ ...claims, wid: 'work_2' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await connectWith(`${parts[0]}.${forged}.${parts[2]}`)).status).toBe(401);
  });

  it('refuses an access token or a visitor token used as a ticket', async () => {
    expect((await connectWith(agent)).status).toBe(401);
    expect((await connectWith(visitor)).status).toBe(401);
  });

  it('refuses a ticket used as an access token', async () => {
    const { ticket } = await agentTicket();
    expect((await call('GET', '/api/v1/me', { token: ticket })).status).toBe(401);
    expect((await call('GET', '/api/v1/widget/conversations', { token: ticket, origin: SITE })).status).toBe(401);
  });

  it('refuses a request that is not an upgrade', async () => {
    const { ticket } = await agentTicket();
    expect((await connectWith(ticket, {})).status).toBe(426);
  });

  it('must connect from the page that asked for it', async () => {
    const { ticket } = await json<{ ticket: string }>(await call('POST', `/api/v1/widget/conversations/${conversationId}/realtime/tickets`, { token: visitor, origin: SITE }));
    expect((await connectWith(ticket, { upgrade: 'websocket', origin: 'https://evil.example' })).status).toBe(403);
    expect((await connectWith(ticket)).status).toBe(403);
    const socket = await connectWith(ticket, { upgrade: 'websocket', origin: SITE });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    open.push(socket.webSocket!);
  });

  it("refuses a visitor a ticket for someone else's conversation", async () => {
    const other = await json<{ accessToken: string }>(await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_rt' }, origin: SITE }));
    expect((await call('POST', `/api/v1/widget/conversations/${conversationId}/realtime/tickets`, { token: other.accessToken, origin: SITE })).status).toBe(404);
  });
});

describe('live delivery', () => {
  it('reaches an agent, including notes, and a visitor, without them', async () => {
    const [a, v] = [await agentSocket(), await visitorSocket()];
    expect((await visitorSend('from-visitor')).status).toBe(201);
    expect((await a.next('message.created')).data).toMatchObject({ workspaceId: 'work_1', message: { content: 'Visitor words', seq: 2, sender: { type: 'visitor' } } });
    expect((await v.next('message.created')).data).toMatchObject({ message: { content: 'Visitor words', seq: 2 } });

    expect((await agentSend('from-agent-note', 'internal_note', 'SECRET')).status).toBe(201);
    expect((await a.next('message.created')).data).toMatchObject({ message: { content: 'SECRET', visibility: 'internal', publicSeq: null } });

    expect((await agentSend('from-agent-reply')).status).toBe(201);
    // Published after the note, so its arrival proves that the note was not simply still on its way.
    const reply = (await v.next('message.created')).data as unknown as { message: Record<string, unknown> };
    expect(reply.message).toMatchObject({ content: 'Agent words', seq: 3, sender: { type: 'member', displayName: null }, clientMessageId: null });
    expect(Object.keys(reply.message).sort()).toEqual(['attachments', 'clientMessageId', 'content', 'conversationId', 'createdAt', 'id', 'sender', 'seq', 'type']);
    expect(JSON.stringify(v.frames)).not.toContain('SECRET');
  });

  it('shows agent names to a visitor only when the website chooses to', async () => {
    await env.DB.prepare(`UPDATE websites SET settings_json = '{"showAgentNames":true}' WHERE id = 'site_1'`).run();
    const v = await visitorSocket();
    await agentSend('from-agent-reply');
    expect((await v.next('message.created')).data).toMatchObject({ message: { sender: { type: 'member', displayName: 'Ana Agent' } } });
  });

  it('tells a visitor only about status, from a change to the conversation', async () => {
    const [a, v] = [await agentSocket(), await visitorSocket()];
    const { version } = await json<{ version: number }>(await call('GET', `${W}/conversations/${conversationId}`, { token: agent }));
    expect((await call('PATCH', `${W}/conversations/${conversationId}`, { token: agent, body: { expectedVersion: version, status: 'resolved', assignedMemberId: 'mem_a' } })).status).toBe(200);
    expect((await a.next('conversation.updated')).data).toMatchObject({ conversation: { id: conversationId, status: 'resolved', assignedMemberId: 'mem_a', version: version + 1 } });
    const status = await v.next('conversation.status');
    expect(status.data).toEqual({ conversationId, status: 'resolved' });
  });

  it('announces a new conversation to agents', async () => {
    const a = await agentSocket();
    const session = await json<{ accessToken: string }>(await call('POST', '/api/v1/widget/sessions', { body: { websiteKey: 'key_rt' }, origin: SITE }));
    const { id } = await json<{ id: string }>(await call('POST', '/api/v1/widget/conversations', { token: session.accessToken, origin: SITE, body: { clientMessageId: 'second-visitor', content: 'Hi' } }));
    expect((await a.next('conversation.created')).data).toMatchObject({ conversation: { id } });
    expect((await a.next('message.created')).data).toMatchObject({ message: { conversationId: id, seq: 1 } });
  });

  it('stays within the workspace', async () => {
    const other = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'other@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const ticket = await json<{ url: string }>(await call('POST', '/api/v1/workspaces/work_2/realtime/tickets', { token: other.accessToken }));
    const outsider = await connect(ticket.url);
    await outsider.next('hello');
    const a = await agentSocket();
    await visitorSend('from-visitor');
    await a.next('message.created');
    expect(outsider.frames).toEqual([]);
  });

  it('marks what it dispatched, so that the sweep has nothing to repeat', async () => {
    await visitorSend('from-visitor');
    expect(await pending()).toBe(0);
  });
});

describe('the outbox sweep', () => {
  const makeStale = () => env.DB.prepare(`UPDATE outbox SET dispatched_at = NULL, created_at = created_at - 120000`).run();

  it('delivers what a dying isolate left behind', async () => {
    const a = await agentSocket();
    await visitorSend('from-visitor');
    await a.next('message.created');
    await makeStale();
    await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, testEnv);
    // Every row was left behind, so the sweep sends both messages again, in order.
    expect((await a.next('message.created')).data).toMatchObject({ message: { content: 'Hello' } });
    expect((await a.next('message.created')).data).toMatchObject({ message: { content: 'Visitor words' } });
    expect(await pending()).toBe(0);
  });

  it('leaves recent rows to the fast path', async () => {
    await visitorSend('from-visitor');
    await env.DB.prepare(`UPDATE outbox SET dispatched_at = NULL`).run();
    await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, testEnv);
    expect(await pending()).toBe(3);
  });

  it('keeps a row it cannot understand, counts the attempt, and carries on with the rest', async () => {
    await env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at) VALUES ('obx_new', 'work_1', 'from.the.future', 'x', '{}', 1)`).run();
    await visitorSend('from-visitor');
    await makeStale();
    await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, testEnv);
    expect(await env.DB.prepare(`SELECT attempts, dispatched_at FROM outbox WHERE id = 'obx_new'`).first()).toEqual({ attempts: 1, dispatched_at: null });
    expect(await pending()).toBe(1);
  });

  it('is not blocked by rows it keeps failing on', async () => {
    await env.DB.batch(
      Array.from({ length: 200 }, (_, n) => env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at, attempts) VALUES (?1, 'work_1', 'from.the.future', 'x', '{}', 1, 3)`).bind(`obx_bad_${n}`)),
    );
    await visitorSend('from-visitor');
    await env.DB.prepare(`UPDATE outbox SET dispatched_at = NULL, created_at = 2 WHERE topic = 'message.created'`).run();
    await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, testEnv);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE topic = 'message.created' AND dispatched_at IS NULL`).first()).toEqual({ n: 0 });
  });

  it('purges old dispatched rows, on the hour only, and never a pending one', async () => {
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(`INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at, dispatched_at) VALUES ('obx_old', 'work_1', 'message.created', 'x', '{}', ?1, ?1), ('obx_recent', 'work_1', 'message.created', 'x', '{}', ?1, ?2)`).bind(old, Date.now()).run();
    await handleScheduled({ scheduledTime: Date.UTC(2026, 0, 1, 10, 5) } as ScheduledController, testEnv);
    expect(await env.DB.prepare(`SELECT id FROM outbox WHERE id = 'obx_old'`).first()).not.toBeNull();
    await handleScheduled({ scheduledTime: Date.UTC(2026, 0, 1, 11, 0) } as ScheduledController, testEnv);
    expect(await env.DB.prepare(`SELECT id FROM outbox WHERE id = 'obx_old'`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM outbox WHERE id = 'obx_recent'`).first()).not.toBeNull();
  });

  it('a replay finishes a dispatch that died', async () => {
    await visitorSend('from-visitor');
    await env.DB.prepare(`UPDATE outbox SET dispatched_at = NULL WHERE topic = 'message.created'`).run();
    const a = await agentSocket();
    expect((await visitorSend('from-visitor')).status).toBe(200);
    await a.next('message.created');
  });
});

describe('losing access', () => {
  const peerSocket = async () => {
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const ticket = await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: accessToken }));
    const socket = await connect(ticket.url);
    await socket.next('hello');
    return socket;
  };

  it('closes the sockets of a removed member', async () => {
    const peer = await peerSocket();
    const other = await agentSocket();
    expect((await call('DELETE', `${W}/members/mem_c`, { token: agent })).status).toBe(204);
    expect(await peer.closed()).toBe(4403);
    expect(other.state.closed).toBeNull();
  });

  it('closes them on a role change or suspension, and a suspended member gets no new ticket', async () => {
    const peer = await peerSocket();
    expect((await call('PATCH', `${W}/members/mem_c`, { token: agent, body: { status: 'suspended' } })).status).toBe(200);
    expect(await peer.closed()).toBe(4403);
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    expect((await call('POST', `${W}/realtime/tickets`, { token: accessToken })).status).toBe(404);
  });
});

describe('losing an account', () => {
  it('closes its sockets within a sweep, because the outbox row is part of the deletion', async () => {
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const ticket = await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: accessToken }));
    const peer = await connect(ticket.url);
    await peer.next('hello');
    expect((await call('POST', '/api/v1/me/delete', { token: accessToken, body: { password: PASSWORD } })).status).toBe(204);
    await env.DB.prepare(`UPDATE outbox SET created_at = created_at - 120000 WHERE topic = 'member.access_changed'`).run();
    await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, testEnv);
    expect(await peer.closed()).toBe(4403);
  });
});

describe('frames from clients', () => {
  const send = (s: { socket: WebSocket }, type: string, data: unknown) => s.socket.send(JSON.stringify({ v: 1, type, data }));
  const peerSocket = async () => {
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const ticket = await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: accessToken }));
    const socket = await connect(ticket.url);
    await socket.next('hello');
    return socket;
  };

  it('passes agent typing to other agents and the visitor, with no name', async () => {
    const [a, peer, v] = [await agentSocket(), await peerSocket(), await visitorSocket()];
    send(a, 'typing.set', { conversationId, isTyping: true });
    expect((await peer.next('typing')).data).toEqual({ conversationId, actor: { type: 'member', id: 'mem_a', displayName: null } });
    expect((await v.next('typing')).data).toEqual({ conversationId, displayName: null });
    expect(a.frames.some((f) => f.type === 'typing')).toBe(false);
  });

  it('keeps typing a note from the visitor', async () => {
    const [a, peer, v] = [await agentSocket(), await peerSocket(), await visitorSocket()];
    send(a, 'typing.set', { conversationId, isTyping: true, internal: true });
    await peer.next('typing');
    // Goes through the same room, so its arrival proves that the note's typing was not on its way.
    await agentSend('agent-reply-after');
    await v.next('message.created');
    expect(v.frames.some((f) => f.type === 'typing')).toBe(false);
  });

  it('passes visitor typing to agents, only for their own conversation', async () => {
    const [a, v] = [await agentSocket(), await visitorSocket()];
    send(v, 'typing.set', { conversationId: 'conv_someone_else', isTyping: true });
    expect((await v.next('error')).data).toEqual({ code: 'forbidden' });
    expect(a.frames.some((f) => f.type === 'typing')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    send(v, 'typing.set', { conversationId, isTyping: true });
    expect((await a.next('typing')).data).toMatchObject({ conversationId, actor: { type: 'visitor', displayName: null } });
  });

  it('drops typing that comes too fast, or that says it has stopped', async () => {
    const [a, peer] = [await agentSocket(), await peerSocket()];
    send(a, 'typing.set', { conversationId, isTyping: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(peer.frames.filter((f) => f.type === 'typing')).toEqual([]);
    send(a, 'typing.set', { conversationId, isTyping: true });
    send(a, 'typing.set', { conversationId, isTyping: true });
    send(a, 'typing.set', { conversationId, isTyping: true });
    await peer.next('typing');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(peer.frames.filter((f) => f.type === 'typing')).toEqual([]);
  });

  it('answers a bad frame, ignores an unknown one, and closes a flood', async () => {
    const a = await agentSocket();
    a.socket.send('not json');
    expect((await a.next('error')).data).toEqual({ code: 'invalid_frame' });
    send(a, 'typing.set', { conversationId: 5, isTyping: true });
    expect((await a.next('error')).data).toEqual({ code: 'invalid_frame' });
    send(a, 'from.the.future', {});
    for (let n = 0; n < 25; n++) send(a, 'from.the.future', {});
    expect(await a.closed()).toBe(4429);
  });

  it('closes a frame too large to be anything legitimate', async () => {
    const a = await agentSocket();
    a.socket.send('x'.repeat(9000));
    expect(await a.closed()).toBe(1009);
  });

  describe('auth.refresh', () => {
    const newTicket = async (path: string, token: string, origin?: string) => (await json<{ ticket: string }>(await call('POST', path, origin ? { token, origin } : { token }))).ticket;
    const agentPath = `${W}/realtime/tickets`;

    it('extends a live socket, and says so', async () => {
      const a = await agentSocket();
      send(a, 'auth.refresh', { ticket: await newTicket(agentPath, agent) });
      const first = new Date(String((await a.next('hello')).data.authExpiresAt)).getTime();
      expect(first).toBeGreaterThan(Date.now() + 14 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      send(a, 'auth.refresh', { ticket: await newTicket(agentPath, agent) });
      expect(new Date(String((await a.next('hello')).data.authExpiresAt)).getTime()).toBeGreaterThan(first);
    });

    it("refuses another person's ticket, or one for another scope, and changes nothing", async () => {
      const a = await agentSocket();
      const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
      send(a, 'auth.refresh', { ticket: await newTicket(agentPath, accessToken) });
      expect((await a.next('error')).data).toEqual({ code: 'forbidden' });
      send(a, 'auth.refresh', { ticket: 'not.a.ticket' });
      expect((await a.next('error')).data).toEqual({ code: 'forbidden' });
      const v = await visitorSocket();
      send(v, 'auth.refresh', { ticket: await newTicket(agentPath, agent) });
      expect((await v.next('error')).data).toEqual({ code: 'forbidden' });
      send(v, 'auth.refresh', { ticket: await newTicket(`/api/v1/widget/conversations/${conversationId}/realtime/tickets`, visitor) });
      expect((await v.next('error')).data).toEqual({ code: 'forbidden' });
      send(v, 'auth.refresh', { ticket: await newTicket(`/api/v1/widget/conversations/${conversationId}/realtime/tickets`, visitor, SITE) });
      await v.next('hello');
    });
  });
});

describe('presence', () => {
  it('tells agents who else is here, and when a member goes', async () => {
    const a = await agentSocket();
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const ticket = await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: accessToken }));
    const peer = await connect(ticket.url);
    expect((await a.next('presence.member')).data).toEqual({ memberId: 'mem_c', online: true });
    expect((await peer.next('presence.member')).data).toEqual({ memberId: 'mem_a', online: true });
    peer.socket.close(1000);
    expect((await a.next('presence.member')).data).toEqual({ memberId: 'mem_c', online: false });
  });

  it('stays online while a second tab is open', async () => {
    const a = await agentSocket();
    const { accessToken } = await json<{ accessToken: string }>(await call('POST', '/api/v1/auth/login', { body: { email: 'peer@example.com', password: PASSWORD, clientType: 'mobile' } }));
    const open = async () => connect((await json<{ url: string }>(await call('POST', `${W}/realtime/tickets`, { token: accessToken }))).url);
    const first = await open();
    await a.next('presence.member');
    await open();
    first.socket.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.frames.filter((f) => f.type === 'presence.member')).toEqual([]);
  });

  it('tells agents about a visitor once, and leaves going to the alarm', async () => {
    const a = await agentSocket();
    const v = await visitorSocket();
    expect((await a.next('presence.visitor')).data).toEqual({ conversationId, online: true });
    const second = await visitorSocket();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.frames.filter((f) => f.type === 'presence.visitor')).toEqual([]);
    second.socket.close(1000);
    v.socket.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.frames.filter((f) => f.type === 'presence.visitor')).toEqual([]);
    const room = testEnv.CONVERSATION_ROOM.getByName(`conversation:work_1:${conversationId}`);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect((await a.next('presence.visitor')).data).toEqual({ conversationId, online: false });
  });

  it('a visitor who comes straight back was never away', async () => {
    const a = await agentSocket();
    const v = await visitorSocket();
    await a.next('presence.visitor');
    v.socket.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await visitorSocket();
    const room = testEnv.CONVERSATION_ROOM.getByName(`conversation:work_1:${conversationId}`);
    await runDurableObjectAlarm(room);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.frames.filter((f) => f.type === 'presence.visitor')).toEqual([]);
  });
});

describe('availability', () => {
  const bootstrap = async (key: string) => (await json<{ availability: string }>(await call('GET', `/api/v1/widget/bootstrap?websiteKey=${key}`, { origin: SITE }))).availability;
  const site = (id: string, key: string, settings: string) =>
    env.DB.prepare(`INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at) VALUES (?1, 'work_1', 'Shop', ?2, ?3, ?4, 1, 1)`).bind(id, key, JSON.stringify([SITE]), settings).run();
  let unique = 0;
  const key = (name: string) => `key_${name}_${Date.now()}_${++unique}`;

  it('follows connected agents in auto mode', async () => {
    const [offline, online] = [key('none'), key('some')];
    await site('site_a', offline, '{}');
    await site('site_b', online, '{}');
    expect(await bootstrap(offline)).toBe('offline');
    await agentSocket();
    expect(await bootstrap(online)).toBe('online');
  });

  it('obeys a fixed setting, whoever is connected', async () => {
    const [on, off] = [key('on'), key('off')];
    await site('site_a', on, '{"availabilityMode":"online"}');
    await site('site_b', off, '{"availabilityMode":"offline"}');
    expect(await bootstrap(on)).toBe('online');
    await agentSocket();
    expect(await bootstrap(off)).toBe('offline');
  });
});

describe('catching up without a socket', () => {
  it('finds changes since a cursor, in every status, and repeats nothing forever', async () => {
    const first = await json<{ syncCursor: string; data: { id: string }[] }>(await call('GET', `${W}/conversations`, { token: agent }));
    const { version } = await json<{ version: number }>(await call('GET', `${W}/conversations/${conversationId}`, { token: agent }));
    await call('PATCH', `${W}/conversations/${conversationId}`, { token: agent, body: { expectedVersion: version, status: 'archived' } });
    const changed = await json<{ data: { id: string; status: string }[]; syncCursor: string }>(await call('GET', `${W}/conversations?updatedAfter=${first.syncCursor}`, { token: agent }));
    expect(changed.data).toMatchObject([{ id: conversationId, status: 'archived' }]);
    expect((await call('GET', `${W}/conversations?updatedAfter=${first.data[0]!.id}`, { token: agent })).status).toBe(400);
  });

  it('pages through a large catch-up, without skipping rows that share a time', async () => {
    await env.DB.batch(
      [1, 2, 3].map((n) =>
        env.DB.prepare(`INSERT INTO conversations (id, workspace_id, website_id, contact_id, last_message_at, created_at, updated_at) SELECT ?1, workspace_id, website_id, contact_id, 1, 1, 5 FROM conversations WHERE id = ?2`).bind(`conv_same_${n}`, conversationId),
      ),
    );
    const start = btoa(JSON.stringify({ v: 1, f: 'sync', at: 0, id: '' })).replace(/=+$/, '');
    const seen: string[] = [];
    let cursor: string | null = start;
    for (let guard = 0; cursor && guard < 10; guard++) {
      const page: { data: { id: string }[]; nextCursor: string | null } = await json(await call('GET', `${W}/conversations?updatedAfter=${cursor}&limit=2`, { token: agent }));
      seen.push(...page.data.map((c) => c.id));
      cursor = page.nextCursor;
    }
    expect(seen.slice(0, 3)).toEqual(['conv_same_1', 'conv_same_2', 'conv_same_3']);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
