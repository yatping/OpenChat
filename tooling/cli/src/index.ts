/** The operator CLI. `deploy` is the basic form from Milestone 1a, and `upgrade` and the polish arrive in Milestone 5. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeployer } from './deploy';
import { createVariantWriter } from './app-variant';
import { createRelayDeployer } from './relay';
import { renderConfig, type DeploymentState } from './render-config';
import { ABUSE_LIMITS } from '@openchat/shared';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage(): never {
  console.error(`Usage:
  pnpm oc preflight [--analytics] [--public-url <https origin>] [--cloudflare-email] [--email-from <address>]
  pnpm oc deploy --env <name> --owner-email <address> [--owner-name <name>] [--workspace <name>]
                 [--public-url <https origin>] [--location <hint>] [--analytics] [--cloudflare-email] [--email-from <address>]
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
  pnpm oc render --env <name> --service <api|notification-relay>

Your own notification relay, for your own iOS app and APNs key:
  pnpm oc relay deploy --env <name> [--relay-id <id>] [--environment <production|sandbox>] [--location <hint>]
  pnpm oc relay set-apns --env <name> --team-id <id> --key-id <id> --key-file <AuthKey.p8> --bundle-id <id>
  pnpm oc relay allow --env <name> --installation <inst_...> [--remove]
  pnpm oc relay block --env <name> --installation <inst_...> [--unblock]
  pnpm oc relay erase --env <name> --installation <inst_...>
  pnpm oc relay stats --env <name>
  pnpm oc relay check --env <name>

A white-label build of the iOS app, in apps/mobile/variants/<id>. Nothing in it is secret:
  pnpm oc app variant --id <id> --name <app name> --bundle-id <id>
                      (--relay-env <name> | --relay-url <https://...> --relay-id <id> | --no-push)
                      [--color <#rrggbb>] [--icon <1024px.png>] [--splash <png>]

RESEND_API_KEY and TURNSTILE_SECRET_KEY are read from the environment, so that they stay out of shell history.
TURNSTILE_SECRET_KEY needs --turnstile-site-key. Websites can then require Turnstile for new visitors.

Push, on deploy. All three together, and remembered for later deploys. The signing key is generated once:
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
if (command === 'app') {
  const [id, appName, bundleId] = [flag('id'), flag('name'), flag('bundle-id')];
  if (rest[0] !== 'variant' || !id || !appName || !bundleId) usage();
  try {
    createVariantWriter(root).create({
      id,
      appName,
      bundleId,
      relayEnv: flag('relay-env'),
      relayUrl: flag('relay-url'),
      relayId: flag('relay-id'),
      noPush: rest.includes('--no-push'),
      color: flag('color'),
      icon: userPath(flag('icon')),
      splash: userPath(flag('splash')),
    });
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  process.exit(0);
}
if (!env) usage();

async function relay(name: string) {
  const relays = createRelayDeployer(root);
  const sub = rest[0];
  if (sub === 'deploy') return relays.deploy({ name, relayId: flag('relay-id'), location: flag('location'), environment: flag('environment') });
  if (sub === 'set-apns') {
    const [teamId, keyId, keyFile, bundleId] = [flag('team-id'), flag('key-id'), flag('key-file'), flag('bundle-id')];
    if (!teamId || !keyId || !keyFile || !bundleId) usage();
    return relays.setApns(name, { teamId, keyId, keyFile: userPath(keyFile)!, bundleId });
  }
  if (sub === 'allow') {
    const installation = flag('installation');
    if (!installation) usage();
    return relays.allow(name, installation, rest.includes('--remove'));
  }
  if (sub === 'block') {
    const installation = flag('installation');
    if (!installation) usage();
    return relays.block(name, installation, rest.includes('--unblock'));
  }
  if (sub === 'erase') {
    const installation = flag('installation');
    if (!installation) usage();
    await relays.erase(name, installation);
    return;
  }
  if (sub === 'stats') {
    await relays.stats(name);
    return;
  }
  if (sub === 'check') {
    if (!(await relays.check(name))) process.exitCode = 1;
    return;
  }
  usage();
}

async function main(name: string) {
  if (command === 'relay') return relay(name);
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
