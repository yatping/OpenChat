// Deploy a throwaway installation, verify it against real Cloudflare, and remove everything it created.
// Usage: node tooling/scripts/preview.mjs <name> [--keep]
// Removal only targets resources this run created, all named oc-<name>*.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
const keep = process.argv.includes('--keep');
if (!name || !/^preview-[a-z0-9-]+$/.test(name)) {
  console.error('The name must start with preview-, to avoid touching anything else.');
  process.exit(2);
}

const prefix = `oc-${name}`;
const wrangler = (args, opts = {}) => execFileSync('pnpm', ['--filter', '@openchat/api', 'exec', 'wrangler', ...args], { encoding: 'utf8', ...opts });
const undo = [];
const attempt = (label, fn) => {
  try {
    fn();
  } catch (error) {
    console.error(`Cleanup step failed: ${label}: ${error.message}`);
    process.exitCode = 1;
  }
};

// The Queues API has returned an unexplained error 10013 for a valid request, which is why this retries.
const withRetry = async (fn, attempts = 4) => {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (error) {
      if (i >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
};

const queues = ['notifications', 'email', 'jobs'].flatMap((q) => [`${prefix}-${q}-dlq`, `${prefix}-${q}`]);
let failed = false;
try {
  const created = wrangler(['d1', 'create', prefix], { stdio: ['ignore', 'pipe', 'inherit'] });
  const databaseId = created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  if (!databaseId) throw new Error('Could not find the new database ID');
  undo.push(['D1 database', () => wrangler(['d1', 'delete', prefix, '--skip-confirmation'], { stdio: 'inherit' })]);
  wrangler(['r2', 'bucket', 'create', `${prefix}-attachments`], { stdio: 'inherit' });
  undo.push(['R2 bucket', () => wrangler(['r2', 'bucket', 'delete', `${prefix}-attachments`], { stdio: 'inherit' })]);
  for (const queue of queues) {
    await withRetry(() => wrangler(['queues', 'create', queue], { stdio: 'inherit' }));
    undo.push([`queue ${queue}`, () => wrangler(['queues', 'delete', queue], { stdio: 'inherit' })]);
  }

  const dir = join('.openchat', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ name, d1DatabaseId: databaseId }));
  execFileSync('pnpm', ['oc', 'render', '--env', name, '--service', 'api'], { stdio: 'inherit' });
  const config = `../../${dir}/api.wrangler.jsonc`;

  wrangler(['d1', 'migrations', 'apply', prefix, '--remote', '-c', config], { stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  const output = wrangler(['deploy', '-c', config], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(output);
  undo.push(['Worker', () => wrangler(['delete', '--name', prefix, '--force'], { stdio: 'inherit' })]);
  // A Worker cannot be deleted while it consumes a queue, and a queue cannot be deleted while it is
  // bound to a Worker. Removing consumers first breaks the cycle. Undo steps run last-in, first-out.
  for (const queue of queues) {
    undo.push([`consumer ${queue}`, () => wrangler(['queues', 'consumer', 'remove', queue, prefix], { stdio: 'inherit' })]);
  }
  const url = output.match(/https:\/\/\S+\.workers\.dev/)?.[0];
  if (!url) throw new Error('Could not find the deployed URL');

  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const response = await fetch(`${url}/health`).catch(() => null);
    ok = response?.status === 200 && (await response.json()).status === 'ok';
  }
  if (!ok) throw new Error('/health did not become healthy');
  // Answers straight after a deploy can differ while it propagates, so every attempt is reported.
  let discoveryStatus = 0;
  for (let i = 0; i < 12 && discoveryStatus !== 503; i++) {
    const discovery = await fetch(`${url}/.well-known/openchat.json`);
    discoveryStatus = discovery.status;
    console.log(`discovery attempt ${i + 1}: ${discovery.status} ${discovery.headers.get('content-type')} ${(await discovery.text()).slice(0, 120)}`);
    if (discoveryStatus !== 503) await new Promise((r) => setTimeout(r, 5000));
  }
  if (discoveryStatus !== 503) throw new Error(`Expected 503 before initialisation, got ${discoveryStatus}`);
  const shell = await fetch(`${url}/`);
  if (!(await shell.text()).includes('<div id="root">')) throw new Error('The dashboard shell was not served');
  const scheduled = await fetch(`${url}/__scheduled`);
  if (scheduled.status !== 404) throw new Error(`The local cron trigger must not work in production, got ${scheduled.status}`);

  // The whole background path on the real platform: cron, queue, consumer, D1.
  let receipts = 0;
  // Cron has taken several minutes to start firing after a first deploy.
  for (let i = 0; i < 60 && receipts === 0; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const output = wrangler(['d1', 'execute', prefix, '--remote', '-c', config, '--json', '--command', 'SELECT count(*) AS n FROM job_receipts'], { stdio: ['ignore', 'pipe', 'ignore'] });
    receipts = JSON.parse(output)[0].results[0].n;
  }
  if (receipts === 0) throw new Error('No job reached the consumer within 10 minutes');
  console.log(`Background path works: ${receipts} job receipt(s).`);
  console.log(`Preview ${url} is healthy.`);
} catch (error) {
  failed = true;
  console.error(`Preview failed: ${error.message}`);
} finally {
  if (keep) {
    console.log('--keep given. Resources were not removed.');
  } else {
    for (const [label, fn] of undo.reverse()) attempt(label, fn);
    console.log('Teardown finished.');
  }
}
process.exit(failed ? 1 : (process.exitCode ?? 0));
