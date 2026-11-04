import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateOpaqueToken,
  generateSerializedKey,
  hashOpaqueToken,
  importSigningKey,
  importVerificationKeys,
  signAccessToken,
  signTicket,
  TICKET_TTL_SECONDS,
  verifyAccessToken,
  verifyTicket,
  verifyVisitorToken,
} from '../src/index';
import { toBase64Url } from '../src/encoding';

const NOW = 1_793_700_000;
const ISSUER = 'inst_A';
const serialized = await generateSerializedKey('k1');
const key = await importSigningKey(serialized);
const keys = await importVerificationKeys([serialized]);
const input = { userId: 'user_1', sessionId: 'sess_1', installationId: ISSUER };
const b64 = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

describe('access tokens', () => {
  it('round-trips identity, with a 15-minute lifetime', async () => {
    const result = await verifyAccessToken(await signAccessToken(key, input, NOW), keys, ISSUER, NOW);
    expect(result).toEqual({ ok: true, claims: { sub: 'user_1', sid: 'sess_1', iss: ISSUER, iat: NOW, exp: NOW + ACCESS_TOKEN_TTL_SECONDS } });
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('holds no roles or personal data', async () => {
    const token = await signAccessToken(key, input, NOW);
    const claims = JSON.parse(atob(token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'iss', 'sid', 'sub']);
  });

  it('rejects a changed payload', async () => {
    const [h, , s] = (await signAccessToken(key, input, NOW)).split('.');
    const forged = b64({ sub: 'user_admin', sid: 'sess_1', iss: ISSUER, iat: NOW, exp: NOW + 900 });
    expect(await verifyAccessToken(`${h}.${forged}.${s}`, keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['none', { alg: 'none', kid: 'k1' }],
    ['HS256, the classic confusion attack', { alg: 'HS256', kid: 'k1' }],
    ['ES256', { alg: 'ES256', kid: 'k1' }],
    ['missing', { kid: 'k1' }],
  ])('rejects alg %s', async (_name, header) => {
    const [, c, s] = (await signAccessToken(key, input, NOW)).split('.');
    expect(await verifyAccessToken(`${b64(header)}.${c}.${s}`, keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'bad_algorithm' });
  });

  it('rejects an empty signature, even with alg none', async () => {
    const claims = b64({ sub: 'u', sid: 's', iss: ISSUER, iat: NOW, exp: NOW + 900 });
    expect((await verifyAccessToken(`${b64({ alg: 'none' })}.${claims}.`, keys, ISSUER, NOW)).ok).toBe(false);
    expect((await verifyAccessToken(`${b64({ alg: 'EdDSA', kid: 'k1' })}.${claims}.`, keys, ISSUER, NOW)).ok).toBe(false);
  });

  it('rejects another key, even one with the same ID', async () => {
    const other = await importSigningKey(await generateSerializedKey('k1'));
    expect(await verifyAccessToken(await signAccessToken(other, input, NOW), keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an unknown key ID', async () => {
    const other = await importSigningKey(await generateSerializedKey('k9'));
    expect(await verifyAccessToken(await signAccessToken(other, input, NOW), keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('rejects a token from another installation', async () => {
    expect(await verifyAccessToken(await signAccessToken(key, input, NOW), keys, 'inst_B', NOW)).toEqual({ ok: false, reason: 'bad_issuer' });
  });

  it.each([
    ['just inside clock skew', NOW + 900 + 29, true],
    ['at the limit of clock skew', NOW + 900 + 30, false],
    ['long expired', NOW + 100_000, false],
  ])('handles a token %s', async (_name, now, ok) => {
    const result = await verifyAccessToken(await signAccessToken(key, input, NOW), keys, ISSUER, now);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts both keys during rotation, and drops the old one after', async () => {
    const next = await generateSerializedKey('k2');
    const during = await importVerificationKeys([serialized, next]);
    const after = await importVerificationKeys([next]);
    const oldToken = await signAccessToken(key, input, NOW);
    const newToken = await signAccessToken(await importSigningKey(next), input, NOW);
    expect((await verifyAccessToken(oldToken, during, ISSUER, NOW)).ok).toBe(true);
    expect((await verifyAccessToken(newToken, during, ISSUER, NOW)).ok).toBe(true);
    expect(await verifyAccessToken(oldToken, after, ISSUER, NOW)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it.each(['', 'a', 'a.b', 'a.b.c.d', '!!.!!.!!', 'x'.repeat(5000)])('rejects the malformed token %j', async (token) => {
    expect((await verifyAccessToken(token, keys, ISSUER, NOW)).ok).toBe(false);
  });

  it('rejects correctly signed claims of the wrong shape', async () => {
    const body = `${b64({ alg: 'EdDSA', kid: 'k1' })}.${b64({ sub: 1 })}`;
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(body));
    expect(await verifyAccessToken(`${body}.${toBase64Url(new Uint8Array(signature))}`, keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('realtime tickets', () => {
  const claims = { kind: 'visitor' as const, sub: 'vis_1', wid: 'work_1', conv: 'conv_1', until: 1, iss: ISSUER };

  it('lasts exactly its short life', async () => {
    const ticket = await signTicket(key, claims, NOW);
    expect(await verifyTicket(ticket, keys, ISSUER, NOW + TICKET_TTL_SECONDS - 1)).toMatchObject({ ok: true, claims: { aud: 'realtime', sub: 'vis_1', conv: 'conv_1' } });
    expect(await verifyTicket(ticket, keys, ISSUER, NOW + TICKET_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' });
  });

  it('belongs to one installation', async () => {
    expect(await verifyTicket(await signTicket(key, claims, NOW), keys, 'inst_B', NOW)).toEqual({ ok: false, reason: 'bad_issuer' });
  });

  it('needs a conversation for a visitor', async () => {
    expect(await verifyTicket(await signTicket(key, { ...claims, conv: undefined as unknown as string }, NOW), keys, ISSUER, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is not interchangeable with any other token', async () => {
    const ticket = await signTicket(key, claims, NOW);
    expect((await verifyAccessToken(ticket, keys, ISSUER, NOW)).ok).toBe(false);
    expect((await verifyVisitorToken(ticket, keys, ISSUER, NOW)).ok).toBe(false);
    expect((await verifyTicket(await signAccessToken(key, input, NOW), keys, ISSUER, NOW)).ok).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('has 256 bits and does not repeat', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
  });

  it('stores a stable hash that does not contain the token', async () => {
    const token = generateOpaqueToken();
    expect(await hashOpaqueToken(token)).toBe(await hashOpaqueToken(token));
    expect(await hashOpaqueToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOpaqueToken(token)).not.toContain(token);
  });
});
