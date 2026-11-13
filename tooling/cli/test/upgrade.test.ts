import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDeployer, type State } from '../src/deploy';
import { compareVersions } from '../src/releases';

const template = readFileSync(new URL('../../../services/api/wrangler.template.jsonc', import.meta.url), 'utf8');
const BASE = 'https://oc-acme.acme.workers.dev';
const OLD_VERSION = 'aaaaaaaa-0000-0000-0000-000000000000';
const BOOKMARK = '00000003-00000000-0000511b-15233f10c52b5ad69bdbbcdb0d1708a4';

interface Options {
  release?: string;
  state?: Partial<State>;
  failMigration?: boolean;
  /** The new Worker answers 500 to everything. */
  unhealthyAfterDeploy?: boolean;
  defaultLog?: boolean;
}

function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oc-upgrade-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: options.release ?? '0.2.0' }));
  mkdirSync(join(root, 'services/api'), { recursive: true });
  writeFileSync(join(root, 'services/api/wrangler.template.jsonc'), template);
  mkdirSync(join(root, '.openchat/acme'), { recursive: true });
  const initial: State = { name: 'acme', d1DatabaseId: '11111111-2222-3333-4444-555555555555', deployed: true, initialized: true, secretsSet: true, publicBaseUrl: BASE, ...options.state };
  writeFileSync(join(root, '.openchat/acme/state.json'), JSON.stringify(initial));

  let deployed = false;
  let rolledBack = false;
  const calls: string[] = [];
  const wrangler = (args: string[]) => {
    const key = args.filter((a) => !a.startsWith('../')).join(' ').replace(/ -c$/, '');
    calls.push(key);
    if (key === 'whoami --json') return JSON.stringify({ loggedIn: true, accounts: [{ name: 'Acme' }] });
    if (key.startsWith('deployments status')) return JSON.stringify({ versions: [{ version_id: 'canary', percentage: 10 }, { version_id: OLD_VERSION, percentage: 90 }] });
    if (key.startsWith('d1 time-travel info')) return JSON.stringify({ bookmark: BOOKMARK });
    if (key.startsWith('d1 migrations apply') && options.failMigration) throw Object.assign(new Error('failed'), { stderr: 'Migration 0009 failed' });
    if (key === 'deploy') deployed = true;
    if (key.startsWith('rollback')) rolledBack = true;
    return '';
  };
  const fakeFetch = (async (url: string) => {
    if (deployed && !rolledBack && options.unhealthyAfterDeploy) return new Response('', { status: 500 });
    if (url.endsWith('/auth/login')) return new Response('', { status: 401 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const lines: string[] = [];
  let builds = 0;
  const deployer = createDeployer(root, { wrangler, fetch: fakeFetch, wait: async () => undefined, build: () => void builds++, ...(options.defaultLog ? {} : { log: (line: string) => void lines.push(line) }) });
  const state = () => JSON.parse(readFileSync(join(root, '.openchat/acme/state.json'), 'utf8')) as State;
  return { deployer, calls, lines, state, builds: () => builds };
}

const steps = (calls: string[]) => calls.filter((c) => !/^(whoami|d1 list|r2 bucket list|queues list)/.test(c)).map((c) => c.split(' ').slice(0, 2).join(' '));

describe('compareVersions', () => {
  it('orders releases, with a prerelease before its release', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('0.2.0-dev', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-dev', '0.1.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(() => compareVersions('latest', '1.0.0')).toThrow(/Not a version/);
  });
});

describe('oc upgrade', () => {
  it('records how to undo it, then migrates before deploying', async () => {
    const { deployer, calls, state, builds } = setup();
    await deployer.upgrade('acme');
    expect(steps(calls)).toEqual(['deployments status', 'd1 time-travel', 'd1 migrations', 'deploy']);
    expect(builds()).toBe(1);
    expect(state()).toMatchObject({ version: '0.2.0', lastUpgrade: { from: '0.1.0', to: '0.2.0', previousVersionId: OLD_VERSION, bookmark: BOOKMARK } });
  });

  it('stops before changing anything if a migration fails, and the old Worker keeps running', async () => {
    const { deployer, calls, state } = setup({ failMigration: true });
    await expect(deployer.upgrade('acme')).rejects.toThrow(/A migration failed. The old Worker is still running[\s\S]*oc restore --env acme --bookmark/);
    expect(steps(calls)).not.toContain('deploy');
    expect(state().version).toBeUndefined();
  });

  it('rolls the Worker back by itself when the new one is unhealthy', async () => {
    const { deployer, calls, state } = setup({ unhealthyAfterDeploy: true });
    await expect(deployer.upgrade('acme')).rejects.toThrow(/rolled back, and 0.1.0 is running again/);
    expect(calls).toContain(`rollback ${OLD_VERSION} --name oc-acme --message oc upgrade: 0.2.0 was unhealthy --yes`);
    expect(calls.some((c) => c.includes('time-travel restore'))).toBe(false);
    expect(state().version).toBeUndefined();
    expect(state().lastUpgrade?.rolledBackAt).toBeDefined();
  });

  it('refuses an older checkout, and a jump past a required release', async () => {
    const older = setup({ release: '0.1.5', state: { version: '0.2.0' } });
    await expect(older.deployer.upgrade('acme')).rejects.toThrow(/older than the deployed 0.2.0/);
    await expect(older.deployer.deploy({ name: 'acme' })).rejects.toThrow(/older than the deployed 0.2.0/);
    expect(older.calls).toEqual([]);
    const ancient = setup({ state: { version: '0.0.9' } });
    await expect(ancient.deployer.upgrade('acme')).rejects.toThrow(/Upgrade to 0.1.0 first/);
    expect(ancient.calls).toEqual([]);
  });

  it('needs an existing deployment', async () => {
    const { deployer } = setup({ state: { initialized: false } });
    await expect(deployer.upgrade('acme')).rejects.toThrow(/use oc deploy/);
  });
});

describe('the default output', () => {
  it('prints to the console when no log is given', async () => {
    const { deployer } = setup({ defaultLog: true });
    const printed: unknown[] = [];
    const original = console.log;
    console.log = (line: unknown) => void printed.push(line);
    try {
      await deployer.upgrade('acme');
    } finally {
      console.log = original;
    }
    expect(printed).toContain('Upgrading acme from 0.1.0 to 0.2.0');
  });
});

describe('oc rollback', () => {
  it('puts back the previous Worker and leaves the database alone', async () => {
    const { deployer, calls, lines, state } = setup();
    await deployer.upgrade('acme');
    calls.length = 0;
    await deployer.rollback('acme');
    expect(calls).toEqual([`rollback ${OLD_VERSION} --name oc-acme --message oc rollback to 0.1.0 --yes`]);
    expect(state().version).toBe('0.1.0');
    expect(lines.join('\n')).toContain(`--bookmark ${BOOKMARK}`);
    await expect(deployer.rollback('acme')).rejects.toThrow(/No upgrade of acme to roll back/);
  });
});

describe('oc deploy --no-relay', () => {
  const relay = { url: 'https://relay.example.org', id: 'managed', bundleIds: 'com.example.app' };

  it('takes the relay out, and says to disconnect in the dashboard first', async () => {
    const { deployer, state, lines } = setup({ state: { version: '0.2.0', relay, relayKeySet: true } });
    await deployer.deploy({ name: 'acme', noRelay: true });
    expect(state().relay).toBeUndefined();
    expect(lines.join('\n')).toContain('disconnect in the dashboard first');
  });

  it('cannot go with a new relay', async () => {
    const { deployer, calls } = setup({ state: { version: '0.2.0', relay } });
    await expect(deployer.deploy({ name: 'acme', noRelay: true, relayUrl: relay.url, relayId: 'x', relayBundleIds: 'y' })).rejects.toThrow(/--no-relay cannot go with/);
    expect(calls).toEqual([]);
  });
});
