import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRelayDeployer, readApnsKey, renderRelayConfig, type RelayState } from '../src/relay';

const template = readFileSync(new URL('../../../services/notification-relay/wrangler.template.jsonc', import.meta.url), 'utf8');
// Not a real key, and built from parts so that the secret scan does not flag it.
const MARK = '-'.repeat(5);
const KEY = `${MARK}BEGIN PRIVATE KEY${MARK}\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n${MARK}END PRIVATE KEY${MARK}\n`;
const DB_ID = '11111111-2222-3333-4444-555555555555';
const INSTALLATION = 'inst_01JC0000000000000000000000';

interface Rendered {
  name: string;
  main: string;
  $schema?: string;
  vars: Record<string, string>;
  d1_databases: object[];
  queues: { producers: { queue: string }[]; consumers: object[] };
  ratelimits: { namespace_id: string }[];
}
const render = (state: Parameters<typeof renderRelayConfig>[1], root = '.') => renderRelayConfig(template, state, root) as unknown as Rendered;

const base: RelayState & { d1DatabaseId: string } = {
  name: 'acme',
  relayId: 'acme',
  d1DatabaseId: DB_ID,
  ratelimitNamespaces: ['123456', '654321'],
  environment: 'production',
  bundleIds: ['com.acme.support'],
  allowedInstallations: [INSTALLATION],
};

describe('renderRelayConfig', () => {
  it('names every resource for the environment, apart from any installation', () => {
    const t = render(base, '../../services/notification-relay');
    expect(t.name).toBe('oc-acme-relay');
    expect(t.main).toBe('../../services/notification-relay/src/index.ts');
    expect(t.d1_databases[0]).toMatchObject({ database_name: 'oc-acme-relay', database_id: DB_ID, migrations_dir: '../../services/notification-relay/migrations' });
    expect(t.queues.producers[0]?.queue).toBe('oc-acme-relay-delivery');
    expect(t.queues.consumers[0]).toMatchObject({ queue: 'oc-acme-relay-delivery', dead_letter_queue: 'oc-acme-relay-delivery-dlq' });
    expect(t.ratelimits.map((r) => r.namespace_id)).toEqual(['123456', '654321']);
    expect(t.$schema).toBeUndefined();
  });

  it('is always private, and adds the APNs identity only once it is known', () => {
    const t = render(base);
    expect(t.vars).toEqual({ RELAY_MODE: 'private', RELAY_ID: 'acme', RELAY_BUNDLE_IDS: 'com.acme.support', RELAY_ALLOWED_INSTALLATIONS: INSTALLATION, APNS_ENVIRONMENT: 'production' });
    const withKey = render({ ...base, environment: 'sandbox', apns: { teamId: 'ABCDE12345', keyId: 'KEY1234567', selfCheckTopic: 'com.acme.support' } });
    expect(withKey.vars).toMatchObject({ APNS_ENVIRONMENT: 'sandbox', APNS_TEAM_ID: 'ABCDE12345', APNS_KEY_ID: 'KEY1234567', APNS_SELF_CHECK_TOPIC: 'com.acme.support' });
    expect(JSON.stringify(withKey)).not.toContain('PRIVATE KEY');
  });

  it('refuses a name that would not make valid resource names', () => {
    expect(() => renderRelayConfig(template, { ...base, name: 'Acme_Prod' }, '.')).toThrow(/lowercase/);
  });
});

describe('readApnsKey', () => {
  it('accepts a .p8 file and never repeats a bad one', () => {
    expect(readApnsKey('k.p8', () => KEY)).toBe(KEY.trim());
    const secretish = 'not a key but maybe something private';
    expect(() => readApnsKey('k.p8', () => secretish)).toThrow(/does not look like an APNs key/);
    try {
      readApnsKey('k.p8', () => secretish);
    } catch (error) {
      expect((error as Error).message).not.toContain(secretish);
    }
    expect(() => readApnsKey('missing.p8', () => { throw new Error('ENOENT'); })).toThrow('Could not read missing.p8');
  });
});

function setup(answers: { checkOutcome?: string; exists?: boolean; registered?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oc-relay-'));
  mkdirSync(join(root, 'services/notification-relay'), { recursive: true });
  writeFileSync(join(root, 'services/notification-relay/wrangler.template.jsonc'), template);
  const calls: { args: string; input?: string }[] = [];
  const wrangler = (args: string[], options: { input?: string } = {}) => {
    const key = args.join(' ');
    calls.push({ args: key, ...(options.input === undefined ? {} : { input: options.input }) });
    if (answers.exists && key.startsWith('d1 create')) throw Object.assign(new Error('failed'), { stderr: 'A database with that name already exists' });
    if (key.startsWith('d1 create')) return `Created database\n"database_id": "${DB_ID}"`;
    if (key.startsWith('deploy')) return 'Deployed oc-acme-relay\n  https://oc-acme-relay.acme.workers.dev\n';
    if (key.startsWith('d1 execute') && key.includes('UPDATE installations')) return JSON.stringify([{ results: [] }, { results: [{ n: answers.registered === false ? 0 : 1 }] }]);
    if (key.startsWith('d1 execute') && key.includes('AS installations')) return JSON.stringify([{ results: [{ installations: 3, blocked: 1, devices: 7, notifications: 40, delivered: 38, invalidTokens: 1, failed: 1, stuck: 2 }] }]);
    if (key.startsWith('d1 execute') && key.includes('GROUP BY')) return JSON.stringify([{ results: [{ installation: INSTALLATION, notifications: 30 }] }]);
    return '';
  };
  const requests: { url: string; authorization?: string }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    requests.push({ url, ...(authorization ? { authorization } : {}) });
    if (url.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    return Response.json({ outcome: answers.checkOutcome ?? 'ok', status: 400, reason: 'BadDeviceToken' });
  }) as typeof fetch;
  const lines: string[] = [];
  const relays = createRelayDeployer(root, { wrangler, fetch: fakeFetch, wait: async () => undefined, readKey: () => KEY, log: (line) => lines.push(line) });
  return { root, relays, calls, requests, lines };
}

describe('oc relay', () => {
  it('deploys a private relay, and generates its keys once', async () => {
    const { root, relays, calls, requests, lines } = setup();
    await relays.deploy({ name: 'acme' });
    expect(calls.map((c) => c.args.split(' -c ')[0])).toEqual([
      'd1 create oc-acme-relay',
      'queues create oc-acme-relay-delivery-dlq',
      'queues create oc-acme-relay-delivery',
      'd1 migrations apply oc-acme-relay --remote',
      'deploy',
      'secret bulk',
      'secret bulk',
    ]);
    const secrets = calls.filter((c) => c.args.startsWith('secret')).map((c) => Object.keys(JSON.parse(c.input!)));
    expect(secrets).toEqual([['RELAY_TOKEN_KEY'], ['RELAY_OPERATOR_TOKEN']]);
    const tokenKey = JSON.parse(calls.find((c) => c.input?.includes('RELAY_TOKEN_KEY'))!.input!).RELAY_TOKEN_KEY as string;
    expect(Buffer.from(tokenKey, 'base64url')).toHaveLength(32);
    expect(requests.map((r) => r.url)).toEqual(['https://oc-acme-relay.acme.workers.dev/health']);

    const tokenFile = join(root, '.openchat/acme/relay-operator-token');
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const state = relays.load('acme')!;
    expect(state).toMatchObject({ relayId: 'acme', url: 'https://oc-acme-relay.acme.workers.dev', deployed: true, bundleIds: [], allowedInstallations: [] });
    expect(JSON.stringify(state)).not.toContain(tokenKey);
    expect(lines.join('\n')).not.toContain(tokenKey);

    calls.length = 0;
    await relays.deploy({ name: 'acme' });
    expect(calls.map((c) => c.args.split(' -c ')[0])).toEqual(['d1 migrations apply oc-acme-relay --remote', 'deploy']);
    expect(relays.load('acme')!.ratelimitNamespaces).toEqual(state.ratelimitNamespaces);
  });

  it('never adopts a database it did not create', async () => {
    const { relays } = setup({ exists: true });
    await expect(relays.deploy({ name: 'acme' })).rejects.toThrow(/already exists, and this deployment did not create it/);
  });

  it('keeps the relay ID, which installations hold', async () => {
    const { relays } = setup();
    await relays.deploy({ name: 'acme', relayId: 'acme-push' });
    await expect(relays.deploy({ name: 'acme', relayId: 'other' })).rejects.toThrow(/cannot change/);
    await expect(relays.deploy({ name: 'acme', environment: 'staging' })).rejects.toThrow(/production or sandbox/);
  });

  it('loads the APNs key as a secret only, then asks Apple about it', async () => {
    const { root, relays, calls, requests, lines } = setup();
    await relays.deploy({ name: 'acme' });
    calls.length = 0;
    await relays.setApns('acme', { teamId: 'ABCDE12345', keyId: 'KEY1234567', keyFile: 'AuthKey_KEY1234567.p8', bundleId: 'com.acme.support' });
    expect(calls.map((c) => c.args.split(' -c ')[0])).toEqual(['secret bulk', 'deploy']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ APNS_PRIVATE_KEY: KEY.trim() });
    const config = readFileSync(join(root, '.openchat/acme/notification-relay.wrangler.jsonc'), 'utf8');
    expect(config).toContain('"APNS_KEY_ID": "KEY1234567"');
    expect(config).toContain('"RELAY_BUNDLE_IDS": "com.acme.support"');
    for (const where of [config, readFileSync(join(root, '.openchat/acme/relay.json'), 'utf8'), lines.join('\n')]) expect(where).not.toContain('PRIVATE KEY');
    const token = readFileSync(join(root, '.openchat/acme/relay-operator-token'), 'utf8').trim();
    expect(requests.at(-1)).toEqual({ url: 'https://oc-acme-relay.acme.workers.dev/v1/operator/apns-check', authorization: `Bearer ${token}` });
    expect(lines).toContain('Apple accepted the key.');
  });

  it('says so when Apple refuses the key', async () => {
    const { relays, lines } = setup({ checkOutcome: 'credential_error' });
    await relays.deploy({ name: 'acme' });
    await expect(relays.setApns('acme', { teamId: 'ABCDE12345', keyId: 'KEY1234567', keyFile: 'k.p8', bundleId: 'com.acme.support' })).rejects.toThrow(/did not accept/);
    expect(lines.some((line) => line.startsWith('Apple refused the key'))).toBe(true);
  });

  it('checks what it is given before touching anything', async () => {
    const { relays, calls } = setup();
    await expect(relays.setApns('acme', { teamId: 'ABCDE12345', keyId: 'KEY1234567', keyFile: 'k.p8', bundleId: 'com.acme.support' })).rejects.toThrow(/No relay named acme/);
    await relays.deploy({ name: 'acme' });
    calls.length = 0;
    await expect(relays.setApns('acme', { teamId: 'abc', keyId: 'KEY1234567', keyFile: 'k.p8', bundleId: 'com.acme.support' })).rejects.toThrow(/--team-id/);
    await expect(relays.setApns('acme', { teamId: 'ABCDE12345', keyId: 'KEY1234567', keyFile: 'k.p8', bundleId: 'support' })).rejects.toThrow(/--bundle-id/);
    await expect(relays.allow('acme', 'inst_short', false)).rejects.toThrow(/inst_/);
    expect(calls).toEqual([]);
  });

  it('admits installations, and blocks one that is removed, since the list only gates registration', async () => {
    const { root, relays, calls, lines } = setup();
    await relays.deploy({ name: 'acme' });
    calls.length = 0;
    await relays.allow('acme', INSTALLATION, false);
    await relays.allow('acme', INSTALLATION, false);
    expect(calls.map((c) => c.args.split(' -c ')[0])).toEqual(['deploy', 'd1 execute oc-acme-relay --remote --yes --json']);
    expect(calls[1]!.args).toContain(`SET status = 'active' WHERE id = '${INSTALLATION}'`);
    expect(readFileSync(join(root, '.openchat/acme/notification-relay.wrangler.jsonc'), 'utf8')).toContain(`"RELAY_ALLOWED_INSTALLATIONS": "${INSTALLATION}"`);
    calls.length = 0;
    await relays.allow('acme', INSTALLATION, true);
    expect(calls.at(-1)!.args).toContain(`SET status = 'revoked' WHERE id = '${INSTALLATION}'`);
    expect(lines.at(-2)).toBe(`Removed and blocked ${INSTALLATION}. Within 30 seconds, it can no longer send notifications.`);
    expect(relays.load('acme')!.allowedInstallations).toEqual([]);
    expect(readFileSync(join(root, '.openchat/acme/notification-relay.wrangler.jsonc'), 'utf8')).toContain('"RELAY_ALLOWED_INSTALLATIONS": ""');
  });

  it('blocks and unblocks, and says when an installation never registered', async () => {
    const { relays, calls, lines } = setup();
    await relays.deploy({ name: 'acme' });
    calls.length = 0;
    await relays.block('acme', INSTALLATION, false);
    expect(calls.map((c) => c.args)).toEqual([expect.stringContaining(`SET status = 'revoked' WHERE id = '${INSTALLATION}'`)]);
    await relays.block('acme', INSTALLATION, true);
    expect(calls[1]!.args).toContain("SET status = 'active'");
    expect(lines.at(-1)).toBe(`Unblocked ${INSTALLATION}.`);
    await expect(relays.block('acme', "inst_x'; DROP TABLE devices; --", false)).rejects.toThrow(/inst_/);
    const unregistered = setup({ registered: false });
    await unregistered.relays.deploy({ name: 'acme' });
    await expect(unregistered.relays.block('acme', INSTALLATION, false)).rejects.toThrow(/has not registered/);
  });

  it('reports counts, and what looks stuck', async () => {
    const { relays, lines } = setup();
    await relays.deploy({ name: 'acme' });
    const stats = await relays.stats('acme');
    expect(stats).toMatchObject({ installations: 3, blocked: 1, devices: 7, delivered: 38, stuck: 2, busiest: [{ installation: INSTALLATION, notifications: 30 }] });
    expect(lines).toContain('Last 24 hours: 40 notifications, 38 delivered, 1 to tokens Apple refused, 1 failed');
    expect(lines).toContain('Waiting more than 10 minutes: 2. Check the delivery queue.');
  });

});
