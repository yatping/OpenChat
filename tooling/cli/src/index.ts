/** The operator CLI. `deploy` is the basic form from Milestone 1a, and `upgrade` and the polish arrive in Milestone 5. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeployer } from './deploy';
import { renderConfig, type DeploymentState } from './render-config';
import { releaseVersion } from './releases';
import { ABUSE_LIMITS } from '@openchat/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage(): never {
  console.error(`Usage:
  pnpm oc preflight [--analytics] [--public-url <https origin>] [--cloudflare-email] [--email-from <address>]
  pnpm oc deploy --env <name> --owner-email <address> [--owner-name <name>] [--workspace <name>]
                 [--public-url <https origin>] [--location <hint>] [--analytics] [--cloudflare-email] [--email-from <address>]
                 [--security-contact <mailto:...|https://...>[,...] | none] [--security-policy <https://...>]
                 [--source-url <https://...> | none]   where users get your source, if you changed the code
  pnpm oc upgrade --env <name>      after checking out a newer release
  pnpm oc rollback --env <name>     puts back the Worker from before the last upgrade
  pnpm oc recover --env <name> --email <address>
  pnpm oc health --env <name>       the operator health checks, with the token oc deploy kept
  pnpm oc backup --env <name> [--out <directory>]
                                    exports the database to this computer, and checks the export loads
  pnpm oc restore --env <name> --confirm <name> (--bookmark <bookmark> | --timestamp <time>)
                                    Time Travel, in place, within 30 days. Prints how to undo it
  pnpm oc restore --env <name> --confirm <name> --from <backup.sql>
                                    into a new database, which the Worker then uses. The old one is kept
  pnpm oc restore --env <name> --confirm <name> --database <name>
                                    back to a database kept by an earlier restore
  pnpm oc render --env <name>

RESEND_API_KEY and TURNSTILE_SECRET_KEY are read from the environment, so that they stay out of shell history.
TURNSTILE_SECRET_KEY needs --turnstile-site-key. Websites can then require Turnstile for new visitors.

Push to the iPhone app, on deploy, through a notification relay such as the managed one. All three together, and
remembered for later deploys. The signing key is generated once:
  --relay-url <https://...> --relay-id <id> --relay-bundle-ids <a,b>
  --no-relay   takes it out again. Disconnect in the dashboard first, so that the relay erases its records.

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
/** pnpm runs this from tooling/cli, so a relative path is taken from where the command was typed. */
const userPath = (value: string | undefined) => (value === undefined ? undefined : resolve(process.env.INIT_CWD ?? process.cwd(), value));

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
      noRelay: rest.includes('--no-relay'),
      securityContact: flag('security-contact'),
      securityPolicy: flag('security-policy'),
      sourceUrl: flag('source-url'),
      cloudflareEmail: rest.includes('--cloudflare-email'),
    });
    return;
  }
  if (command === 'upgrade') return deployer.upgrade(name);
  if (command === 'rollback') return deployer.rollback(name);
  if (command === 'health') {
    if (!(await deployer.health(name))) process.exitCode = 1;
    return;
  }
  if (command === 'backup') {
    await deployer.backup(name, { out: userPath(flag('out')) });
    return;
  }
  if (command === 'restore') {
    const confirm = flag('confirm');
    const [bookmark, timestamp, from, database] = [flag('bookmark'), flag('timestamp'), userPath(flag('from')), flag('database')];
    const given = [bookmark, timestamp, from, database].filter((v) => v !== undefined);
    if (given.length !== 1) usage();
    if (bookmark) await deployer.restore(name, { confirm, bookmark });
    else if (timestamp) await deployer.restore(name, { confirm, timestamp });
    else if (from) await deployer.restore(name, { confirm, from });
    else await deployer.restore(name, { confirm, database: database! });
    return;
  }
  if (command === 'recover') {
    const email = flag('email');
    if (!email) usage();
    await deployer.recover(name, email);
    return;
  }
  if (command !== 'render') usage();
  const dir = join(root, '.openchat', name);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as DeploymentState;
  const serviceDir = join(root, 'services', 'api');
  const out = join(dir, 'api.wrangler.jsonc');
  const rendered = renderConfig(readFileSync(join(serviceDir, 'wrangler.template.jsonc'), 'utf8'), state, relative(dirname(out), serviceDir), releaseVersion(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`);
  console.log(`Rendered ${relative(root, out)}`);
}

main(env).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
