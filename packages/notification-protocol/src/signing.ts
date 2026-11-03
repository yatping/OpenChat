/**
 * Request signing. Web-standard APIs only, so that this runs in Workers, browsers, and Node.
 * Signer and verifier share canonicalSigningString so that they cannot diverge.
 */
import { MAX_CLOCK_SKEW_SECONDS, SIGNATURE_DOMAIN } from './types';

export interface SignatureInput {
  method: string;
  path: string;
  installationId: string;
  workspaceId?: string;
  keyId: string;
  requestId: string;
  timestamp: string;
  body: Uint8Array;
}

export type VerifyFailure = 'stale_timestamp' | 'invalid_timestamp' | 'malformed_signature' | 'invalid_signature';
export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

const ED25519 = { name: 'Ed25519' } as const;
const SIGNATURE_PREFIX = 'v1=';
const ED25519_SIGNATURE_BYTES = 64;
const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new RangeError('Invalid base64url');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function canonicalSigningString(input: SignatureInput): Promise<string> {
  return [
    SIGNATURE_DOMAIN,
    input.method.toUpperCase(),
    input.path,
    input.installationId,
    input.workspaceId ?? '',
    input.keyId,
    input.requestId,
    input.timestamp,
    await sha256Hex(input.body),
  ].join('\n');
}

export async function importPrivateKey(pkcs8Base64Url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', fromBase64Url(pkcs8Base64Url), ED25519, false, ['sign']);
}

export async function importPublicKey(rawBase64Url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64Url(rawBase64Url), ED25519, false, ['verify']);
}

export async function signRequest(key: CryptoKey, input: SignatureInput): Promise<string> {
  const message = encoder.encode(await canonicalSigningString(input));
  const signature = await crypto.subtle.sign(ED25519, key, message);
  return `${SIGNATURE_PREFIX}${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Checks the timestamp and signature. Replay protection (the request ID) is the relay's job, because
 * it needs strongly consistent storage. See docs/notification-relay/protocol.md.
 */
export async function verifyRequest(
  key: CryptoKey,
  input: SignatureInput,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowSeconds - Number(input.timestamp)) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  if (!signature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'malformed_signature' };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(signature.slice(SIGNATURE_PREFIX.length));
  } catch {
    return { ok: false, reason: 'malformed_signature' };
  }
  // workerd throws on a wrong length where Node returns false, so check it here to behave the same on both.
  if (bytes.length !== ED25519_SIGNATURE_BYTES) return { ok: false, reason: 'malformed_signature' };
  const message = encoder.encode(await canonicalSigningString(input));
  const valid = await crypto.subtle.verify(ED25519, key, bytes, message);
  return valid ? { ok: true } : { ok: false, reason: 'invalid_signature' };
}
