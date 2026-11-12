/**
 * Health checks for the installation's operator, per amendment A9: the public /health says only that the Worker
 * answers, and these say why something is wrong. They need OPERATOR_TOKEN, a Worker secret that `oc deploy`
 * generates. Without it, or with the wrong token, each answers 404, as if it did not exist.
 * Thresholds and what to do about each problem are in docs/operations/monitoring.md.
 */
import { getInstallation, openDatabase, probeDatabase, probeQueues, relayRegisteredId } from '@openchat/database';
import { AppError } from '@openchat/shared';
import type { Context } from 'hono';
import type { AppEnv } from './context';
import type { Env } from './env';
import { checkRelay, relayConfig } from './push/relay-client';

/** D1's limit on the Workers Paid plan, which OpenChat requires (ADR-0009). */
export const DATABASE_LIMIT_BYTES = 10 * 1024 ** 3;

export const THRESHOLDS = {
  /** Warn at 70% so that there is time to act, per the data model. Fail at 90%. */
  databaseWarnRatio: 0.7,
  databaseFailRatio: 0.9,
  slowMs: 1000,
  /** Cron runs each minute, so five missed minutes is an outage of background work. */
  heartbeatFailSeconds: 300,
  /** The sweep sends anything still waiting after about two minutes. */
  outboxWarnSeconds: 180,
  outboxFailSeconds: 600,
} as const;

type Status = 'ok' | 'warn' | 'fail';

function worst(problems: { code: string; status: Status }[]): { status: Status; problems: string[] } {
  const status: Status = problems.some((p) => p.status === 'fail') ? 'fail' : problems.length > 0 ? 'warn' : 'ok';
  return { status, problems: problems.map((p) => p.code) };
}

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const digest = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return crypto.subtle.timingSafeEqual(await digest(presented), await digest(expected));
}

export async function requireOperator(c: Context<AppEnv>): Promise<void> {
  const expected = c.env.OPERATOR_TOKEN;
  const presented = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1];
  if (!expected || !presented || !(await tokenMatches(presented, expected))) throw new AppError(404, 'not_found', 'Not found');
  c.header('cache-control', 'no-store');
}

const seconds = (now: number, at: number | null) => (at === null ? null : Math.max(0, Math.round((now - at) / 1000)));

type Answer<T> = { body: T & { status: Status; problems: string[] }; code: 200 | 503 };

export async function databaseHealth(env: Env) {
  let probe;
  try {
    probe = await probeDatabase(openDatabase(env.DB));
  } catch {
    return { body: { status: 'fail' as Status, problems: ['database_unreachable'], latencyMs: 0, sizeBytes: null, sizeLimitBytes: DATABASE_LIMIT_BYTES, migration: null }, code: 503 as const };
  }
  const ratio = probe.sizeBytes === null ? 0 : probe.sizeBytes / DATABASE_LIMIT_BYTES;
  const result = worst([
    ...(ratio >= THRESHOLDS.databaseFailRatio ? [{ code: 'database_nearly_full', status: 'fail' as const }] : ratio >= THRESHOLDS.databaseWarnRatio ? [{ code: 'database_filling', status: 'warn' as const }] : []),
    ...(probe.latencyMs > THRESHOLDS.slowMs ? [{ code: 'database_slow', status: 'warn' as const }] : []),
    ...(probe.migration === null ? [{ code: 'migrations_unknown', status: 'warn' as const }] : []),
  ]);
  return answer({ ...result, latencyMs: probe.latencyMs, sizeBytes: probe.sizeBytes, sizeLimitBytes: DATABASE_LIMIT_BYTES, migration: probe.migration });
}

export async function queueHealth(env: Env) {
  const probe = await probeQueues(openDatabase(env.DB));
  const now = Date.now();
  const heartbeatAgeSeconds = seconds(now, probe.lastHeartbeatAt);
  const oldestPendingOutboxSeconds = seconds(now, probe.oldestPendingOutboxAt);
  const result = worst([
    ...(heartbeatAgeSeconds === null ? [{ code: 'no_heartbeat', status: 'fail' as const }] : heartbeatAgeSeconds > THRESHOLDS.heartbeatFailSeconds ? [{ code: 'heartbeat_stale', status: 'fail' as const }] : []),
    ...(oldestPendingOutboxSeconds === null
      ? []
      : oldestPendingOutboxSeconds > THRESHOLDS.outboxFailSeconds
        ? [{ code: 'outbox_stuck', status: 'fail' as const }]
        : oldestPendingOutboxSeconds > THRESHOLDS.outboxWarnSeconds
          ? [{ code: 'outbox_slow', status: 'warn' as const }]
          : []),
    ...(probe.unreviewedFailedJobs > 0 ? [{ code: 'failed_jobs', status: 'warn' as const }] : []),
  ]);
  return answer({ ...result, heartbeatAgeSeconds, oldestPendingOutboxSeconds, unreviewedFailedJobs: probe.unreviewedFailedJobs });
}

export async function realtimeHealth(env: Env) {
  const started = Date.now();
  try {
    // A name no workspace can have, since hub names start with "workspace:". It holds no data and no sockets.
    await env.WORKSPACE_HUB.getByName('health:probe').connectionCount();
  } catch {
    return { body: { status: 'fail' as Status, problems: ['realtime_unreachable'], roundTripMs: null }, code: 503 as const };
  }
  const roundTripMs = Date.now() - started;
  return answer({ ...worst(roundTripMs > THRESHOLDS.slowMs ? [{ code: 'realtime_slow', status: 'warn' }] : []), roundTripMs });
}

type RelayState = 'off' | 'disconnected' | 'unregistered' | 'ok' | 'unreachable' | 'rejected';

/** Push is optional, so a problem here is a warning and never a 503. */
export async function notificationHealth(env: Env): Promise<{ status: Status; problems: string[]; relay: RelayState; roundTripMs: number | null }> {
  const quiet = (relay: RelayState) => ({ status: 'ok' as Status, problems: [], relay, roundTripMs: null });
  const relay = relayConfig(env);
  if (!relay) return quiet('off');
  const db = openDatabase(env.DB);
  const installation = await getInstallation(db);
  if (!installation || installation.relayDisconnectedId === relay.id) return quiet('disconnected');
  // Registration happens when the first phone asks for push. Until then the relay has nothing to check against.
  if ((await relayRegisteredId(db)) !== relay.id) return quiet('unregistered');
  const started = Date.now();
  const check = await checkRelay(relay, installation.id);
  const roundTripMs = Date.now() - started;
  if (check === 'ok') return { ...worst(roundTripMs > THRESHOLDS.slowMs ? [{ code: 'relay_slow', status: 'warn' }] : []), relay: 'ok', roundTripMs };
  return { status: 'warn', problems: [check === 'rejected' ? 'relay_rejected' : 'relay_unreachable'], relay: check, roundTripMs: check === 'rejected' ? roundTripMs : null };
}

function answer<T extends { status: Status; problems: string[] }>(body: T): Answer<T> {
  return { body, code: body.status === 'fail' ? 503 : 200 };
}
