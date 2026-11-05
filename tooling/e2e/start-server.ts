/**
 * A local Worker for browser tests, with its own state and a throwaway key, so that it neither reads nor
 * changes anything from pnpm dev. Expects the dashboard to be built.
 *
 * E2E_PORT and E2E_NAME start a second copy beside the first. Every ID stays the same, which is how the iOS app is
 * tested against two installations with colliding IDs.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSerializedKey, hashPassword } from '@openchat/auth';
import { AGENT, OWNER, PASSWORD, SITE_ORIGIN, STYLED_WEBSITE_KEY, STYLED_WEBSITE_SETTINGS, TURNSTILE_TEST_SECRET, TURNSTILE_TEST_SITE_KEY, TURNSTILE_WEBSITE_KEY, WEBSITE_KEY, WORKSPACE_ID } from './tests/fixtures';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../../services/api');
const port = process.env.E2E_PORT ?? '8799';
const name = process.env.E2E_NAME ?? 'E2E';
const state = port === '8799' ? '.wrangler/e2e' : `.wrangler/e2e-${port}`;
rmSync(join(api, state), { recursive: true, force: true });
mkdirSync(join(api, state), { recursive: true });

const key = await generateSerializedKey(`e2e-${Date.now().toString(36)}`);
const envFile = `${state}/vars`;
writeFileSync(join(api, envFile), `ENVIRONMENT=development\nEMAIL_PROVIDER=console\nTURNSTILE_SITE_KEY=${TURNSTILE_TEST_SITE_KEY}\nTURNSTILE_SECRET_KEY=${TURNSTILE_TEST_SECRET}\nAUTH_SIGNING_KEY=${JSON.stringify({ active: key })}\n`);

const hash = await hashPassword(PASSWORD);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const seed = `
INSERT INTO installation (id, name, public_base_url, created_at, updated_at) VALUES ('inst_e2e', ${quote(name)}, ${quote(`http://localhost:${port}`)}, 1, 1);
INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (${quote(WORKSPACE_ID)}, ${quote(name)}, 'e2e', 1, 1);
INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES
  ('user_owner', ${quote(OWNER.email)}, ${quote(OWNER.name)}, ${quote(hash)}, 1, 1),
  ('user_agent', ${quote(AGENT.email)}, ${quote(AGENT.name)}, ${quote(hash)}, 1, 1);
INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES
  (${quote(OWNER.memberId)}, ${quote(WORKSPACE_ID)}, 'user_owner', 'owner', 'active', 1, 1),
  (${quote(AGENT.memberId)}, ${quote(WORKSPACE_ID)}, 'user_agent', 'agent', 'active', 1, 1);
INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, created_at, updated_at) VALUES
  ('site_e2e', ${quote(WORKSPACE_ID)}, 'Shop', ${quote(WEBSITE_KEY)}, ${quote(JSON.stringify([SITE_ORIGIN]))}, 1, 1);
INSERT INTO websites (id, workspace_id, name, website_key, allowed_origins_json, settings_json, created_at, updated_at) VALUES
  ('site_styled', ${quote(WORKSPACE_ID)}, 'Styled', ${quote(STYLED_WEBSITE_KEY)}, ${quote(JSON.stringify([SITE_ORIGIN]))}, ${quote(JSON.stringify(STYLED_WEBSITE_SETTINGS))}, 1, 1),
  ('site_turnstile', ${quote(WORKSPACE_ID)}, 'Checked', ${quote(TURNSTILE_WEBSITE_KEY)}, ${quote(JSON.stringify([SITE_ORIGIN]))}, '{"requireTurnstile":true}', 1, 1);
`;
const seedFile = `${state}/seed.sql`;
writeFileSync(join(api, seedFile), seed);

const wrangler = (...args: string[]) => ['exec', 'wrangler', ...args, '-c', 'wrangler.template.jsonc', '--persist-to', state];
const quiet = { cwd: api, stdio: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } } as const;
execFileSync('pnpm', wrangler('d1', 'migrations', 'apply', 'DB', '--local'), quiet);
execFileSync('pnpm', wrangler('d1', 'execute', 'DB', '--local', '--file', seedFile), quiet);
execFileSync('node', ['scripts/collect-assets.mjs'], quiet);

const server = spawn('pnpm', wrangler('dev', '--port', port, '--inspector-port', String(Number(port) + 1000), '--env-file', envFile, '--test-scheduled'), { ...quiet, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
