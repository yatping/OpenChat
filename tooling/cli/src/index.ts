/** The operator CLI. Phase 0 has only `render`; the rest arrives in Milestones 1a and 5. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderConfig, type DeploymentState } from './render-config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage(): never {
  console.error('Usage: pnpm oc render --env <name> --service <api|notification-relay>');
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (command !== 'render') usage();
const env = flag('env');
const service = flag('service') ?? 'api';
if (!env) usage();

const dir = join(root, '.openchat', env);
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as DeploymentState;
const serviceDir = join(root, 'services', service);
const out = join(dir, `${service}.wrangler.jsonc`);
const rendered = renderConfig(readFileSync(join(serviceDir, 'wrangler.template.jsonc'), 'utf8'), state, relative(dirname(out), serviceDir));
mkdirSync(dir, { recursive: true });
writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`);
console.log(`Rendered ${relative(root, out)}`);
