/**
 * Password hashing. Parameters are stored with each hash so they can be raised later. Why scrypt, and
 * why these values: ADR-0009. Spike S3 measured a median of about 261 ms of CPU per hash on Workers Paid.
 */
import { scrypt, timingSafeEqual } from 'node:crypto';
import { fromBase64Url, toBase64Url } from './encoding';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const CURRENT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

/** Hashing is costly, so an oversized password must be refused before it reaches scrypt. */
export const MAX_PASSWORD_LENGTH = 1024;
export const MIN_PASSWORD_LENGTH = 10;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Above the 32 MiB these parameters use, and small enough that a bad stored value cannot exhaust an isolate.
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

const derive = (password: string, salt: Uint8Array, params: ScryptParams, length: number) =>
  new Promise<Uint8Array>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { ...params, maxmem: MAX_MEMORY_BYTES }, (error, key) =>
      error ? reject(error) : resolve(new Uint8Array(key)),
    );
  });

export async function hashPassword(password: string, params: ScryptParams = CURRENT_PARAMS): Promise<string> {
  if (password.length > MAX_PASSWORD_LENGTH) throw new RangeError('Password too long');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(password, salt, params, KEY_BYTES);
  return `scrypt$${params.N}$${params.r}$${params.p}$${toBase64Url(salt)}$${toBase64Url(key)}`;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Uint8Array;
  key: Uint8Array;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const valid = [N, r, p].every((v) => Number.isSafeInteger(v) && v > 0) && (N & (N - 1)) === 0 && N > 1;
  if (!valid || 128 * N * r > MAX_MEMORY_BYTES / 1.5 || p > 16) return null;
  try {
    const salt = fromBase64Url(parts[4]!);
    const key = fromBase64Url(parts[5]!);
    return key.length > 0 ? { params: { N, r, p }, salt, key } : null;
  } catch {
    return null;
  }
}

/** Never throws for a wrong password or a malformed hash, so callers have only one failure path. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

/** True when a successful login should replace the stored hash. */
export function needsRehash(stored: string, params: ScryptParams = CURRENT_PARAMS): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p;
}

let dummy: Promise<string> | undefined;

/**
 * Spends the same work as a real check when an account does not exist, so that login timing does not
 * reveal which emails are registered. See docs/architecture/security.md.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  await verifyPassword(password, await dummy);
  return false;
}
