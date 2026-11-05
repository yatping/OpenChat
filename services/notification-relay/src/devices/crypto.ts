import { fromBase64Url, toBase64Url } from '@openchat/notification-protocol';

/**
 * APNs tokens are encrypted at rest, which narrows what a database-only leak exposes. The lookup is a keyed hash, so
 * a token can be found without being stored in the clear. Both keys come from one Worker secret.
 */
const encoder = new TextEncoder();

async function derive(secret: string, info: string, usage: Parameters<SubtleCrypto['deriveKey']>[2], uses: string[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', fromBase64Url(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) }, material, usage, false, uses);
}

export async function encryptToken(secret: string, bundleId: string, token: string): Promise<string> {
  const key = await derive(secret, 'oc-relay-token-v1', { name: 'AES-GCM', length: 256 }, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(bundleId) }, key, encoder.encode(token));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(data))}`;
}

export async function decryptToken(secret: string, bundleId: string, stored: string): Promise<string> {
  const [version, iv, data] = stored.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Unknown token format');
  const key = await derive(secret, 'oc-relay-token-v1', { name: 'AES-GCM', length: 256 }, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(bundleId) }, key, fromBase64Url(data));
  return new TextDecoder().decode(plain);
}

export async function tokenLookup(secret: string, bundleId: string, token: string): Promise<string> {
  const key = await derive(secret, 'oc-relay-lookup-v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${bundleId}\n${token}`))));
}

export function newOpaqueId(prefix: string): string {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** High entropy, so a plain hash is enough, and it can be checked without a slow password hash. */
export function newDeviceSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSecret(secret: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret))));
}

export async function secretMatches(presented: string, storedHash: string): Promise<boolean> {
  const presentedHash = encoder.encode(await hashSecret(presented));
  const stored = encoder.encode(storedHash);
  return presentedHash.byteLength === stored.byteLength && crypto.subtle.timingSafeEqual(presentedHash, stored);
}
