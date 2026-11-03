// Runs in workerd and in Node through two Vitest projects, because the same code runs on both sides.
import { describe, expect, it } from 'vitest';
import {
  canonicalSigningString,
  fromBase64Url,
  importPrivateKey,
  importPublicKey,
  signRequest,
  toBase64Url,
  verifyRequest,
  type SignatureInput,
} from '../src/index';
import vector from './test-vector.json';

const NOW = 1_793_700_000;
const body = new TextEncoder().encode('{"event":"new_message"}');
const input: SignatureInput = {
  method: 'POST',
  path: '/v1/notifications/send',
  installationId: 'inst_A',
  workspaceId: 'work_B',
  keyId: 'k1',
  requestId: 'req_C',
  timestamp: String(NOW),
  body,
};

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;

describe('request signing', () => {
  it('verifies a valid signature', async () => {
    const signature = await signRequest(pair.privateKey, input);
    expect(signature.startsWith('v1=')).toBe(true);
    expect(await verifyRequest(pair.publicKey, input, signature, NOW)).toEqual({ ok: true });
  });

  it('fixes the canonical form, with the domain separator first', async () => {
    const canonical = await canonicalSigningString(input);
    expect(canonical.split('\n').slice(0, 8)).toEqual(['OCRELAY-V1', 'POST', '/v1/notifications/send', 'inst_A', 'work_B', 'k1', 'req_C', String(NOW)]);
  });

  const tampered: [string, Partial<SignatureInput>][] = [
    ['method', { method: 'PUT' }],
    ['path', { path: '/v1/notifications/batch' }],
    ['installation', { installationId: 'inst_X' }],
    ['workspace', { workspaceId: 'work_X' }],
    ['key ID', { keyId: 'k2' }],
    ['request ID', { requestId: 'req_X' }],
    ['timestamp', { timestamp: String(NOW + 1) }],
    ['body', { body: new TextEncoder().encode('{"event":"mention"}') }],
  ];

  it.each(tampered)('rejects a tampered %s', async (_field, change) => {
    const signature = await signRequest(pair.privateKey, input);
    expect(await verifyRequest(pair.publicKey, { ...input, ...change }, signature, NOW)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('does not confuse a missing workspace with an empty field shift', async () => {
    const withoutWorkspace: SignatureInput = { ...input };
    delete withoutWorkspace.workspaceId;
    const signature = await signRequest(pair.privateKey, withoutWorkspace);
    expect(await verifyRequest(pair.publicKey, input, signature, NOW)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects another key', async () => {
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const signature = await signRequest(other.privateKey, input);
    expect(await verifyRequest(pair.publicKey, input, signature, NOW)).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it.each([
    ['just inside the window', NOW + 300, { ok: true }],
    ['just outside the window', NOW + 301, { ok: false, reason: 'stale_timestamp' }],
    ['in the future beyond the window', NOW - 301, { ok: false, reason: 'stale_timestamp' }],
  ])('handles a timestamp %s', async (_name, now, expected) => {
    const signature = await signRequest(pair.privateKey, input);
    expect(await verifyRequest(pair.publicKey, input, signature, now)).toEqual(expected);
  });

  it.each(['', 'nonsense', 'v1=', 'v1=!!!', 'v2=AAAA'])('rejects the malformed signature %j', async (signature) => {
    const result = await verifyRequest(pair.publicKey, input, signature, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed timestamp', async () => {
    const signature = await signRequest(pair.privateKey, input);
    expect(await verifyRequest(pair.publicKey, { ...input, timestamp: '1e9' }, signature, NOW)).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });

  it('round-trips base64url, and rejects other alphabets', () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(() => fromBase64Url('a+b/')).toThrow(RangeError);
  });
});

describe('published test vector', () => {
  it('verifies, and signs deterministically', async () => {
    const v = vector as unknown as { publicKey: string; privateKeyPkcs8: string; input: Omit<SignatureInput, 'body'> & { body: string }; canonical: string; signature: string; now: number };
    const parsed = { ...v.input, body: new TextEncoder().encode(v.input.body) };
    expect(await canonicalSigningString(parsed)).toBe(v.canonical);
    expect(await signRequest(await importPrivateKey(v.privateKeyPkcs8), parsed)).toBe(v.signature);
    expect(await verifyRequest(await importPublicKey(v.publicKey), parsed, v.signature, v.now)).toEqual({ ok: true });
  });
});
