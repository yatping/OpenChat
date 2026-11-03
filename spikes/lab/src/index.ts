// Phase 0 spikes S1 to S6. Every route needs the token, and nothing here carries real data.
import { scrypt, scryptSync } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { authorizeWorkspaceMember, openDatabase, repositories } from '../../../packages/database/src/index';
import { importPrivateKey, importPublicKey, signRequest, verifyRequest } from '../../../packages/notification-protocol/src/index';
import vector from '../../../packages/notification-protocol/test/test-vector.json';

declare const CODE_VERSION: string;

interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<SpikeHub>;
  PEER: Fetcher;
  TOKEN: string;
  PROBES: Queue;
}

const APNS = 'https://api.sandbox.push.apple.com/3/device/0000000000000000000000000000000000000000000000000000000000000000';

async function probeApns(): Promise<{ status: number; reason: string | null; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(APNS, {
      method: 'POST',
      headers: { 'apns-topic': 'com.example.spike', 'content-type': 'application/json' },
      body: '{"aps":{"alert":"spike"}}',
    });
    const text = await response.text();
    let reason: string | null = text.slice(0, 80);
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason ?? null;
    } catch {
      // Keep the raw text, as a non-JSON answer is itself a finding.
    }
    return { status: response.status, reason, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, reason: null, ms: Date.now() - started, error: String(error) };
  }
}

const recordProbe = (env: Env, context: string, probe: Awaited<ReturnType<typeof probeApns>>) =>
  env.DB.prepare(`INSERT INTO spike_apns (at, context, status, reason, error, ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(Date.now(), context, probe.status, probe.reason, probe.error ?? null, probe.ms)
    .run();

export class SpikeHub extends DurableObject<Env> {
  private readonly bornAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    const row = ctx.storage.kv.get<number>('constructions') ?? 0;
    ctx.storage.kv.put('constructions', row + 1);
  }

  override async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ principal: 'spike', acceptedBy: CODE_VERSION, at: Date.now() });
    pair[1].send(JSON.stringify({ type: 'hello', version: CODE_VERSION }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    socket.send(JSON.stringify({ type: 'echo', version: CODE_VERSION, message: String(message), attachment: socket.deserializeAttachment() }));
  }

  async info() {
    const sockets = this.ctx.getWebSockets();
    return {
      objectVersion: CODE_VERSION,
      constructions: this.ctx.storage.kv.get<number>('constructions'),
      bornAgoMs: Date.now() - this.bornAt,
      sockets: sockets.length,
      attachment: sockets[0]?.deserializeAttachment() ?? null,
      autoResponseAt: sockets[0] ? this.ctx.getWebSocketAutoResponseTimestamp(sockets[0]) : null,
    };
  }

  async broadcast(text: string): Promise<number> {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) socket.send(JSON.stringify({ type: 'broadcast', version: CODE_VERSION, text }));
    return sockets.length;
  }

  async apns() {
    const probe = await probeApns();
    await recordProbe(this.env, 'durable_object', probe);
    return probe;
  }
}

const SEED = [
  `INSERT OR IGNORE INTO users (id,email,name,password_hash,created_at,updated_at) VALUES ('u1','one@spike.test','One','!',1,1)`,
  `INSERT OR IGNORE INTO workspaces (id,name,slug,created_at,updated_at) VALUES ('w1','A','a',1,1)`,
  `INSERT OR IGNORE INTO workspace_members (id,workspace_id,user_id,role,created_at,updated_at) VALUES ('m1','w1','u1','owner',1,1)`,
  `INSERT OR IGNORE INTO websites (id,workspace_id,name,website_key,created_at,updated_at) VALUES ('s1','w1','s','k1',1,1)`,
  `INSERT OR IGNORE INTO contacts (id,workspace_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES ('p1','w1',1,1,1,1)`,
];

async function d1Route(path: string, url: URL, env: Env, request: Request): Promise<Response> {
  const db = openDatabase(env.DB);
  const n = Number(url.searchParams.get('n') ?? 1);

  if (path === '/s4/seed') {
    await env.DB.batch(SEED.map((s) => env.DB.prepare(s)));
    const conversation = `c_${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO conversations (id,workspace_id,website_id,contact_id,created_at,updated_at) VALUES (?1,'w1','s1','p1',1,1)`).bind(conversation).run();
    return Response.json({ conversation });
  }

  if (path === '/s4/time') {
    const before = Date.now();
    try {
      const row = await env.DB.prepare(
        `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS ms, unixepoch('subsec') AS subsec`,
      ).first<{ ms: number; subsec: number }>();
      return Response.json({ ...row, workerBefore: before, workerAfter: Date.now() });
    } catch (e) {
      return Response.json({ error: String(e), cause: String((e as Error).cause ?? '') });
    }
  }

  if (path === '/s4/rollback') {
    const id = `rb_${crypto.randomUUID()}`;
    let error: string | null = null;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO users (id,email,name,password_hash,created_at,updated_at) VALUES (?1,?2,'x','!',1,1)`).bind(id, `${id}@spike.test`),
        env.DB.prepare(`INSERT INTO users (id,email,name,password_hash,created_at,updated_at) VALUES (?1,'one@spike.test','dup','!',1,1)`).bind(`${id}b`),
      ]);
    } catch (e) {
      error = String(e);
    }
    const kept = await env.DB.prepare(`SELECT count(*) AS n FROM users WHERE id = ?1`).bind(id).first<{ n: number }>();
    return Response.json({ error, firstStatementKept: kept?.n });
  }

  const ctx = await authorizeWorkspaceMember(db, 'u1', 'w1');
  if (!ctx) return new Response('Seed first', { status: 409 });
  const repo = repositories(db, ctx);
  const conversation = url.searchParams.get('c') ?? '';

  if (path === '/s4/send') {
    // A single write, timed, with the repository's real batch. Concurrency comes from the client.
    const started = Date.now();
    try {
      const result = await repo.messages.send({
        conversationId: conversation,
        clientMessageId: url.searchParams.get('client') ?? crypto.randomUUID(),
        sender: url.searchParams.get('note') ? { type: 'member', id: 'm1' } : { type: 'visitor', id: null },
        type: url.searchParams.get('note') ? 'internal_note' : 'text',
        content: 'spike',
      });
      return Response.json({ ok: true, ms: Date.now() - started, result });
    } catch (e) {
      return Response.json({ ok: false, ms: Date.now() - started, error: String(e) }, { status: 503 });
    }
  }
  if (path === '/s4/timing') {
    // Several writes in one request separate a slow first call from slow writes in general.
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const started = Date.now();
      await repo.messages.send({ conversationId: conversation, clientMessageId: crypto.randomUUID(), sender: { type: 'visitor', id: null }, type: 'text', content: 'spike' });
      ms.push(Date.now() - started);
    }
    return Response.json({ ms, colo: (request.cf as { colo?: string } | undefined)?.colo });
  }
  if (path === '/s4/assign') {
    const started = Date.now();
    try {
      return Response.json({ ok: true, ms: Date.now() - started, result: await repo.conversations.assign(conversation, 'm1', n) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 503 });
    }
  }
  if (path === '/s4/check') {
    const rows = await env.DB.prepare(
      `SELECT count(*) AS messages, min(seq) AS minSeq, max(seq) AS maxSeq, count(DISTINCT seq) AS distinctSeq, max(public_seq) AS maxPublic, count(DISTINCT public_seq) AS distinctPublic FROM messages WHERE conversation_id = ?1`,
    ).bind(conversation).first();
    const events = await env.DB.prepare(`SELECT count(*) AS n FROM conversation_events WHERE conversation_id = ?1 AND event_type = 'assigned'`).bind(conversation).first<{ n: number }>();
    const convo = await env.DB.prepare(`SELECT version, last_message_seq AS lastSeq FROM conversations WHERE id = ?1`).bind(conversation).first();
    return Response.json({ rows, assignedEvents: events?.n, convo });
  }
  return new Response('Unknown', { status: 404 });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env) {
    await recordProbe(env, 'cron', await probeApns());
  },

  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      await recordProbe(env, 'queue', await probeApns());
      message.ack();
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!env.TOKEN || url.searchParams.get('token') !== env.TOKEN) return new Response('Not found', { status: 404 });

    switch (path) {
      case '/version':
        return Response.json({ workerVersion: CODE_VERSION });

      case '/s1/fetch': {
        const probe = await probeApns();
        await recordProbe(env, 'fetch', probe);
        return Response.json(probe);
      }
      case '/s1/do':
        return Response.json(await env.HUB.getByName('apns').apns());
      case '/s1/queue':
        await env.PROBES.send({ probe: true });
        return Response.json({ queued: true });
      case '/s1/results': {
        const rows = await env.DB.prepare(
          `SELECT context, status, reason, error, count(*) AS n, min(ms) AS minMs, max(ms) AS maxMs, min(at) AS first, max(at) AS last FROM spike_apns GROUP BY 1,2,3,4`,
        ).all();
        return Response.json(rows.results);
      }

      case '/s2/ws':
        return env.HUB.getByName(url.searchParams.get('room') ?? 'room').fetch(request);
      case '/s2/info': {
        const stub = env.HUB.getByName(url.searchParams.get('room') ?? 'room');
        return Response.json({ workerVersion: CODE_VERSION, ...(await stub.info()) });
      }
      case '/s2/broadcast': {
        const stub = env.HUB.getByName(url.searchParams.get('room') ?? 'room');
        return Response.json({ workerVersion: CODE_VERSION, sent: await stub.broadcast('from-worker') });
      }
      case '/s2/newrpc': {
        // What a new Worker sees when it calls a method that an old object does not have.
        const stub = env.HUB.getByName(url.searchParams.get('room') ?? 'room') as unknown as { addedInV2(): Promise<string> };
        try {
          return Response.json({ workerVersion: CODE_VERSION, result: await stub.addedInV2() });
        } catch (e) {
          return Response.json({ workerVersion: CODE_VERSION, error: String(e) });
        }
      }

      case '/s3/scrypt': {
        const concurrent = Number(url.searchParams.get('n') ?? 1);
        const options = { N: 2 ** 15, r: 8, p: 3, maxmem: 256 * 1024 * 1024 };
        const salt = crypto.getRandomValues(new Uint8Array(16));
        try {
          if (url.searchParams.get('mode') === 'sync') {
            scryptSync('spike-password', salt, 32, options);
          } else {
            await Promise.all(
              Array.from({ length: concurrent }, () =>
                new Promise<void>((resolve, reject) => scrypt('spike-password', salt, 32, options, (e) => (e ? reject(e) : resolve()))),
              ),
            );
          }
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 500 });
        }
      }
      case '/s3/baseline':
        return Response.json({ ok: true });

      case '/s5/ed25519': {
        const v = vector as unknown as { publicKey: string; privateKeyPkcs8: string; input: Record<string, string>; signature: string; now: number };
        const input = { ...v.input, body: new TextEncoder().encode(v.input.body) } as never;
        const signature = await signRequest(await importPrivateKey(v.privateKeyPkcs8), input);
        const verified = await verifyRequest(await importPublicKey(v.publicKey), input, signature, v.now);
        const started = performance.now();
        return Response.json({ matchesVector: signature === v.signature, verified, ms: performance.now() - started });
      }

      case '/s6/url': {
        const target = url.searchParams.get('url') ?? '';
        if (!/^https:\/\/openchat-spike-[a-z]+\./.test(target)) return new Response('Not a spike target', { status: 400 });
        const response = await fetch(target);
        return Response.json({ status: response.status, body: (await response.text()).slice(0, 120) });
      }
      case '/s6/binding': {
        const response = await env.PEER.fetch('https://peer/.well-known/openchat.json');
        return Response.json({ status: response.status, body: await response.text() });
      }
      case '/s6/external': {
        const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
        return Response.json({ status: response.status });
      }
      default:
        return path.startsWith('/s4/') ? d1Route(path, url, env, request) : new Response('Unknown', { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
