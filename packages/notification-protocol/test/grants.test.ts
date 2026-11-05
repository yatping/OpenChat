import { describe, expect, it } from 'vitest';
import { type DeviceGrantClaims, importPrivateKey, importPublicKey, parseGrant, signGrant, toBase64Url, verifyGrant } from '../src/index';

const NOW = 1_793_700_000;
const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
const privateKey = await importPrivateKey(toBase64Url(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)));
const publicKey = await importPublicKey(toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)));
const claims: DeviceGrantClaims = { iss: 'inst_a', aud: 'relay-1', wid: 'work_a', sub: 'mem_a', jti: 'grant_a', iat: NOW, exp: NOW + 300 };
const encode = (value: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const check = async (grant: string, now = NOW, audience = 'relay-1') => {
  const parsed = parseGrant(grant);
  return parsed ? verifyGrant(publicKey, parsed, audience, now) : false;
};

describe('grants', () => {
  it('round trips', async () => {
    const grant = await signGrant(privateKey, 'k1', claims);
    expect(parseGrant(grant)).toMatchObject({ keyId: 'k1', claims });
    expect(await check(grant)).toBe(true);
  });

  it('refuses the wrong audience', async () => expect(await check(await signGrant(privateKey, 'k1', claims), NOW, 'relay-2')).toBe(false));
  it('refuses an expired grant', async () => expect(await check(await signGrant(privateKey, 'k1', claims), NOW + 300)).toBe(false));
  it('refuses one from the future', async () => expect(await check(await signGrant(privateKey, 'k1', claims), NOW - 301)).toBe(false));
  it('refuses a lifetime over 5 minutes', async () => expect(await check(await signGrant(privateKey, 'k1', { ...claims, exp: NOW + 301 }))).toBe(false));
  it('refuses a lifetime that ends before it starts', async () => expect(await check(await signGrant(privateKey, 'k1', { ...claims, exp: NOW }))).toBe(false));

  it.each(['iss', 'aud', 'wid', 'sub', 'jti', 'iat', 'exp'] as const)('refuses a changed %s', async (field) => {
    const [head, , signature] = (await signGrant(privateKey, 'k1', claims)).split('.') as [string, string, string];
    const changed = { ...claims, [field]: typeof claims[field] === 'number' ? (claims[field] as number) + 1 : 'other' };
    expect(await check(`${head}.${encode(changed)}.${signature}`)).toBe(false);
  });

  it.each([
    ['another algorithm', { alg: 'none', kid: 'k1', typ: 'oc-grant+jwt' }],
    ['HMAC', { alg: 'HS256', kid: 'k1', typ: 'oc-grant+jwt' }],
    ['another token type', { alg: 'EdDSA', kid: 'k1', typ: 'JWT' }],
    ['no key ID', { alg: 'EdDSA', typ: 'oc-grant+jwt' }],
  ])('refuses %s', async (_name, header) => {
    const [, body, signature] = (await signGrant(privateKey, 'k1', claims)).split('.') as [string, string, string];
    expect(parseGrant(`${encode(header)}.${body}.${signature}`)).toBeNull();
  });

  it.each(['', 'a.b', 'a.b.c.d', '!!.!!.!!', `${encode({})}.${encode({})}.AAAA`, 'x'.repeat(3000)])('refuses %j', (grant) => expect(parseGrant(grant)).toBeNull());

  it('refuses claims of the wrong type', async () => {
    const [head, , signature] = (await signGrant(privateKey, 'k1', claims)).split('.') as [string, string, string];
    expect(parseGrant(`${head}.${encode({ ...claims, exp: 'later' })}.${signature}`)).toBeNull();
    expect(parseGrant(`${head}.${encode({ ...claims, sub: 7 })}.${signature}`)).toBeNull();
  });
});
