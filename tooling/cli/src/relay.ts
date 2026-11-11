/**
 * `oc relay`: an independent notification relay, for an operator who ships their own iOS app with their own
 * APNs key. See docs/operations/deployment.md#independent-relay. Like `oc deploy`, each step is recorded as it
 * finishes, so a failed run can be resumed, and a name that exists but was not created here stops the run.
 *
 * The relay's resources are `oc-<env>-relay`, beside an installation's `oc-<env>`, so that one environment
 * name can hold both.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isId } from '@openchat/shared';
import { parseTemplate } from './render-config';
import { createResource, describeFailure, type RunWrangler, sleep, UUID, wranglerIn } from './wrangler';

export interface RelayState {
  name: string;
  /** The audience a grant must carry. Installations are configured with it. */
  relayId: string;
  d1DatabaseId?: string;
  queuesCreated?: string[];
  /** Rate limit counters are shared by every Worker on an account that uses the same namespace ID. */
  ratelimitNamespaces?: [string, string];
  environment: 'production' | 'sandbox';
  bundleIds: string[];
  allowedInstallations: string[];
  apns?: { teamId: string; keyId: string; selfCheckTopic: string };
  tokenKeySet?: boolean;
  operatorTokenSet?: boolean;
  deployed?: boolean;
  url?: string;
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
const RELAY_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// Built from parts, so that the secret scan, which looks for this marker, does not flag the check itself.
const MARK = '-'.repeat(5);
const PRIVATE_KEY = new RegExp(`^${MARK}BEGIN PRIVATE KEY${MARK}\\r?\\n[A-Za-z0-9+/=\\r\\n]+${MARK}END PRIVATE KEY${MARK}\\s*$`);

export interface RelayStats {
  installations: number;
  blocked: number;
  devices: number;
  notifications: number;
  delivered: number;
  invalidTokens: number;
  failed: number;
  stuck: number;
  busiest?: { installation: string; notifications: number }[];
}

export const relayPrefix = (name: string) => `oc-${name}-relay`;

/** `relativeRoot` is the path from the rendered file back to the relay's directory. */
export function renderRelayConfig(templateSource: string, state: RelayState & { d1DatabaseId: string }, relativeRoot: string) {
  if (!NAME.test(state.name)) throw new Error('Environment names must be lowercase letters, numbers, and hyphens');
  if (!state.ratelimitNamespaces) throw new Error('The rate limit namespaces have not been chosen yet');
  const t = structuredClone(parseTemplate(templateSource));
  const prefix = relayPrefix(state.name);
  const rename = (value: string) => value.replace(/^oc-relay(-local)?/, prefix);
  const rebase = (path: string) => `${relativeRoot}/${path.replace(/^\.\//, '')}`;

  t.name = prefix;
  t.main = rebase(t.main);
  delete t.$schema;
  for (const db of t.d1_databases ?? []) {
    db.database_name = rename(db.database_name);
    db.database_id = state.d1DatabaseId;
    if (db.migrations_dir) db.migrations_dir = rebase(db.migrations_dir);
  }
  for (const producer of t.queues?.producers ?? []) producer.queue = rename(producer.queue);
  for (const consumer of t.queues?.consumers ?? []) {
    consumer.queue = rename(consumer.queue);
    if (consumer.dead_letter_queue) consumer.dead_letter_queue = rename(consumer.dead_letter_queue);
  }
  const limits = t.ratelimits as { namespace_id: string }[] | undefined;
  if (limits?.length !== 2) throw new Error('The relay template should have two rate limits');
  limits.forEach((limit, i) => (limit.namespace_id = state.ratelimitNamespaces![i]!));
  t.vars = {
    ...(t.vars as object | undefined),
    // Private, always. An open relay would accept any installation's grants, and send through this key.
    RELAY_MODE: 'private',
    RELAY_ID: state.relayId,
    RELAY_BUNDLE_IDS: state.bundleIds.join(','),
    RELAY_ALLOWED_INSTALLATIONS: state.allowedInstallations.join(','),
    APNS_ENVIRONMENT: state.environment,
    ...(state.apns ? { APNS_TEAM_ID: state.apns.teamId, APNS_KEY_ID: state.apns.keyId, APNS_SELF_CHECK_TOPIC: state.apns.selfCheckTopic } : {}),
  };
  return t;
}

/** Reads and checks a .p8 file. Its contents are never printed, even in an error. */
export function readApnsKey(path: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string {
  let contents: string;
  try {
    contents = read(path);
  } catch {
    throw new Error(`Could not read ${path}`);
  }
  if (!PRIVATE_KEY.test(contents)) throw new Error(`${path} does not look like an APNs key. Use the .p8 file Apple gave you, unchanged.`);
  return contents.trim();
}

export interface SetApnsOptions {
  teamId: string;
  keyId: string;
  keyFile: string;
  bundleId: string;
}

export interface RelayDeps {
  wrangler?: RunWrangler;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<unknown>;
  readKey?: (path: string) => string;
  log?: (line: string) => void;
}

type CheckResult = { outcome: string; status?: number; reason?: string };

export function createRelayDeployer(root: string, deps: RelayDeps = {}) {
  const wrangler = deps.wrangler ?? wranglerIn(root, '@openchat/notification-relay');
  const get = deps.fetch ?? ((input, init) => fetch(input, init));
  const wait = deps.wait ?? sleep;
  const log = deps.log ?? ((line: string) => console.log(line));

  const dirOf = (name: string) => join(root, '.openchat', name);
  const statePath = (name: string) => join(dirOf(name), 'relay.json');
  const operatorTokenPath = (name: string) => join(dirOf(name), 'relay-operator-token');
  const configPath = (name: string) => `../../.openchat/${name}/notification-relay.wrangler.jsonc`;

  const load = (name: string): RelayState | null => (existsSync(statePath(name)) ? (JSON.parse(readFileSync(statePath(name), 'utf8')) as RelayState) : null);
  const loadDeployed = (name: string): RelayState => {
    const state = load(name);
    if (!state?.deployed) throw new Error(`No relay named ${name}. Run: pnpm oc relay deploy --env ${name}`);
    return state;
  };
  const save = (state: RelayState) => {
    mkdirSync(dirOf(state.name), { recursive: true });
    writeFileSync(statePath(state.name), `${JSON.stringify(state, null, 2)}\n`);
  };

  /** Sent on stdin, so secrets touch neither the disk nor the process list. */
  const putSecrets = (state: RelayState, secrets: Record<string, string>) => {
    wrangler(['secret', 'bulk', '-c', configPath(state.name)], { input: JSON.stringify(secrets) });
  };

  function render(state: RelayState) {
    if (!state.d1DatabaseId) throw new Error('The database has not been created yet');
    const serviceDir = join(root, 'services/notification-relay');
    const out = join(dirOf(state.name), 'notification-relay.wrangler.jsonc');
    const rendered = renderRelayConfig(readFileSync(join(serviceDir, 'wrangler.template.jsonc'), 'utf8'), { ...state, d1DatabaseId: state.d1DatabaseId }, relative(dirname(out), serviceDir));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`);
  }

  async function createResources(state: RelayState, location: string | undefined) {
    const prefix = relayPrefix(state.name);
    const create = (label: string, args: string[]) => createResource(wrangler, label, args, wait);
    if (!state.d1DatabaseId) {
      log(`Creating database ${prefix}`);
      const id = UUID.exec(await create(`Database ${prefix}`, ['d1', 'create', prefix, ...(location ? ['--location', location] : [])]))?.[0];
      if (!id) throw new Error('Could not find the new database ID');
      state.d1DatabaseId = id;
      save(state);
    }
    state.queuesCreated ??= [];
    for (const queue of [`${prefix}-delivery-dlq`, `${prefix}-delivery`]) {
      if (state.queuesCreated.includes(queue)) continue;
      log(`Creating queue ${queue}`);
      await create(`Queue ${queue}`, ['queues', 'create', queue]);
      state.queuesCreated.push(queue);
      save(state);
    }
  }

  function deployWorker(state: RelayState) {
    render(state);
    log('Deploying the relay');
    const output = wrangler(['deploy', '-c', configPath(state.name)]);
    const url = /https:\/\/\S+\.workers\.dev/.exec(output)?.[0];
    if (url) state.url ??= url;
    state.deployed = true;
    save(state);
  }

  async function verify(state: RelayState) {
    let last = 'no answer';
    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await wait(5000);
      try {
        const health = await get(`${state.url}/health`);
        last = `health ${health.status}`;
        if (health.status === 200) return;
      } catch (error) {
        last = (error as Error).message;
      }
    }
    throw new Error(`The relay did not become healthy: ${last}`);
  }

  /** Asks the relay to send Apple a request that is sure to fail, and reads why. */
  async function check(state: RelayState): Promise<CheckResult> {
    if (!existsSync(operatorTokenPath(state.name))) throw new Error(`The operator token for ${state.name} is not on this computer`);
    const token = readFileSync(operatorTokenPath(state.name), 'utf8').trim();
    let last: CheckResult = { outcome: 'unreachable' };
    // A new secret or version can take a few seconds to reach every location.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await wait(5000);
      const response = await get(`${state.url}/v1/operator/apns-check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      if (response.status !== 200) {
        last = { outcome: 'unreachable', status: response.status };
        continue;
      }
      last = (await response.json()) as CheckResult;
      if (last.outcome === 'ok') return last;
    }
    return last;
  }

  const describeCheck = (state: RelayState, result: CheckResult): string => {
    switch (result.outcome) {
      case 'ok':
        return 'Apple accepted the key.';
      case 'not_configured':
        return 'No APNs key is set. Run: pnpm oc relay set-apns';
      case 'credential_error':
        return `Apple refused the key (${result.reason ?? result.status ?? 'no reason given'}). Check the team ID, the key ID, the .p8 file, and that the key allows ${state.environment}.`;
      case 'unreachable':
        return `Could not reach Apple from the relay${result.status ? `, or the relay answered ${result.status}` : ''}. Try again in a minute.`;
      default:
        return `Apple answered something unexpected (${result.status ?? ''} ${result.reason ?? ''}).`;
    }
  };

  const printNext = (state: RelayState) => {
    log(`\nRelay: ${state.url}`);
    log(`Relay ID: ${state.relayId}`);
    if (!state.apns) log(`\nNext, load your APNs key: pnpm oc relay set-apns --env ${state.name} --team-id <id> --key-id <id> --key-file <AuthKey.p8> --bundle-id <your app>`);
    if (state.allowedInstallations.length === 0) log(`Then admit your installation: pnpm oc relay allow --env ${state.name} --installation <inst_...>`);
  };

  const assertInstallationId = (id: string) => {
    if (!isId('installation', id)) throw new Error("An installation ID looks like inst_ followed by 26 characters. It is in the installation's /.well-known/openchat.json");
  };

  /** Only ever given numbers and checked IDs, so the SQL holds nothing from outside. */
  const query = <T>(state: RelayState, sql: string): T[] => {
    const output = wrangler(['d1', 'execute', relayPrefix(state.name), '--remote', '--yes', '--json', '-c', configPath(state.name), '--command', sql], { ci: true });
    return (JSON.parse(output) as { results?: T[] }[])[0]?.results ?? [];
  };

  /** Returns whether the installation has registered. */
  const setBlocked = (state: RelayState, installationId: string, blocked: boolean): boolean => {
    const output = wrangler(
      ['d1', 'execute', relayPrefix(state.name), '--remote', '--yes', '--json', '-c', configPath(state.name), '--command', `UPDATE installations SET status = '${blocked ? 'revoked' : 'active'}' WHERE id = '${installationId}'; SELECT count(*) AS n FROM installations WHERE id = '${installationId}'`],
      { ci: true },
    );
    const results = JSON.parse(output) as { results?: { n?: number }[] }[];
    return (results.at(-1)?.results?.[0]?.n ?? 0) > 0;
  };

  return {
    load,

    async deploy(options: { name: string; relayId?: string | undefined; location?: string | undefined; environment?: string | undefined }) {
      if (!NAME.test(options.name)) throw new Error('Environment names must be lowercase letters, numbers, and hyphens, starting with a letter, up to 41 characters');
      const existing = load(options.name);
      if (existing && options.relayId && options.relayId !== existing.relayId) throw new Error(`This relay's ID is ${existing.relayId}. Installations hold it, so it cannot change.`);
      const relayId = options.relayId ?? existing?.relayId ?? options.name;
      if (!RELAY_ID.test(relayId)) throw new Error('A relay ID is lowercase letters, numbers, and hyphens');
      if (options.environment && options.environment !== 'production' && options.environment !== 'sandbox') throw new Error('--environment is production or sandbox');
      const state: RelayState = existing ?? { name: options.name, relayId, environment: 'production', bundleIds: [], allowedInstallations: [] };
      if (options.environment) state.environment = options.environment as RelayState['environment'];
      // Large and random, so as not to share counters with any other Worker on the account.
      state.ratelimitNamespaces ??= [String(randomInt(100_000, 999_999_999)), String(randomInt(100_000, 999_999_999))];
      save(state);

      await createResources(state, options.location);
      render(state);
      log('Applying migrations');
      wrangler(['d1', 'migrations', 'apply', relayPrefix(state.name), '--remote', '-c', configPath(state.name)], { ci: true });
      deployWorker(state);
      if (!state.tokenKeySet) {
        // Only once: it encrypts every stored device token, and a new one would make them unreadable.
        log('Generating the token key');
        putSecrets(state, { RELAY_TOKEN_KEY: randomBytes(32).toString('base64url') });
        state.tokenKeySet = true;
        save(state);
      }
      if (!state.operatorTokenSet) {
        const token = randomBytes(32).toString('base64url');
        mkdirSync(dirOf(state.name), { recursive: true });
        writeFileSync(operatorTokenPath(state.name), `${token}\n`, { mode: 0o600 });
        chmodSync(operatorTokenPath(state.name), 0o600);
        putSecrets(state, { RELAY_OPERATOR_TOKEN: token });
        state.operatorTokenSet = true;
        save(state);
      }
      if (!state.url) throw new Error('Could not find the relay URL in what Wrangler printed');
      log('Verifying');
      await verify(state);
      printNext(state);
    },

    async setApns(name: string, options: SetApnsOptions) {
      const state = loadDeployed(name);
      if (!APPLE_ID.test(options.teamId)) throw new Error('--team-id is the 10 characters shown in your Apple developer account');
      if (!APPLE_ID.test(options.keyId)) throw new Error('--key-id is the 10 characters in the key file name, AuthKey_<key id>.p8');
      if (!BUNDLE_ID.test(options.bundleId)) throw new Error('--bundle-id looks like com.company.support');
      const key = readApnsKey(options.keyFile, deps.readKey);
      log('Setting the APNs key');
      try {
        putSecrets(state, { APNS_PRIVATE_KEY: key });
      } catch (error) {
        // Wrangler does not echo secret values, but say nothing more than it did.
        throw new Error(`Could not set the key:\n${describeFailure(error)}`, { cause: error });
      }
      state.apns = { teamId: options.teamId, keyId: options.keyId, selfCheckTopic: options.bundleId };
      if (!state.bundleIds.includes(options.bundleId)) state.bundleIds.push(options.bundleId);
      save(state);
      deployWorker(state);
      log('Checking the key with Apple');
      const result = await check(state);
      log(describeCheck(state, result));
      if (result.outcome !== 'ok') throw new Error('The key is set, but Apple did not accept it.');
      printNext(state);
    },

    async allow(name: string, installationId: string, remove: boolean) {
      const state = loadDeployed(name);
      assertInstallationId(installationId);
      const has = state.allowedInstallations.includes(installationId);
      if (remove ? !has : has) {
        log(remove ? `${installationId} was not admitted` : `${installationId} is already admitted`);
        return;
      }
      state.allowedInstallations = remove ? state.allowedInstallations.filter((id) => id !== installationId) : [...state.allowedInstallations, installationId];
      save(state);
      deployWorker(state);
      // The list is checked only when an installation first registers, so one already registered is cut off in the database.
      const registered = setBlocked(state, installationId, remove);
      if (remove) log(registered ? `Removed and blocked ${installationId}. Within 30 seconds, it can no longer send notifications.` : `Removed ${installationId}. It had not registered, so it cannot now.`);
      else log(`Admitted ${installationId}.`);
      log(`Admitted: ${state.allowedInstallations.join(', ') || 'none'}`);
    },

    /** Cuts off an installation that has registered, in either mode. Its devices stay, so unblocking restores it. */
    async block(name: string, installationId: string, unblock: boolean) {
      const state = loadDeployed(name);
      assertInstallationId(installationId);
      if (!setBlocked(state, installationId, !unblock)) throw new Error(`${installationId} has not registered with this relay`);
      log(unblock ? `Unblocked ${installationId}.` : `Blocked ${installationId}. Within 30 seconds, every request it signs is refused, so it can no longer send notifications.`);
    },

    /** Counts only. The relay holds no content to show. */
    async stats(name: string): Promise<RelayStats> {
      const state = loadDeployed(name);
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const [totals] = query<RelayStats>(
        state,
        `SELECT (SELECT count(*) FROM installations WHERE status = 'active') AS installations,
          (SELECT count(*) FROM installations WHERE status = 'revoked') AS blocked,
          (SELECT count(*) FROM devices) AS devices,
          (SELECT count(*) FROM notifications WHERE created_at > ${since}) AS notifications,
          (SELECT coalesce(sum(delivered), 0) FROM notifications WHERE created_at > ${since}) AS delivered,
          (SELECT coalesce(sum(invalid_token), 0) FROM notifications WHERE created_at > ${since}) AS invalidTokens,
          (SELECT coalesce(sum(failed), 0) FROM notifications WHERE created_at > ${since}) AS failed,
          (SELECT count(*) FROM notifications WHERE status IN ('queued', 'delivering') AND created_at < ${Date.now() - 10 * 60 * 1000}) AS stuck`,
      );
      const busiest = query<{ installation: string; notifications: number }>(
        state,
        `SELECT installation_id AS installation, count(*) AS notifications FROM notifications WHERE created_at > ${since} GROUP BY installation_id ORDER BY notifications DESC LIMIT 5`,
      );
      const stats = totals!;
      log(`Installations: ${stats.installations} active, ${stats.blocked} blocked`);
      log(`Devices: ${stats.devices}`);
      log(`Last 24 hours: ${stats.notifications} notifications, ${stats.delivered} delivered, ${stats.invalidTokens} to tokens Apple refused, ${stats.failed} failed`);
      if (stats.stuck > 0) log(`Waiting more than 10 minutes: ${stats.stuck}. Check the delivery queue.`);
      if (busiest.length > 0) log(`Busiest installations, last 24 hours:\n${busiest.map((b) => `  ${b.installation}  ${b.notifications}`).join('\n')}`);
      return { ...stats, busiest };
    },

    async check(name: string) {
      const state = loadDeployed(name);
      const result = await check(state);
      log(describeCheck(state, result));
      return result.outcome === 'ok';
    },
  };
}
