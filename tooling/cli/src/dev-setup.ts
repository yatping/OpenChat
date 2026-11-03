/** pnpm dev:setup prepares local development. --reset removes local state first. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateSerializedKey } from '@openchat/auth';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const api = join(root, 'services/api');
const wrangler = (...args: string[]) =>
  execFileSync('pnpm', ['exec', 'wrangler', ...args, '-c', 'wrangler.template.jsonc'], { cwd: api, stdio: 'inherit' });

if (process.argv.includes('--reset')) {
  rmSync(join(api, '.wrangler/state'), { recursive: true, force: true });
  console.log('Removed local state.');
}
if (!existsSync(join(api, '.dev.vars'))) {
  copyFileSync(join(api, '.dev.vars.example'), join(api, '.dev.vars'));
  console.log('Created services/api/.dev.vars');
}

// Local only, and regenerated freely, since .dev.vars is ignored by Git.
const varsPath = join(api, '.dev.vars');
const vars = readFileSync(varsPath, 'utf8');
if (!/^AUTH_SIGNING_KEY=\{/m.test(vars)) {
  const key = await generateSerializedKey(`dev-${Date.now().toString(36)}`);
  const line = `AUTH_SIGNING_KEY=${JSON.stringify({ active: key })}`;
  const without = vars.replace(/^AUTH_SIGNING_KEY=.*\n?/m, '');
  writeFileSync(varsPath, without.endsWith('\n') || without === '' ? without : `${without}\n`);
  appendFileSync(varsPath, `${line}\n`);
  console.log('Generated a local AUTH_SIGNING_KEY');
}
wrangler('d1', 'migrations', 'apply', 'DB', '--local');
wrangler('d1', 'execute', 'DB', '--local', '--file', '../../packages/database/seed/dev.sql');
console.log('Local development is ready. Run pnpm dev.');
