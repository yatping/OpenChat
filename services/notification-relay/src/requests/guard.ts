import { NONCE_TTL_SECONDS } from '@openchat/notification-protocol';
import { DurableObject } from 'cloudflare:workers';

/** Signed requests of any kind. Notification quotas are separate, and arrive with delivery. */
export const REQUEST_BURST = 300;
export const REQUESTS_PER_SECOND = 5;

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

  override async alarm() {
    const { sql } = this.ctx.storage;
    sql.exec('DELETE FROM nonces WHERE expires_at <= ?', Date.now());
    const left = sql.exec<{ n: number }>('SELECT count(*) AS n FROM nonces').one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + NONCE_TTL_SECONDS * 1000);
  }
}
