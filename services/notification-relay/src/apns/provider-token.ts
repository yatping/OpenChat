/** APNs provider tokens: ES256 JWTs, which APNs rejects if refreshed too often or used for over an hour. */
export interface ApnsIdentity {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
}

export interface StoredToken {
  token: string;
  keyId: string;
  mintedAt: number;
}

const MINUTE = 60_000;
/** APNs answers TooManyProviderTokenUpdates to tokens replaced more often than this. */
export const MIN_TOKEN_AGE_MS = 20 * MINUTE;
export const RENEW_TOKEN_AGE_MS = 40 * MINUTE;
export const MAX_TOKEN_AGE_MS = 60 * MINUTE;
export const MINTING_PAUSE_MS = 20 * MINUTE;

export type MintDecision = 'reuse' | 'mint' | 'unavailable';

/**
 * Whether to keep the current token. `staleToken` is one that APNs called expired: if it is not the current
 * token then another caller has replaced it already, and a young token is kept so that a wrong answer cannot
 * cause a burst of minting.
 */
export function decideMint(input: { current: StoredToken | undefined; keyId: string; now: number; noMintUntil: number; staleToken?: string | undefined }): MintDecision {
  const { current, keyId, now, noMintUntil, staleToken } = input;
  const paused = now < noMintUntil;
  const usable = current !== undefined && current.keyId === keyId && now - current.mintedAt < MAX_TOKEN_AGE_MS;
  if (!usable) return paused ? 'unavailable' : 'mint';
  if (paused) return 'reuse';
  const age = now - current.mintedAt;
  if (age >= RENEW_TOKEN_AGE_MS) return 'mint';
  return staleToken === current.token && age >= MIN_TOKEN_AGE_MS ? 'mint' : 'reuse';
}

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

export async function mintProviderToken(identity: ApnsIdentity, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(identity.privateKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: 'ES256', kid: identity.keyId })}.${encode({ iss: identity.teamId, iat: Math.floor(nowMs / 1000) })}`;
  // WebCrypto returns ECDSA signatures as raw r||s, which is the form JWTs use.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
