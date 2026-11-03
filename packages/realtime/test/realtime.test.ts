import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { VisitorEventSchema } from '@openchat/api-contracts';
import type { WireMessage } from '@openchat/api-contracts';
import { CLAIMS_HEADER, toVisitorEvent, type ConversationRoom, type DomainEvent, type SocketAttachment, type WorkspaceHub } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env {
      WORKSPACE_HUB: DurableObjectNamespace<WorkspaceHub>;
      CONVERSATION_ROOM: DurableObjectNamespace<ConversationRoom>;
    }
  }
}

const claims = (over: Partial<SocketAttachment> = {}): SocketAttachment => ({
  kind: 'agent',
  principalId: 'mem_1',
  role: 'agent',
  expiresAt: Date.now() + 60_000,
  connectedAt: Date.now(),
  protocolVersion: 1,
  ...over,
});

interface TestSocket {
  socket: WebSocket;
  frames: string[];
  closed: { code: number } | null;
  next(): Promise<string>;
}

const open: WebSocket[] = [];

async function connect(stub: DurableObjectStub, attachment: SocketAttachment): Promise<TestSocket> {
  const response = await stub.fetch('https://do/connect', {
    headers: { upgrade: 'websocket', [CLAIMS_HEADER]: JSON.stringify(attachment) },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  open.push(socket);
  const state: TestSocket = {
    socket,
    frames: [],
    closed: null,
    next() {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          const frame = state.frames.shift();
          if (frame !== undefined) resolve(frame);
          else if (Date.now() - started > 4000) reject(new Error('Timed out waiting for a frame'));
          else setTimeout(tick, 5);
        };
        tick();
      });
    },
  };
  socket.addEventListener('message', (e) => void state.frames.push(e.data as string));
  socket.addEventListener('close', (e) => void (state.closed = { code: e.code }));
  await state.next(); // hello
  return state;
}

const waitForClose = async (s: TestSocket) => {
  const started = Date.now();
  while (!s.closed && Date.now() - started < 4000) await new Promise((r) => setTimeout(r, 5));
  return s.closed;
};

const message = (over: Partial<WireMessage> = {}): WireMessage => ({
  id: 'msg_1',
  conversationId: 'conv_1',
  seq: 7,
  publicSeq: 5,
  clientMessageId: null,
  sender: { type: 'member', id: 'mem_secret', displayName: 'Ann' },
  type: 'text',
  visibility: 'public',
  content: 'hello',
  attachments: [],
  createdAt: '2026-11-03T10:00:00.000Z',
  metadata: { secretKey: 1 },
  ...over,
});
const created = (m: WireMessage): DomainEvent => ({ v: 1, kind: 'message.created', workspaceId: 'w', message: m });
const note = message({ type: 'internal_note', visibility: 'internal', publicSeq: null, content: 'private note' });

afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close(1000);
    } catch {
      // Already closed.
    }
  }
});

const hub = (name = crypto.randomUUID()) => env.WORKSPACE_HUB.getByName(`workspace:${name}`);
const room = (name = crypto.randomUUID()) => env.CONVERSATION_ROOM.getByName(`conversation:${name}`);

describe('WorkspaceHub', () => {
  it('refuses a request without an upgrade, or without verified claims', async () => {
    expect((await hub().fetch('https://do/connect')).status).toBe(426);
    expect((await hub().fetch('https://do/connect', { headers: { upgrade: 'websocket' } })).status).toBe(401);
  });

  it('sends hello with the protocol version', async () => {
    const response = await hub().fetch('https://do/connect', {
      headers: { upgrade: 'websocket', [CLAIMS_HEADER]: JSON.stringify(claims()) },
    });
    const socket = response.webSocket!;
    const frames: string[] = [];
    socket.addEventListener('message', (e) => void frames.push(e.data as string));
    socket.accept();
    open.push(socket);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(frames[0]!)).toMatchObject({ v: 1, type: 'hello', data: { protocolVersion: 1, heartbeatIntervalSeconds: 30 } });
  });

  it('broadcasts to all connected agents', async () => {
    const stub = hub();
    const a = await connect(stub, claims({ principalId: 'mem_a' }));
    const b = await connect(stub, claims({ principalId: 'mem_b' }));
    expect(await stub.publish(created(message()))).toBe(2);
    for (const s of [a, b]) expect(JSON.parse(await s.next())).toMatchObject({ type: 'message.created', data: { message: { id: 'msg_1', seq: 7 } } });
  });

  it('answers ping through the runtime, without invoking the object', async () => {
    const stub = hub();
    const a = await connect(stub, claims());
    a.socket.send('ping');
    expect(await a.next()).toBe('pong');
    const timestamp = await runInDurableObject(stub, (_i, state) => state.getWebSocketAutoResponseTimestamp(state.getWebSockets()[0]!));
    expect(timestamp).toBeInstanceOf(Date);
  });

  it('keeps the socket and its attachment across eviction', async () => {
    const stub = hub();
    const a = await connect(stub, claims({ principalId: 'mem_kept' }));
    await evictDurableObject(stub);
    expect(a.closed).toBeNull();
    expect(await stub.connectionCount()).toBe(1);
    const attachment = await runInDurableObject(stub, (_i, state) => state.getWebSockets('member:mem_kept')[0]?.deserializeAttachment());
    expect(attachment).toMatchObject({ principalId: 'mem_kept' });
    await stub.publish(created(message()));
    expect(JSON.parse(await a.next())).toMatchObject({ type: 'message.created' });
  });

  it('closes a revoked member only', async () => {
    const stub = hub();
    const a = await connect(stub, claims({ principalId: 'mem_a' }));
    const b = await connect(stub, claims({ principalId: 'mem_b' }));
    expect(await stub.revokeMember('mem_a')).toBe(1);
    expect(await waitForClose(a)).toEqual({ code: 4403 });
    expect(b.closed).toBeNull();
  });

  it('does not deliver to a socket with expired authorisation, and closes it', async () => {
    const stub = hub();
    const a = await connect(stub, claims({ expiresAt: Date.now() + 40 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(await stub.publish(created(message()))).toBe(0);
    expect(await waitForClose(a)).toEqual({ code: 4401 });
  });

  it('closes on an oversized frame', async () => {
    const a = await connect(hub(), claims());
    a.socket.send('x'.repeat(9000));
    expect(await waitForClose(a)).toEqual({ code: 1009 });
  });

  it('ignores an unknown domain event from a newer Worker', async () => {
    const stub = hub();
    await connect(stub, claims());
    const future = { v: 1, kind: 'from.the.future', workspaceId: 'w' } as unknown as DomainEvent;
    expect(await stub.publish(future)).toBe(0);
  });
});

describe('ConversationRoom', () => {
  const visitor = () => claims({ kind: 'visitor', principalId: 'vis_1', role: null });

  it('delivers a public message using the public sequence, with agent fields removed', async () => {
    const stub = room();
    const v = await connect(stub, visitor());
    expect(await stub.publishDomainEvent(created(message()))).toBe(1);
    const frame = await v.next();
    expect(JSON.parse(frame)).toMatchObject({ type: 'message.created', data: { message: { seq: 5 } } });
    expect(frame).not.toMatch(/mem_secret|secretKey|visibility|publicSeq/);
    expect(VisitorEventSchema.safeParse(JSON.parse(frame)).success).toBe(true);
  });

  it('never delivers an internal note', async () => {
    const stub = room();
    const v = await connect(stub, visitor());
    expect(await stub.publishDomainEvent(created(note))).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(v.frames).toEqual([]);
  });
});

describe('toVisitorEvent, across every domain event', () => {
  const patch = { id: 'c', version: 2, updatedAt: 't' };
  const read = { v: 1, kind: 'conversation.read', workspaceId: 'w', conversationId: 'c', deliveredSeq: 9, readSeq: 9 } as const;
  const member = { type: 'member', id: 'mem_secret' } as const;
  const visitorReader = { type: 'visitor', id: 'vis_1' } as const;

  const table: [string, DomainEvent, unknown][] = [
    ['a public message', created(message()), { type: 'message.created' }],
    ['an internal note', created(note), null],
    ['a mislabelled note with a public type', created(message({ visibility: 'internal', publicSeq: null })), null],
    ['a note type marked public', created(message({ type: 'internal_note', publicSeq: 3 })), null],
    ['a conversation being created', { v: 1, kind: 'conversation.created', workspaceId: 'w', conversation: patch }, null],
    ['an assignment change', { v: 1, kind: 'conversation.updated', workspaceId: 'w', conversation: { ...patch, assignedMemberId: 'mem_secret' } }, null],
    ['a priority change', { v: 1, kind: 'conversation.updated', workspaceId: 'w', conversation: { ...patch, priority: 'urgent' } }, null],
    ['a status change', { v: 1, kind: 'conversation.updated', workspaceId: 'w', conversation: { ...patch, status: 'resolved', assignedMemberId: 'mem_secret' } }, { type: 'conversation.status', data: { conversationId: 'c', status: 'resolved' } }],
    ['a member reading', { ...read, reader: member, publicReadSeq: 6 }, { type: 'conversation.read', data: { conversationId: 'c', readSeq: 6 } }],
    ['a member reading only notes', { ...read, reader: member, publicReadSeq: null }, null],
    ['the visitor reading', { ...read, reader: visitorReader, publicReadSeq: null }, null],
  ];

  it.each(table)('%s', (_name, event, expected) => {
    const result = toVisitorEvent(event);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatchObject(expected as object);
    expect(JSON.stringify(result)).not.toMatch(/mem_secret|private note|"visibility"|"publicSeq"|"readSeq":9/);
    if (result) expect(VisitorEventSchema.safeParse(result).success).toBe(true);
  });
});
