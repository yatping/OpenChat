import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDeployer, type State } from '../src/deploy';

const BASE = 'https://oc-acme.acme.workers.dev';

function setup(answers: Record<string, [number, unknown]>, state: Partial<State> = { operatorTokenSet: true }, token: string | null = 'tok') {
  const root = mkdtempSync(join(tmpdir(), 'oc-health-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  mkdirSync(join(root, '.openchat/acme'), { recursive: true });
  writeFileSync(join(root, '.openchat/acme/state.json'), JSON.stringify({ name: 'acme', initialized: true, publicBaseUrl: BASE, ...state }));
  if (token !== null) writeFileSync(join(root, '.openchat/acme/operator-token'), `${token}\n`);
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push(`${url} ${new Headers(init?.headers).get('authorization')}`);
    const [status, body] = answers[url.slice(BASE.length)] ?? [404, { code: 'not_found' }];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const lines: string[] = [];
  const deployer = createDeployer(root, { fetch: fakeFetch, wrangler: () => '', log: (line) => void lines.push(line) });
  return { deployer, lines, seen };
}

const healthy: Record<string, [number, unknown]> = {
  '/health/database': [200, { status: 'ok', problems: [], latencyMs: 4, sizeBytes: 2_097_152, sizeLimitBytes: 10 * 1024 ** 3, migration: '0013_audit_log_recent.sql' }],
  '/health/queues': [200, { status: 'warn', problems: ['failed_jobs'], heartbeatAgeSeconds: 31, oldestPendingOutboxSeconds: null, unreviewedFailedJobs: 2 }],
  '/health/realtime': [200, { status: 'ok', problems: [], roundTripMs: 12 }],
  '/health/notifications': [200, { status: 'ok', problems: [], relay: 'off', roundTripMs: null }],
};

describe('oc health', () => {
  it('reads every check with the stored token, and passes when nothing fails', async () => {
    const { deployer, lines, seen } = setup(healthy);
    expect(await deployer.health('acme')).toBe(true);
    expect(seen).toEqual(['database', 'queues', 'realtime', 'notifications'].map((c) => `${BASE}/health/${c} Bearer tok`));
    expect(lines).toEqual([
      'OK   database: 4 ms, 2.0 MB of 10240.0 MB, migration 0013_audit_log_recent.sql',
      'WARN queues (failed_jobs): heartbeat 31 s ago, oldest outbox row none, 2 failed jobs to review',
      'OK   realtime: 12 ms round trip',
      'OK   notifications: relay off',
    ]);
  });

  it('fails when a check fails or answers something else', async () => {
    const { deployer, lines } = setup({ ...healthy, '/health/queues': [503, { status: 'fail', problems: ['no_heartbeat'], heartbeatAgeSeconds: null, oldestPendingOutboxSeconds: null, unreviewedFailedJobs: 0 }], '/health/realtime': [404, { code: 'not_found' }] });
    expect(await deployer.health('acme')).toBe(false);
    expect(lines[1]).toBe('FAIL queues (no_heartbeat): heartbeat never, oldest outbox row none, 0 failed jobs to review');
    expect(lines[2]).toBe('FAIL realtime: answered 404');
  });

  it('says how to get a token when this computer has none', async () => {
    await expect(setup(healthy, {}, null).deployer.health('acme')).rejects.toThrow('Run pnpm oc deploy --env acme once');
  });
});
