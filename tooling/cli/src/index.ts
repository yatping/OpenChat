/** The operator CLI. `deploy` is the basic form from Milestone 1a, and `upgrade` and the polish arrive in Milestone 5. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeployer } from './deploy';
import { renderConfig, type DeploymentState } from './render-config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage(): never {
  console.error(`Usage:
  pnpm oc preflight [--analytics] [--public-url <https origin>] [--email-from <address>]
  pnpm oc deploy --env <name> --owner-email <address> [--owner-name <name>] [--workspace <name>]
                 [--public-url <https origin>] [--location <hint>] [--analytics] [--email-from <address>]
  pnpm oc recover --env <name> --email <address>
  pnpm oc render --env <name> --service <api|notification-relay>

RESEND_API_KEY is read from the environment, so that it stays out of shell history.`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const env = flag('env');

if (command === 'preflight') {
  const ready = createDeployer(root).preflight({ analytics: rest.includes('--analytics'), emailFrom: flag('email-from'), publicUrl: flag('public-url') });
  process.exit(ready ? 0 : 1);
}
if (!env) usage();

async function main(name: string) {
  const deployer = createDeployer(root);
  if (command === 'deploy') {
    await deployer.deploy({
      name,
      ownerEmail: flag('owner-email'),
      ownerName: flag('owner-name'),
      workspaceName: flag('workspace'),
      publicUrl: flag('public-url'),
      location: flag('location'),
      analytics: rest.includes('--analytics'),
      emailFrom: flag('email-from'),
    });
    return;
  }
  if (command === 'recover') {
    const email = flag('email');
    if (!email) usage();
    await deployer.recover(name, email);
    return;
  }
  if (command !== 'render') usage();
  const service = flag('service') ?? 'api';
  const dir = join(root, '.openchat', name);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as DeploymentState;
  const serviceDir = join(root, 'services', service);
  const out = join(dir, `${service}.wrangler.jsonc`);
  const rendered = renderConfig(readFileSync(join(serviceDir, 'wrangler.template.jsonc'), 'utf8'), state, relative(dirname(out), serviceDir));
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(`Rendered ${relative(root, out)}`);
}

main(env).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
