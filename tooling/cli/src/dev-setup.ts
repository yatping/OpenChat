/** pnpm dev:setup prepares local development. --reset removes local state first. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
wrangler('d1', 'migrations', 'apply', 'DB', '--local');
wrangler('d1', 'execute', 'DB', '--local', '--file', '../../packages/database/seed/dev.sql');
console.log('Local development is ready. Run pnpm dev.');
