import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { confirmEmailVerification, confirmPasswordReset, openDatabase, revokeSession, rotateRefreshToken } from '../src/index';

const db = () => openDatabase(env.DB);
const hashOf = async () => (await env.DB.prepare(`SELECT password_hash AS h FROM users WHERE id = 'usr_a'`).first<{ h: string }>())!.h;
const openSessions = () => env.DB.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').first('n');

const insertToken = (hash: string, purpose = 'password_reset', expiresAt = Date.now() + 60_000) =>
  env.DB.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1, 'usr_a', ?2, ?3)`).bind(hash, purpose, expiresAt).run();

const insertSession = (id: string, refreshHash: string, previousHash: string | null = null) =>
  env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, previous_token_hash, client_type, created_at, last_used_at, expires_at)
     VALUES (?1, 'usr_a', ?2, ?3, 'mobile', 1, 1, ?4)`,
  )
    .bind(id, refreshHash, previousHash, Date.now() + 60_000)
    .run();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_tokens'),
    env.DB.prepare('DELETE FROM auth_sessions'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare(`INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES ('usr_a', 'a@example.com', 'A', 'original', 1, 1)`),
  ]);
});

// These call the batch directly. The service reads first to skip hashing for a bad token, which hides a
// faulty batch from any sequential test: only a race gets past that read.
describe('confirmPasswordReset', () => {
  it('applies once. A second attempt with a spent token changes nothing', async () => {
    await insertToken('t');
    expect(await confirmPasswordReset(db(), 't', 'first')).toBe(true);
    await insertSession('ses_after', 'r');

    expect(await confirmPasswordReset(db(), 't', 'second')).toBe(false);

    expect(await hashOf()).toBe('first');
    expect(await openSessions()).toBe(1);
  });

  it('changes nothing for an expired, unknown, or wrong-purpose token', async () => {
    await insertSession('ses_a', 'r');
    await insertToken('expired', 'password_reset', 1);
    await insertToken('verify', 'email_verification');
    for (const token of ['expired', 'unknown', 'verify']) expect(await confirmPasswordReset(db(), token, 'changed')).toBe(false);
    expect(await hashOf()).toBe('original');
    expect(await openSessions()).toBe(1);
  });

  it('revokes sessions and spends the other reset tokens, but not verification tokens', async () => {
    await insertSession('ses_a', 'r');
    await insertToken('t1');
    await insertToken('t2');
    await insertToken('verify', 'email_verification');
    expect(await confirmPasswordReset(db(), 't1', 'new')).toBe(true);
    expect(await openSessions()).toBe(0);
    expect(await confirmPasswordReset(db(), 't2', 'again')).toBe(false);
    expect(await hashOf()).toBe('new');
    expect(await confirmEmailVerification(db(), 'verify')).toBe(true);
  });
});

describe('confirmEmailVerification', () => {
  it('does not verify on a spent or expired token, and keeps the first timestamp', async () => {
    await insertToken('expired', 'email_verification', 1);
    expect(await confirmEmailVerification(db(), 'expired')).toBe(false);
    const verifiedAt = () => env.DB.prepare(`SELECT email_verified_at AS v FROM users WHERE id = 'usr_a'`).first<number | null>('v');
    expect(await verifiedAt()).toBeNull();

    await insertToken('t', 'email_verification');
    expect(await confirmEmailVerification(db(), 't')).toBe(true);
    const first = await verifiedAt();
    expect(await confirmEmailVerification(db(), 't')).toBe(false);
    expect(await verifiedAt()).toBe(first);
  });
});

describe('rotateRefreshToken', () => {
  it('reports each outcome, and a rotation does not trigger its own reuse check', async () => {
    await insertSession('ses_a', 'r1');
    expect(await rotateRefreshToken(db(), 'r1', 'r2')).toMatchObject({ outcome: 'rotated', sessionId: 'ses_a', userId: 'usr_a', clientType: 'mobile' });
    expect(await openSessions()).toBe(1);
    expect(await rotateRefreshToken(db(), 'r1', 'r3')).toEqual({ outcome: 'reused' });
    expect(await openSessions()).toBe(0);
    expect(await rotateRefreshToken(db(), 'r2', 'r4')).toEqual({ outcome: 'invalid' });
    expect(await rotateRefreshToken(db(), 'unknown', 'r5')).toEqual({ outcome: 'invalid' });
  });

  it('does not rotate a revoked session', async () => {
    await insertSession('ses_a', 'r1');
    await revokeSession(db(), 'ses_a');
    expect(await rotateRefreshToken(db(), 'r1', 'r2')).toEqual({ outcome: 'invalid' });
  });
});
