import { NONCE_TTL_SECONDS } from '@openchat/notification-protocol';
import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_LIMITS, type NotificationLimits } from '../limits';

/** Signed requests of any kind. Notification quotas are separate, and arrive with delivery. */
export const REQUEST_BURST = 300;
export const REQUESTS_PER_SECOND = 5;
const DAY_MS = 24 * 60 * 60_000;
/** A quota row untouched this long is full again, or from a day already over, so it can go. */
const QUOTA_IDLE_MS = DAY_MS;

export type AdmitResult = { ok: true } | { ok: false; reason: 'replayed' } | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

/**
 * One per installation. Replay protection needs strong consistency, which neither KV nor the rate limit binding
 * gives, and one installation cannot exhaust another's. `storage.sql` is synchronous, so `admit` runs without
 * interleaving. Changes to these methods must be additive: old objects can outlive a deploy.
 */
export class RelayGuard extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS bucket (id INTEGER PRIMARY KEY CHECK (id = 1), tokens REAL NOT NULL, updated_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS quotas (name TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID');
  }

  /** Nonces outlive the timestamp window, so that an old request cannot be replayed once forgotten. */
  async admit(requestId: string): Promise<AdmitResult> {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const seen = sql.exec<{ expires_at: number }>('SELECT expires_at FROM nonces WHERE id = ?', requestId).toArray()[0];
    if (seen && seen.expires_at > now) return { ok: false, reason: 'replayed' };

    const bucket = sql.exec<{ tokens: number; updated_at: number }>('SELECT tokens, updated_at FROM bucket WHERE id = 1').toArray()[0];
    const tokens = bucket ? Math.min(REQUEST_BURST, bucket.tokens + ((now - bucket.updated_at) / 1000) * REQUESTS_PER_SECOND) : REQUEST_BURST;
    if (tokens < 1) return { ok: false, reason: 'rate_limited', retryAfterSeconds: Math.ceil((1 - tokens) / REQUESTS_PER_SECOND) };

    sql.exec('INSERT INTO bucket (id, tokens, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at', tokens - 1, now);
    sql.exec('INSERT INTO nonces (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at', requestId, now + NONCE_TTL_SECONDS * 1000);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + NONCE_TTL_SECONDS * 1000);
    return { ok: true };
  }

  /** A grant works once. Grants last 5 minutes at most, so they are forgotten after they have expired. */
  async consumeGrant(jti: string): Promise<boolean> {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const id = `grant:${jti}`;
    const seen = sql.exec<{ expires_at: number }>('SELECT expires_at FROM nonces WHERE id = ?', id).toArray()[0];
    if (seen && seen.expires_at > now) return false;
    sql.exec('INSERT INTO nonces (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at', id, now + NONCE_TTL_SECONDS * 1000);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + NONCE_TTL_SECONDS * 1000);
    return true;
  }

  /**
   * Takes one token per notification, or nothing at all. The installation's rate and daily count, and each
   * recipient's rate, all have to allow it. A limit of 0 is off. Limits arrive with the call, so that the operator's
   * settings apply without a migration; a caller from before them sends none, and gets the defaults.
   */
  async takeNotificationQuota(recipientIds: string[], limits: NotificationLimits = DEFAULT_LIMITS): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const read = (name: string) => sql.exec<{ tokens: number; updated_at: number }>('SELECT tokens, updated_at FROM quotas WHERE name = ?', name).toArray()[0];
    const counts = new Map<string, number>();
    for (const id of recipientIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const plans: [string, number][] = [];
    let wait = 0;
    const bucket = (name: string, burst: number, perMinute: number, cost: number) => {
      if (burst <= 0 || perMinute <= 0) return;
      const rate = perMinute / 60;
      const row = read(name);
      const tokens = row ? Math.min(burst, row.tokens + ((now - row.updated_at) / 1000) * rate) : burst;
      if (tokens < cost) wait = Math.max(wait, Math.ceil((Math.min(cost, burst) - tokens) / rate), 1);
      plans.push([name, tokens - cost]);
    };
    bucket('installation', limits.notificationBurst, limits.notificationsPerMinute, recipientIds.length);
    for (const [id, cost] of counts) bucket(`recipient:${id}`, limits.recipientBurst, limits.recipientNotificationsPerMinute, cost);
    if (limits.notificationsPerDay > 0) {
      // A count, not a bucket: the day is a UTC calendar day, and the count starts again at midnight.
      const day = `day:${new Date(now).toISOString().slice(0, 10)}`;
      const used = read(day)?.tokens ?? 0;
      if (used + recipientIds.length > limits.notificationsPerDay) wait = Math.max(wait, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000), 1);
      plans.push([day, used + recipientIds.length]);
    }
    if (wait > 0) return { ok: false, retryAfterSeconds: wait };
    for (const [name, tokens] of plans) sql.exec('INSERT INTO quotas (name, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at', name, tokens, now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + NONCE_TTL_SECONDS * 1000);
    return { ok: true };
  }

  /**
   * New installations from one IP address, in an object named for a hash of it. Counted before the domain is
   * checked, so that failed attempts count too. Answers how long to wait, or 0.
   */
  async takeRegistration(perHour: number): Promise<number> {
    if (perHour <= 0) return 0;
    const { sql } = this.ctx.storage;
    const now = Date.now();
    const rate = perHour / 3600;
    const row = sql.exec<{ tokens: number; updated_at: number }>("SELECT tokens, updated_at FROM quotas WHERE name = 'registration'").toArray()[0];
    const tokens = row ? Math.min(perHour, row.tokens + ((now - row.updated_at) / 1000) * rate) : perHour;
    if (tokens < 1) return Math.max(1, Math.ceil((1 - tokens) / rate));
    sql.exec("INSERT INTO quotas (name, tokens, updated_at) VALUES ('registration', ?, ?) ON CONFLICT (name) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at", tokens - 1, now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + NONCE_TTL_SECONDS * 1000);
    return 0;
  }

  override async alarm() {
    const { sql } = this.ctx.storage;
    sql.exec('DELETE FROM nonces WHERE expires_at <= ?', Date.now());
    // A recipient's quota is full again by now at the default rate, so an absent row means the same. Any other row
    // left alone for a day is full again, or counts a day that is over. Without this, the alarm would never stop.
    sql.exec("DELETE FROM quotas WHERE name LIKE 'recipient:%' AND updated_at <= ?", Date.now() - NONCE_TTL_SECONDS * 1000);
    sql.exec('DELETE FROM quotas WHERE updated_at <= ?', Date.now() - QUOTA_IDLE_MS);
    const left = sql.exec<{ n: number }>('SELECT (SELECT count(*) FROM nonces) + (SELECT count(*) FROM quotas) AS n').one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + NONCE_TTL_SECONDS * 1000);
  }
}
