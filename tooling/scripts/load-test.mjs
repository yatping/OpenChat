#!/usr/bin/env node
/**
 * Load test for a throwaway deployment. It writes junk messages, so never point it at real data.
 *
 *   LOAD_TEST_PASSWORD=... node tooling/scripts/load-test.mjs --url https://oc-x.example.workers.dev \
 *     --email owner@example.com --confirm-target oc-x.example.workers.dev --stage latency,throughput,sockets
 *
 * Stages: latency, throughput, sockets. Options: --sockets 1000, --levels 1,5,10,25,50,100, --seconds 30,
 * --hold-seconds 0 (keep sockets open that long first, to redeploy underneath them), --one-shape yes, --no-reset yes.
 * Visitor sessions are limited per IP address, so visitors are sampled and agents carry the load.
 */
/* global AbortSignal, WebSocket, clearInterval, clearTimeout, performance, setInterval */
import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

// Node's happy eyeballs gives each address 250 ms, so a busy client times itself out and blames the network.
setDefaultAutoSelectFamily(false);
setDefaultResultOrder('ipv4first');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const base = option('url')?.replace(/\/$/, '');
const email = option('email');
const password = process.env.LOAD_TEST_PASSWORD;
if (!base || !email || !password) throw new Error('Needs --url, --email, and LOAD_TEST_PASSWORD');
if (option('confirm-target') !== new URL(base).host) throw new Error('--confirm-target must repeat the host of --url. This writes junk data');
const stages = option('stage', 'latency,throughput,sockets').split(',');
const SOCKETS = Number(option('sockets', 1000));
const LEVELS = option('levels', '1,5,10,25,50,100').split(',').map(Number);
const SECONDS = Number(option('seconds', 30));
const HOLD_SECONDS = Number(option('hold-seconds', 0));
const ORIGIN = 'https://load-test.invalid';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (stage, data) => console.log(JSON.stringify({ stage, ...data }));
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]) : null);
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

async function request(method, path, token, body, headers = {}) {
  const started = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: an HTML page from the platform is one of the things being counted.
  }
  return { status: response.status, json, ms: performance.now() - started, headers: response.headers };
}

/** Access tokens last 15 minutes, so each stage signs in again. */
async function signIn() {
  const login = await request('POST', '/api/v1/auth/login', null, { email, password, clientType: 'mobile' });
  if (!login.json?.accessToken) throw new Error(`Sign-in failed: ${login.status}`);
  return login.json.accessToken;
}

let token = await signIn();
const me = await request('GET', '/api/v1/me', token);
const workspaceId = me.json.memberships[0].workspace.id;
const inWorkspace = `/api/v1/workspaces/${workspaceId}`;

async function ensureWebsite() {
  const list = await request('GET', `${inWorkspace}/websites`, token);
  const found = list.json.data.find((website) => website.name === 'Load test');
  if (found) return found;
  return (await request('POST', `${inWorkspace}/websites`, token, { name: 'Load test', allowedOrigins: [ORIGIN] })).json;
}
const website = await ensureWebsite();

async function startVisitor() {
  const session = await request('POST', '/api/v1/widget/sessions', null, { websiteKey: website.websiteKey }, { origin: ORIGIN });
  if (!session.json?.accessToken) throw new Error(`Visitor session failed: ${session.status} ${session.json?.code ?? ''}`);
  return session.json.accessToken;
}

async function ensureConversations(count) {
  const list = await request('GET', `${inWorkspace}/conversations?limit=${count}`, token);
  const ids = list.json.data.map((conversation) => conversation.id);
  while (ids.length < count) {
    const visitor = await startVisitor();
    for (let i = 0; i < 5 && ids.length < count; i++) {
      const made = await request('POST', '/api/v1/widget/conversations', visitor, { clientMessageId: randomUUID(), content: 'Load test' }, { origin: ORIGIN });
      if (made.status !== 201) throw new Error(`Conversation failed: ${made.status} ${made.json?.code ?? ''}`);
      ids.push(made.json.conversation?.id ?? made.json.id);
    }
  }
  return ids;
}

const send = (conversationId, clientMessageId = randomUUID()) => request('POST', `${inWorkspace}/conversations/${conversationId}/messages`, token, { clientMessageId, type: 'text', content: 'Load test message' });

/** As the real clients do: the same clientMessageId until there is an answer, so that a retry cannot duplicate. */
async function sendUntilAnswered(conversationId, onAttempt) {
  const clientMessageId = randomUUID();
  for (let attempt = 0; attempt < 8; attempt++) {
    let result;
    try {
      result = await send(conversationId, clientMessageId);
      onAttempt(result.status === 201 || result.status === 200 ? String(result.status) : `${result.status} ${result.json?.code ?? ''}`.trim());
    } catch (error) {
      onAttempt(`no answer: ${error.cause?.code ?? error.name}`);
    }
    if (result?.status === 201 || result?.status === 200) return result;
    const hinted = Number(result?.headers.get('retry-after') ?? 0) * 1000;
    await wait(hinted + Math.random() * 500 * 2 ** attempt);
  }
  return null;
}

async function latency() {
  const [conversationId] = await ensureConversations(1);
  const measure = async (name, call, n = 30) => {
    const times = [];
    const statuses = {};
    let placement;
    for (let i = 0; i < n; i++) {
      const result = await call();
      times.push(result.ms);
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      placement = `${result.headers.get('cf-placement') ?? 'none'} via ${result.headers.get('cf-ray')?.split('-')[1] ?? '?'}`;
    }
    report('latency', { name, ...stats(times), statuses, placement });
  };
  await measure('agent send', () => send(conversationId));
  await measure('list conversations', () => request('GET', `${inWorkspace}/conversations?limit=20`, token));
  await measure('list messages', () => request('GET', `${inWorkspace}/conversations/${conversationId}/messages`, token));
  const visitor = await startVisitor();
  await measure('visitor start, the widget\'s first send', () => request('POST', '/api/v1/widget/conversations', visitor, { clientMessageId: randomUUID(), content: 'Load test' }, { origin: ORIGIN }), 10);
}

/** Sequences from accepted sends must be gapless, or a send was lost, or one committed but reported failure. */
async function throughput() {
  const conversations = await ensureConversations(20);
  const shapes = [['20 conversations', conversations], ['1 conversation', conversations.slice(0, 1)]];
  for (const [name, targets] of option('one-shape') ? shapes.slice(0, 1) : shapes) {
    for (const level of LEVELS) {
      token = await signIn();
      const times = [];
      const statuses = {};
      const seqs = new Map(targets.map((id) => [id, []]));
      let gaveUp = 0;
      const until = performance.now() + SECONDS * 1000;
      const started = performance.now();
      await Promise.all(
        Array.from({ length: level }, async (_, worker) => {
          let turn = worker;
          while (performance.now() < until) {
            const id = targets[turn++ % targets.length];
            const began = performance.now();
            const result = await sendUntilAnswered(id, (label) => {
              statuses[label] = (statuses[label] ?? 0) + 1;
            });
            if (!result) {
              gaveUp++;
              continue;
            }
            times.push(performance.now() - began);
            seqs.get(id).push(result.json.seq);
          }
        }),
      );
      const elapsed = (performance.now() - started) / 1000;
      let gaps = 0;
      let duplicates = 0;
      for (const list of seqs.values()) {
        list.sort((a, b) => a - b);
        for (let i = 1; i < list.length; i++) {
          if (list[i] === list[i - 1]) duplicates++;
          else if (list[i] !== list[i - 1] + 1) gaps++;
        }
      }
      report('throughput', { name, concurrency: level, perSecond: Number((times.length / elapsed).toFixed(1)), ...stats(times), statuses, gaveUp, gaps, duplicates });
    }
  }
}

class Client {
  frames = [];
  closes = [];
  socket = null;
  async connect() {
    const ticket = await request('POST', `${inWorkspace}/realtime/tickets`, token);
    if (ticket.status !== 201) throw new Error(`ticket ${ticket.status} ${ticket.json?.code ?? ''}`.trim());
    this.ticketMs = ticket.ms;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(ticket.json.url);
      const timer = setTimeout(() => reject(new Error('open timeout')), 30_000);
      socket.onopen = () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('socket error'));
      };
      socket.onmessage = (event) => {
        if (event.data !== 'pong') this.frames.push({ at: performance.now(), raw: String(event.data) });
      };
      socket.onclose = (event) => {
        if (this.socket === socket) {
          this.socket = null;
          this.closes.push(event.code);
        }
      };
    });
  }
  disconnect() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

/** Runs every task, at most this many at once, and counts how each went. */
async function pool(items, limit, task) {
  const times = [];
  const failures = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        const started = performance.now();
        try {
          await task(item);
          times.push(performance.now() - started);
        } catch (error) {
          failures[error.message] = (failures[error.message] ?? 0) + 1;
        }
      }
    }),
  );
  return { times, failures };
}

async function fanout(clients, conversationId, label) {
  const live = clients.filter((client) => client.socket);
  for (const client of live) client.frames.length = 0;
  const started = performance.now();
  const sent = await sendUntilAnswered(conversationId, () => undefined);
  if (!sent) throw new Error('A send for the fan-out check got no answer');
  await wait(20_000);
  const id = sent.json.id;
  const arrivals = live.map((client) => client.frames.find((frame) => frame.raw.includes(id))?.at).filter(Boolean).map((at) => at - started);
  report('fanout', { label, status: sent.status, sendMs: Math.round(sent.ms), sockets: live.length, reached: arrivals.length, ...stats(arrivals) });
}

/** Reconnects like the real client, with messages still being sent, then proves nobody lost one. */
async function reset(clients, conversationId, label, jitterMs, limit) {
  token = await signIn();
  const before = await sendUntilAnswered(conversationId, () => undefined);
  if (!before) throw new Error('A send before the reset got no answer');
  const afterSeq = before.json.seq;
  const sent = [];
  let sending = true;
  const sender = (async () => {
    while (sending) {
      const result = await sendUntilAnswered(conversationId, () => undefined);
      if (result) sent.push(result.json.id);
      await wait(1000);
    }
  })();
  for (const client of clients) {
    client.frames.length = 0;
    client.disconnect();
  }
  const started = performance.now();
  const recovered = clients.map(() => new Set());
  const delays = [];
  const phases = { ticket: [], socket: [], catchUp: [] };
  const finished = new Set();
  const retries = {};
  const reconnectAttempt = async (index) => {
    const client = clients[index];
    if (jitterMs) await wait(Math.random() * jitterMs);
    let lastError;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const began = performance.now();
        await client.connect();
        const opened = performance.now();
        const page = await request('GET', `${inWorkspace}/conversations/${conversationId}/messages?afterSeq=${afterSeq}&limit=100`, token);
        if (page.status !== 200) throw new Error(`catch-up ${page.status} ${page.json?.code ?? ''}`.trim());
        for (const message of page.json.data) recovered[index].add(message.id);
        phases.ticket.push(client.ticketMs);
        phases.socket.push(opened - began - client.ticketMs);
        phases.catchUp.push(page.ms);
        delays.push(performance.now() - started);
        finished.add(index);
        return;
      } catch (error) {
        lastError = error;
        const label = error.cause?.code ?? error.message;
        retries[label] = (retries[label] ?? 0) + 1;
        await wait(Math.random() * 1000 * 2 ** (attempt + 1));
      }
    }
    throw lastError;
  };
  const { times, failures } = await pool(clients.map((_, index) => index), limit, reconnectAttempt);
  const allBackAfter = (performance.now() - started) / 1000;
  await wait(3000);
  sending = false;
  await sender;
  await wait(8000);
  // A client that never finished catching up has not recovered yet, which is different from having lost something.
  let lostFor = 0;
  let missing = 0;
  clients.forEach((client, index) => {
    if (!finished.has(index) || !client.socket) return;
    const seen = recovered[index];
    const lost = sent.filter((id) => !seen.has(id) && !client.frames.some((frame) => frame.raw.includes(id)));
    if (lost.length) {
      lostFor++;
      missing += lost.length;
    }
  });
  report('reset', {
    label,
    clients: clients.length,
    finished: finished.size,
    socketsOpen: clients.filter((client) => client.socket).length,
    gaveUp: failures,
    retries,
    allBackSeconds: Number(allBackAfter.toFixed(1)),
    perSecond: Number((finished.size / allBackAfter).toFixed(1)),
    eachClient: stats(times),
    ticket: stats(phases.ticket),
    socket: stats(phases.socket),
    catchUp: stats(phases.catchUp),
    sentDuringReset: sent.length,
    clientsMissingAMessage: lostFor,
    messagesMissing: missing,
  });
}

async function sockets() {
  const [conversationId] = await ensureConversations(1);
  token = await signIn();
  const clients = Array.from({ length: SOCKETS }, () => new Client());
  // From the start: sockets with no heartbeat are dropped at about 62 s, and opening them all takes longer.
  const heartbeat = setInterval(() => {
    for (const client of clients) if (client.socket?.readyState === 1) client.socket.send('ping');
  }, 30_000);
  const started = performance.now();
  const opened = await pool(clients, 40, async (client) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.connect();
      } catch (error) {
        if (attempt === 4) throw error;
        await wait(500 * 2 ** attempt);
      }
    }
  });
  report('sockets', { step: 'open', wanted: SOCKETS, open: clients.filter((client) => client.socket).length, seconds: Number(((performance.now() - started) / 1000).toFixed(1)), ...stats(opened.times), failures: opened.failures });
  await fanout(clients, conversationId, 'idle');

  if (HOLD_SECONDS) {
    // Redeploy during this. Sockets that close are counted, not reopened, and sends show who still hears.
    const heardBy = [];
    const end = performance.now() + HOLD_SECONDS * 1000;
    while (performance.now() < end) {
      token = await signIn();
      await fanout(clients, conversationId, 'during hold');
      heardBy.push(clients.filter((client) => client.socket).length);
    }
    const codes = {};
    for (const client of clients) for (const code of client.closes) codes[code] = (codes[code] ?? 0) + 1;
    report('hold', { seconds: HOLD_SECONDS, openOverTime: heardBy, closeCodes: codes });
  }

  if (option('no-reset')) {
    clearInterval(heartbeat);
    return;
  }

  // Long enough for the hub to hibernate, so that this send has to wake it with every socket attached.
  await wait(45_000);
  await fanout(clients, conversationId, 'after 45 s idle');

  // The client machine runs out before the server does, so this one holds it back to measure the server.
  await reset(clients, conversationId, 'at most 100 at once', 0, 100);
  await fanout(clients, conversationId, 'after the paced reset');
  await reset(clients, conversationId, 'all at once', 0, SOCKETS);
  await fanout(clients, conversationId, 'after the all-at-once reset');
  clearInterval(heartbeat);
  for (const client of clients) client.disconnect();
}

const run = { latency, throughput, sockets };
for (const stage of stages) {
  token = await signIn();
  await run[stage]();
}
process.exit(0);
