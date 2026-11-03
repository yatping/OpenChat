// Drives the deployed spike. Usage: BASE=https://... TOKEN=... node client.mjs <s1|s3|s4|s5|s6|s2-open>
const { BASE, TOKEN, PEER, FLAGGED } = process.env;
const api = (path, params = {}) => `${BASE}${path}?${new URLSearchParams({ token: TOKEN, ...params })}`;
const json = async (path, params) => {
  const started = performance.now();
  const response = await fetch(api(path, params));
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { http: response.status, wall: performance.now() - started, body };
};
// Bounded, so that the laptop's connection limit is not mistaken for a D1 limit.
const pool = async (count, limit, fn) => {
  const results = [];
  let next = 0;
  const lane = async () => {
    while (next < count) {
      const i = next++;
      results[i] = await fn(i).catch((e) => ({ http: 0, body: { ok: false, error: `client: ${e.cause?.code ?? e.message}` } }));
    }
  };
  await Promise.all(Array.from({ length: limit }, lane));
  return results;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const stats = (values) => ({ n: values.length, p50: Math.round(pct(values, 0.5)), p95: Math.round(pct(values, 0.95)), max: Math.round(Math.max(...values)) });

async function s1() {
  for (let i = 0; i < 10; i++) { await json('/s1/fetch'); await json('/s1/do'); await json('/s1/queue'); await sleep(300); }
  await sleep(15000);
  console.log(JSON.stringify((await json('/s1/results')).body, null, 1));
}

async function s3() {
  const baseline = [];
  for (let i = 0; i < 15; i++) baseline.push((await json('/s3/baseline')).wall);
  const base = pct(baseline, 0.5);
  console.log('baseline', stats(baseline));
  for (const [label, params] of [['sync', { mode: 'sync' }], ['async n=1', { n: 1 }], ['in-request n=2', { n: 2 }], ['in-request n=4', { n: 4 }], ['in-request n=8', { n: 8 }]]) {
    const walls = [];
    let failures = 0;
    let detail;
    for (let i = 0; i < 8; i++) {
      const result = await json('/s3/scrypt', params);
      if (result.http === 200) walls.push(result.wall - base);
      else { failures++; detail = JSON.stringify(result.body).slice(0, 160); }
    }
    console.log(label, walls.length ? stats(walls) : {}, 'failures', failures, detail ?? '');
  }
  for (const n of [2, 5, 10, 20]) {
    const results = await Promise.all(Array.from({ length: n }, () => json('/s3/scrypt', { n: 1 })));
    const ok = results.filter((r) => r.http === 200);
    console.log(`parallel requests=${n}`, ok.length ? stats(ok.map((r) => r.wall - base)) : {}, 'failures', n - ok.length, results.find((r) => r.http !== 200)?.body ?? '');
  }
}

async function s4() {
  console.log('time', (await json('/s4/time')).body);
  const { body: { conversation: c } } = await json('/s4/seed');
  console.log('rollback', (await json('/s4/rollback')).body);

  // Pattern 1: concurrent sends, with notes mixed in, must be gapless.
  const sends = await pool(50, 25, (i) => json('/s4/send', { c, ...(i % 5 === 0 ? { note: '1' } : {}) }));
  console.log('50 concurrent sends: ok', sends.filter((r) => r.body?.ok).length, 'server ms', stats(sends.filter((r) => r.body?.ok).map((r) => r.body.ms)), 'errors', [...new Set(sends.filter((r) => !r.body?.ok).map((r) => JSON.stringify(r.body).slice(0, 120)))]);
  console.log('check', (await json('/s4/check', { c })).body);

  // Replays racing each other must create one message.
  const replays = await pool(10, 10, () => json('/s4/send', { c, client: 'same-client-id' }));
  console.log('10 racing replays: ids', new Set(replays.map((r) => r.body?.result?.message?.id)).size, 'outcomes', [...new Set(replays.map((r) => r.body?.result?.outcome))]);
  console.log('check', (await json('/s4/check', { c })).body);

  // Pattern 2: concurrent CAS at one version must have exactly one winner, and one event.
  const { body: { conversation: fresh } } = await json('/s4/seed');
  const cas = await pool(20, 20, () => json('/s4/assign', { c: fresh, n: 1 }));
  const outcomes = {};
  for (const r of cas) { const k = r.body?.result?.outcome ?? 'error'; outcomes[k] = (outcomes[k] ?? 0) + 1; }
  console.log('20 concurrent CAS', outcomes);
  console.log('check', (await json('/s4/check', { c: fresh })).body);

  // Latency, then a moderate burst to see the overload shape.
  const walls = [];
  for (let i = 0; i < 30; i++) walls.push((await json('/s4/send', { c })).body.ms);
  console.log('sequential write ms', stats(walls));
  for (const n of [100]) {
    const limit = 40;
    const { body: { conversation: b } } = await json('/s4/seed');
    const burst = await pool(n, limit, () => json('/s4/send', { c: b }));
    const good = burst.filter((r) => r.body?.ok);
    const kinds = {};
    for (const r of burst.filter((x) => !x.body?.ok)) { const k = `${r.http}:${String(r.body?.error ?? r.body).slice(0, 100)}`; kinds[k] = (kinds[k] ?? 0) + 1; }
    console.log(`burst ${n}: ok`, good.length, 'server ms', good.length ? stats(good.map((r) => r.body.ms)) : {}, 'errors', kinds);
    console.log('check', (await json('/s4/check', { c: b })).body);
  }
}

async function s5() { console.log((await json('/s5/ed25519')).body); }

async function s6() {
  console.log('external', (await json('/s6/external')).body);
  console.log('binding', (await json('/s6/binding')).body);
  console.log('url, no flag', (await json('/s6/url', { url: `${PEER}/.well-known/openchat.json` })).body);
  const flagged = await fetch(`${FLAGGED}/?${new URLSearchParams({ url: `${PEER}/.well-known/openchat.json` })}`);
  console.log('url, with flag', flagged.status, (await flagged.text()).slice(0, 200));
}

await { s1, s3, s4, s5, s6 }[process.argv[2]]();
