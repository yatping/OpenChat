/**
 * The upgrade test: a release's Worker writes data, this checkout's migrations and Worker take over the same
 * database, and then the old Worker runs again against the new schema, as it would after `oc rollback`.
 * Local only, with Wrangler's local D1 and Durable Objects, so it needs no Cloudflare account.
 *
 *   pnpm test:upgrade [--from v0.1.0]
 *
 * See docs/operations/deployment.md#upgrades.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSerializedKey, hashPassword } from '@openchat/auth';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex >= 0 ? process.argv[fromIndex + 1]! : 'v0.1.0';
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = 'https://shop.example';
const EMAIL = 'owner@example.com';
const PASSWORD = 'upgrade test password';
const WORKSPACE = 'work_01JCUPGRADE000000000000000';
const WEBSITE_KEY = 'pk_upgrade_test';

const work = mkdtempSync(join(tmpdir(), 'oc-upgrade-test-'));
const oldTree = join(work, 'old');
const persist = join(work, 'state');
const quiet = { stdio: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } } as const;
const step = (text: string) => console.log(`\n== ${text}`);

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`Failed: ${what}`);
  console.log(`  ok  ${what}`);
}

function prepareTree(tree: string) {
  // Only the API is tested, so the dashboard need not be built.
  mkdirSync(join(tree, 'services/api/.assets'), { recursive: true });
}

const wranglerArgs = (...args: string[]) => ['exec', 'wrangler', ...args, '-c', 'wrangler.template.jsonc', '--persist-to', persist];
const migrate = (tree: string) => execFileSync('pnpm', wranglerArgs('d1', 'migrations', 'apply', 'DB', '--local'), { ...quiet, cwd: join(tree, 'services/api') });

let running: ChildProcess | undefined;

async function start(tree: string, vars: string): Promise<ChildProcess> {
  const server = spawn('pnpm', wranglerArgs('dev', '--port', String(PORT), '--env-file', vars), { ...quiet, cwd: join(tree, 'services/api'), detached: true });
  running = server;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).status === 200) return server;
    } catch {
      // Not listening yet.
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  stop(server);
  throw new Error(`The Worker in ${tree} did not start`);
}

function stop(server: ChildProcess) {
  // The whole group, so that workerd goes too.
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

async function call<T = Record<string, unknown>>(method: string, path: string, options: { token?: string; body?: unknown; origin?: boolean } = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(options.origin ? { origin: ORIGIN } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const login = async () => {
  const result = await call<{ accessToken: string }>('POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PASSWORD, clientType: 'dashboard' } });
  check(result.status === 200, 'the owner signs in');
  return result.body.accessToken;
};
async function memberMessages(token: string, conversationId: string) {
  const result = await call<{ data: { content: string }[] }>('GET', `/api/v1/workspaces/${WORKSPACE}/conversations/${conversationId}/messages`, { token });
  check(result.status === 200, 'the agent reads the conversation');
  return result.body.data.map((m) => m.content);
}
const reply = async (token: string, conversationId: string, content: string, type: 'text' | 'internal_note' = 'text') =>
  (await call('POST', `/api/v1/workspaces/${WORKSPACE}/conversations/${conversationId}/messages`, { token, body: { clientMessageId: crypto.randomUUID(), type, content } })).status;
const visitorSays = async (token: string, conversationId: string, content: string) =>
  (await call('POST', `/api/v1/widget/conversations/${conversationId}/messages`, { token, origin: true, body: { clientMessageId: crypto.randomUUID(), content } })).status;
async function visitorSees(token: string, conversationId: string) {
  const result = await call<{ data: { content: string }[] }>('GET', `/api/v1/widget/conversations/${conversationId}/messages`, { token, origin: true });
  check(result.status === 200, 'the visitor reads the conversation');
  return result.body.data.map((m) => m.content);
}

async function main() {
  step(`Checking out ${from}`);
  execFileSync('git', ['worktree', 'add', '--detach', oldTree, from], { cwd: repo, stdio: 'ignore' });
  execFileSync('pnpm', ['install', '--frozen-lockfile'], { ...quiet, cwd: oldTree });
  prepareTree(oldTree);
  prepareTree(repo);

  const vars = join(work, 'vars');
  const key = await generateSerializedKey(`upgrade-${Date.now().toString(36)}`);
  writeFileSync(vars, `ENVIRONMENT=development\nEMAIL_PROVIDER=console\nAUTH_SIGNING_KEY=${JSON.stringify({ active: key })}\n`);
  const seed = join(work, 'seed.sql');
  const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(
    seed,
    `INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_01JCUPGRADE000000000000000', 'Upgrade', ${q(BASE)}, 1, 1);
INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (${q(WORKSPACE)}, 'Upgrade', 'upgrade', 1, 1);
INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) VALUES ('user_upgrade', ${q(EMAIL)}, 'Owner', ${q(await hashPassword(PASSWORD))}, 1, 1, 1);
INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES ('mem_upgrade', ${q(WORKSPACE)}, 'user_upgrade', 'supervisor', 'active', 1, 1);
INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES ('site_upgrade', ${q(WORKSPACE)}, 'Shop', ${q(WEBSITE_KEY)}, ${q(JSON.stringify([ORIGIN]))}, 1, 1);
`,
  );

  step(`${from}: migrate, seed, and write`);
  migrate(oldTree);
  execFileSync('pnpm', wranglerArgs('d1', 'execute', 'DB', '--local', '--file', seed), { ...quiet, cwd: join(oldTree, 'services/api') });
  let server = await start(oldTree, vars);
  let token = await login();
  const session = await call<{ accessToken: string }>('POST', '/api/v1/widget/sessions', { origin: true, body: { websiteKey: WEBSITE_KEY } });
  check(session.status === 201 || session.status === 200, 'a visitor starts a session');
  const visitor = session.body.accessToken;
  const conversation = await call<{ id: string }>('POST', '/api/v1/widget/conversations', { origin: true, token: visitor, body: { clientMessageId: crypto.randomUUID(), content: 'hello from before the upgrade' } });
  check(conversation.status === 201, 'the visitor starts a conversation');
  const id = conversation.body.id;
  check((await reply(token, id, 'reply from before the upgrade')) === 201, 'the agent replies');
  check((await reply(token, id, 'note from before the upgrade', 'internal_note')) === 201, 'the agent writes an internal note');
  stop(server);

  step('This checkout: migrate the same database, then run');
  migrate(repo);
  server = await start(repo, vars);
  const before = await memberMessages(token, id);
  check(before.includes('hello from before the upgrade') && before.includes('note from before the upgrade'), 'a session from before the upgrade still works, and sees the old messages');
  token = await login();
  check((await visitorSays(visitor, id, 'hello after the upgrade')) === 201, "the visitor's old session still works");
  check((await reply(token, id, 'reply after the upgrade')) === 201, 'the agent replies');
  check(!(await visitorSees(visitor, id)).includes('note from before the upgrade'), 'the visitor still cannot see the internal note');
  stop(server);

  step(`Rollback: ${from} again, on the new schema`);
  server = await start(oldTree, vars);
  token = await login();
  const after = await memberMessages(token, id);
  check(after.includes('hello after the upgrade') && after.includes('reply after the upgrade'), `${from} reads what this checkout wrote`);
  check((await visitorSays(visitor, id, 'hello after the rollback')) === 201, 'the visitor writes');
  check((await reply(token, id, 'reply after the rollback')) === 201, 'the agent replies');
  const visitorView = await visitorSees(visitor, id);
  check(visitorView.includes('reply after the rollback') && !visitorView.includes('note from before the upgrade'), 'the visitor sees the reply, and not the note');
  stop(server);
  console.log(`\nUpgrade from ${from}, and rollback, passed.`);
}

try {
  await main();
} finally {
  if (running) stop(running);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', oldTree], { cwd: repo, stdio: 'ignore' });
  } catch {
    // It was never added.
  }
  rmSync(work, { recursive: true, force: true });
}
