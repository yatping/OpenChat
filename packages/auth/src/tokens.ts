/**
 * Access tokens are EdDSA JWTs. They hold identity only, with no roles, so that membership is read per
 * request and revocation is immediate. Refresh and one-time tokens are opaque, and stored only as hashes.
 * See docs/architecture/security.md.
 */
import { fromBase64Url, toBase64Url } from './encoding';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 4096;

const ED25519 = { name: 'Ed25519' } as const;
const encoder = new TextEncoder();

export interface AccessClaims {
  sub: string;
  sid: string;
  iss: string;
  iat: number;
  exp: number;
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
}

/** Holds two keys during rotation, so tokens signed by the outgoing key stay valid until they expire. */
export type VerificationKeys = ReadonlyMap<string, CryptoKey>;

export type VerifyFailure = 'malformed' | 'bad_algorithm' | 'unknown_key' | 'bad_signature' | 'bad_issuer' | 'expired';
export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; reason: VerifyFailure };

const encodeJson = (value: unknown) => toBase64Url(encoder.encode(JSON.stringify(value)));

export async function signAccessToken(
  key: SigningKey,
  input: { userId: string; sessionId: string; installationId: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const claims: AccessClaims = { sub: input.userId, sid: input.sessionId, iss: input.installationId, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS };
  const body = `${encodeJson({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isClaims = (value: Record<string, unknown>): value is Record<string, unknown> & AccessClaims =>
  typeof value.sub === 'string' &&
  typeof value.sid === 'string' &&
  typeof value.iss === 'string' &&
  Number.isSafeInteger(value.iat) &&
  Number.isSafeInteger(value.exp);

/** The algorithm is fixed here and never taken from the token, which rules out algorithm confusion. */
/** The signature and shape only. Each kind of token then decides whether the claims are its own. */
async function verifySigned(token: string, keys: VerificationKeys): Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; reason: VerifyFailure }> {
  if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  if (!header) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'bad_algorithm' };
  const key = typeof header.kid === 'string' ? keys.get(header.kid) : undefined;
  if (!key) return { ok: false, reason: 'unknown_key' };

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64Url(signaturePart);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // workerd throws on a wrong length where Node returns false. See the same check in notification-protocol.
  if (signature.length !== 64) return { ok: false, reason: 'bad_signature' };
  const valid = await crypto.subtle.verify(ED25519, key, signature, encoder.encode(`${headerPart}.${claimsPart}`));
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const claims = decodeJson(claimsPart);
  if (!claims) return { ok: false, reason: 'malformed' };
  return { ok: true, claims };
}

export async function verifyAccessToken(
  token: string,
  keys: VerificationKeys,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const signed = await verifySigned(token, keys);
  if (!signed.ok) return signed;
  const { claims } = signed;
  // Any audience means a token for something else, such as a visitor.
  if (claims.aud !== undefined || !isClaims(claims)) return { ok: false, reason: 'malformed' };
  if (claims.iss !== issuer) return { ok: false, reason: 'bad_issuer' };
  if (claims.exp + CLOCK_SKEW_SECONDS <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { sub: claims.sub, sid: claims.sid, iss: claims.iss, iat: claims.iat, exp: claims.exp } };
}

/** 256 random bits: refresh tokens, invitations, password resets, and email verification. */
export function generateOpaqueToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Only this is stored, so a database leak does not expose usable tokens. */
export async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Worker secret format: JSON of { kid, privateKey (PKCS#8, base64url), publicKey (raw, base64url) }. */
export interface SerializedKey {
  kid: string;
  privateKey: string;
  publicKey: string;
}

export async function generateSerializedKey(kid: string): Promise<SerializedKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const publicKey = (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { kid, privateKey: toBase64Url(new Uint8Array(privateKey)), publicKey: toBase64Url(new Uint8Array(publicKey)) };
}

export async function importSigningKey(serialized: SerializedKey): Promise<SigningKey> {
  return { kid: serialized.kid, privateKey: await crypto.subtle.importKey('pkcs8', fromBase64Url(serialized.privateKey), ED25519, false, ['sign']) };
}

export async function importVerificationKeys(serialized: readonly Pick<SerializedKey, 'kid' | 'publicKey'>[]): Promise<VerificationKeys> {
  const entries = await Promise.all(
    serialized.map(async (k) => [k.kid, await crypto.subtle.importKey('raw', fromBase64Url(k.publicKey), ED25519, false, ['verify'])] as const),
  );
  return new Map(entries);
}

export const VISITOR_TOKEN_TTL_SECONDS = 60 * 60;

export interface VisitorClaims {
  aud: 'visitor';
  sub: string;
  wid: string;
  site: string;
  iss: string;
  iat: number;
  exp: number;
}

export async function signVisitorToken(
  key: SigningKey,
  input: { visitorId: string; workspaceId: string; websiteId: string; installationId: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const claims: VisitorClaims = { aud: 'visitor', sub: input.visitorId, wid: input.workspaceId, site: input.websiteId, iss: input.installationId, iat: now, exp: now + VISITOR_TOKEN_TTL_SECONDS };
  const body = `${encodeJson({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Refuses anything without the visitor audience, so an agent's token can never act as a visitor. */
export async function verifyVisitorToken(
  token: string,
  keys: VerificationKeys,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; claims: VisitorClaims } | { ok: false; reason: VerifyFailure }> {
  const signed = await verifySigned(token, keys);
  if (!signed.ok) return signed;
  const c = signed.claims;
  if (c.aud !== 'visitor' || typeof c.sub !== 'string' || typeof c.wid !== 'string' || typeof c.site !== 'string' || typeof c.iss !== 'string' || typeof c.iat !== 'number' || typeof c.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (c.iss !== issuer) return { ok: false, reason: 'bad_issuer' };
  if (c.exp + CLOCK_SKEW_SECONDS <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { aud: 'visitor', sub: c.sub, wid: c.wid, site: c.site, iss: c.iss, iat: c.iat, exp: c.exp } };
}

export const TICKET_TTL_SECONDS = 30;

/** One WebSocket connection. Short enough that it does no harm in a URL, where it may reach logs. */
export interface TicketClaims {
  aud: 'realtime';
  kind: 'agent' | 'visitor';
  /** A member or a visitor. */
  sub: string;
  wid: string;
  /** For a visitor, the one conversation this socket may watch. */
  conv?: string;
  role?: string;
  /** The page that asked for it. The connection must come from the same one, or from none at all. */
  org?: string;
  /** When the socket's authorisation ends, in milliseconds. */
  until: number;
  iss: string;
  iat: number;
  exp: number;
}

export async function signTicket(key: SigningKey, input: Omit<TicketClaims, 'aud' | 'iat' | 'exp'>, now: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const claims: TicketClaims = { ...input, aud: 'realtime', iat: now, exp: now + TICKET_TTL_SECONDS };
  const body = `${encodeJson({ alg: 'EdDSA', typ: 'JWT', kid: key.kid })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(ED25519, key.privateKey, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** No clock skew allowance, because the lifetime is so short and the issuer is this installation. */
export async function verifyTicket(
  token: string,
  keys: VerificationKeys,
  issuer: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; claims: TicketClaims } | { ok: false; reason: VerifyFailure }> {
  const signed = await verifySigned(token, keys);
  if (!signed.ok) return signed;
  const c = signed.claims;
  if (c.aud !== 'realtime' || (c.kind !== 'agent' && c.kind !== 'visitor') || typeof c.sub !== 'string' || typeof c.wid !== 'string' || typeof c.until !== 'number' || typeof c.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (c.kind === 'visitor' && typeof c.conv !== 'string') return { ok: false, reason: 'malformed' };
  if (c.iss !== issuer) return { ok: false, reason: 'bad_issuer' };
  if (c.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: c as unknown as TicketClaims };
}
