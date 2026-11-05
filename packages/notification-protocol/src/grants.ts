/**
 * Device grants: compact EdDSA JWS tokens by which an installation vouches for one of its members. The relay checks
 * that `jti` is unused, because that needs strongly consistent storage. See docs/notification-relay/protocol.md.
 */
import { fromBase64Url, toBase64Url } from './signing';
import { type DeviceGrantClaims, GRANT_MAX_TTL_SECONDS, MAX_CLOCK_SKEW_SECONDS } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ED25519 = { name: 'Ed25519' } as const;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function signGrant(key: CryptoKey, keyId: string, claims: DeviceGrantClaims): Promise<string> {
  const encode = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: 'EdDSA', kid: keyId, typ: 'oc-grant+jwt' })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(ED25519, key, encoder.encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface UnverifiedGrant {
  keyId: string;
  claims: DeviceGrantClaims;
  signingInput: string;
  signature: Uint8Array<ArrayBuffer>;
}

/** Reads a grant, enough to find the key that should have signed it. Nothing in it can be trusted yet. */
export function parseGrant(grant: string): UnverifiedGrant | null {
  const parts = grant.split('.');
  if (parts.length !== 3 || grant.length > 2048) return null;
  try {
    const header = JSON.parse(decoder.decode(fromBase64Url(parts[0]!))) as { alg?: unknown; kid?: unknown; typ?: unknown };
    // The algorithm is fixed, and is never chosen by the token.
    if (header.alg !== 'EdDSA' || header.typ !== 'oc-grant+jwt' || typeof header.kid !== 'string' || !ID.test(header.kid)) return null;
    const claims = JSON.parse(decoder.decode(fromBase64Url(parts[1]!))) as Record<string, unknown>;
    for (const name of ['iss', 'aud', 'wid', 'sub', 'jti'] as const) if (typeof claims[name] !== 'string') return null;
    for (const name of ['iss', 'wid', 'sub', 'jti'] as const) if (!ID.test(claims[name] as string)) return null;
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
    const signature = fromBase64Url(parts[2]!);
    if (signature.length !== 64) return null;
    return { keyId: header.kid, claims: claims as unknown as DeviceGrantClaims, signingInput: `${parts[0]}.${parts[1]}`, signature };
  } catch {
    return null;
  }
}

/** Checks the signature, the audience, and the times. A grant lasts 5 minutes at most, whatever it claims. */
export async function verifyGrant(key: CryptoKey, grant: UnverifiedGrant, audience: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const { aud, iat, exp } = grant.claims;
  if (aud !== audience || exp <= iat || exp - iat > GRANT_MAX_TTL_SECONDS || nowSeconds >= exp || iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return false;
  return crypto.subtle.verify(ED25519, key, grant.signature, encoder.encode(grant.signingInput));
}
