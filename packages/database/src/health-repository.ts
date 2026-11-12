/**
 * Read-only queries for the operator health checks. They act for the installation, not a member, so they take no
 * context, and they return counts and times only. See docs/operations/monitoring.md.
 */
import { rawHandle, type Database } from './internal/handle';

export interface DatabaseProbe {
  latencyMs: number;
  /** From D1's result metadata. Null where the runtime does not report it. */
  sizeBytes: number | null;
  /** The name of the newest applied migration, from the table Wrangler keeps. */
  migration: string | null;
}

export async function probeDatabase(database: Database): Promise<DatabaseProbe> {
  const d1 = rawHandle(database);
  const started = Date.now();
  const ping = await d1.prepare('SELECT 1').run();
  const latencyMs = Date.now() - started;
  const sizeAfter = (ping.meta as { size_after?: unknown }).size_after;
  const migration = await d1
    .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
    .first<{ name: string }>()
    .catch(() => null);
  return { latencyMs, sizeBytes: typeof sizeAfter === 'number' ? sizeAfter : null, migration: migration?.name ?? null };
}

export interface QueueProbe {
  lastHeartbeatAt: number | null;
  oldestPendingOutboxAt: number | null;
  unreviewedFailedJobs: number;
}

/**
 * The heartbeat's receipt proves the whole loop: cron ran, the jobs queue delivered, and the consumer reached D1.
 * Its key is `heartbeat:<minute>`, and minutes have eight digits until the year 2160, so the newest key sorts last
 * and the primary key finds it by reading one row.
 */
export async function probeQueues(database: Database): Promise<QueueProbe> {
  const row = await rawHandle(database)
    .prepare(
      `SELECT
         (SELECT claimed_at FROM job_receipts WHERE idempotency_key >= 'heartbeat:' AND idempotency_key < 'heartbeat;' ORDER BY idempotency_key DESC LIMIT 1) AS lastHeartbeatAt,
         (SELECT MIN(created_at) FROM outbox WHERE dispatched_at IS NULL) AS oldestPendingOutboxAt,
         (SELECT COUNT(*) FROM failed_jobs WHERE replayed_at IS NULL) AS unreviewedFailedJobs`,
    )
    .first<QueueProbe>();
  return { lastHeartbeatAt: row?.lastHeartbeatAt ?? null, oldestPendingOutboxAt: row?.oldestPendingOutboxAt ?? null, unreviewedFailedJobs: row?.unreviewedFailedJobs ?? 0 };
}

/** Whether the installation has registered with this relay, which a signed check needs. */
export async function relayRegisteredId(database: Database): Promise<string | null> {
  const row = await rawHandle(database).prepare('SELECT relay_registered_id AS id FROM installation LIMIT 1').first<{ id: string | null }>();
  return row?.id ?? null;
}
