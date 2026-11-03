// S2: sockets across idle, hibernation, wake, and a deploy under deferred updates.
// Three sockets, each to its own object:
//   hb:      heartbeats every 20s through the runtime's auto-response, no other traffic. Hibernates.
//   busy:    the same heartbeats, plus an RPC every 2s, which should keep its object awake.
//   silent:  no traffic at all. The control for idle timeouts on the path.
// The deploy must not block the event loop: an earlier version used execFileSync, which starved the
// heartbeats and let the "busy" object hibernate, giving a misleading result.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { BASE, TOKEN } = process.env;
const run = Date.now().toString(36);
const url = (path, params = {}) => `${BASE}${path}?${new URLSearchParams({ token: TOKEN, ...params })}`;
const get = async (path, params) => (await fetch(url(path, params))).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => Math.round((Date.now() - t0) / 1000);
const log = (...args) => console.log(`[${String(now()).padStart(3)}s]`, ...args);

function open(name) {
  const room = `${name}-${run}`;
  const ws = new WebSocket(url('/s2/ws', { room }).replace('https://', 'wss://'));
  const state = { ws, name, room, frames: [], closed: null };
  ws.addEventListener('message', (e) => state.frames.push(e.data));
  ws.addEventListener('close', (e) => { state.closed = { code: e.code, at: now() }; log(`SOCKET ${name} CLOSED`, e.code); });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(state));
    ws.addEventListener('error', () => reject(new Error(`socket ${name} failed`)));
  });
}
const take = async (s, ms = 5000, match = () => true) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const i = s.frames.findIndex(match);
    if (i >= 0) return s.frames.splice(i, 1)[0];
    await sleep(20);
  }
  return null;
};
const notPong = (f) => f !== 'pong';

const source = new URL('./src/index.ts', import.meta.url);
const original = readFileSync(source, 'utf8');
function deploy(version, code) {
  writeFileSync(source, code);
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'wrangler', 'deploy', '-c', new URL('./lab.deployed.jsonc', import.meta.url).pathname, '--define', `CODE_VERSION:'${version}'`], { stdio: 'ignore' });
    child.on('exit', (code) => { writeFileSync(source, original); code === 0 ? resolve() : reject(new Error(`deploy exit ${code}`)); });
  });
}
const v2Source = original.replace('  async apns() {', "  async addedInV2() {\n    return 'v2 method';\n  }\n\n  async apns() {");

await deploy('v1', original);
log('v1 deployed. Waiting 15s for it to reach the edge');
await sleep(15000);

const hb = await open('hb');
const busy = await open('busy');
const silent = await open('silent');
log('hello', await take(hb), await take(busy), await take(silent));

let beating = true;
const missed = { hb: 0, busy: 0 };
(async () => {
  while (beating) {
    await sleep(20000);
    for (const s of [hb, busy]) {
      if (s.closed || !beating) continue;
      s.ws.send('ping');
      if ((await take(s, 3000, (f) => f === 'pong')) === null) { missed[s.name]++; log(`${s.name}: no pong`); }
    }
  }
})();

let polling = true;
const seen = new Set();
const poller = (async () => {
  while (polling) {
    const info = await get('/s2/info', { room: busy.room }).catch(() => null);
    if (info) {
      const key = `worker=${info.workerVersion} object=${info.objectVersion} constructions=${info.constructions}`;
      if (!seen.has(key)) { seen.add(key); log('busy object:', key); }
    }
    await sleep(2000);
  }
})();

log('phase 1: 100s with no deploy, to separate idle closes from deploy closes');
await sleep(100000);
log('state', { hb: hb.closed, busy: busy.closed, silent: silent.closed, missed });
const woken = await get('/s2/info', { room: hb.room });
log('heartbeat-only object', woken);
log('hibernated and woke:', woken.constructions >= 2, 'attachment survived:', woken.attachment !== null);

log('phase 2: deploying v2, without blocking');
const started = now();
await deploy('v2', v2Source);
log(`deploy finished after ${now() - started}s. Observing for 60s`);
for (let i = 0; i < 6; i++) {
  await sleep(10000);
  const rpc = await get('/s2/newrpc', { room: busy.room }).catch((e) => ({ fetchError: String(e) }));
  const info = await get('/s2/info', { room: busy.room }).catch(() => ({}));
  log('busy:', JSON.stringify({ worker: rpc.workerVersion, object: info.objectVersion, newMethod: rpc.result ?? String(rpc.error).slice(0, 110) }), 'socket', busy.closed ?? 'open');
}

const broadcast = await get('/s2/broadcast', { room: busy.room }).catch(() => null);
log('broadcast to busy', broadcast, (await take(busy, 4000, notPong)) ?? 'NOTHING');

polling = false;
await poller;
log('phase 3: traffic stops except heartbeats. 60s, so that the busy object can hibernate');
await sleep(60000);
for (const s of [busy, hb]) {
  const info = await get('/s2/info', { room: s.room });
  log(`${s.name} object after idling`, { worker: info.workerVersion, object: info.objectVersion, constructions: info.constructions, sockets: info.sockets, attachment: info.attachment });
  log(`${s.name} socket`, s.closed ?? 'open');
  if (!s.closed) {
    s.ws.send('after-update');
    log(`${s.name} echo`, (await take(s, 4000, notPong)) ?? 'NOTHING');
  }
}
log('final', { hb: hb.closed, busy: busy.closed, silent: silent.closed, missed });
beating = false;
process.exit(0);
