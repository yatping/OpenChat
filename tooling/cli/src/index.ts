/** The operator CLI. `deploy` is the basic form from Milestone 1a, and `upgrade` and the polish arrive in Milestone 5. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeployer } from './deploy';
import { renderConfig, type DeploymentState } from './render-config';
import { ABUSE_LIMITS } from '@openchat/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage(): never {
  console.error(`Usage:
  pnpm oc preflight [--analytics] [--public-url <https origin>] [--cloudflare-email] [--email-from <address>]
  pnpm oc deploy --env <name> --owner-email <address> [--owner-name <name>] [--workspace <name>]
                 [--public-url <https origin>] [--location <hint>] [--analytics] [--cloudflare-email] [--email-from <address>]
  pnpm oc recover --env <name> --email <address>
  pnpm oc render --env <name> --service <api|notification-relay>

RESEND_API_KEY and TURNSTILE_SECRET_KEY are read from the environment, so that they stay out of shell history.
TURNSTILE_SECRET_KEY needs --turnstile-site-key. Websites can then require Turnstile for new visitors.

Push, on deploy. All three together, and remembered for later deploys. The signing key is generated once:
  --relay-url <https://...> --relay-id <id> --relay-bundle-ids <a,b>

Limits for every website, on deploy. Each is remembered for later deploys, and "default" goes back to its default:
${Object.values(ABUSE_LIMITS).map((limit) => `  --${limit.flag} <${limit.min} to ${limit.max}>, default ${limit.default}`).join('\n')}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const env = flag('env');

if (command === 'preflight') {
  const ready = createDeployer(root).preflight({ analytics: rest.includes('--analytics'), emailFrom: flag('email-from'), publicUrl: flag('public-url'), cloudflareEmail: rest.includes('--cloudflare-email') });
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
      turnstileSiteKey: flag('turnstile-site-key'),
      limitFlag: flag,
      relayUrl: flag('relay-url'),
      relayId: flag('relay-id'),
      relayBundleIds: flag('relay-bundle-ids'),
      cloudflareEmail: rest.includes('--cloudflare-email'),
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
