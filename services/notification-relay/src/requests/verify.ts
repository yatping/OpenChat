import { importPublicKey, verifyRequest } from '@openchat/notification-protocol';
import type { Env } from '../env';
import { ID_PATTERN } from './schemas';
import { findActiveKey } from './store';

export const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const KEY_CACHE_MS = 30_000;
const KEY_CACHE_MAX = 1_000;

export interface SignedHeaders {
  installationId: string;
  workspaceId?: string;
  keyId: string;
  requestId: string;
  timestamp: string;
  signature: string;
}

export type Rejection =
  | { status: 400; code: 'malformed_request' }
  | { status: 401; code: 'unauthorized' }
  | { status: 401; code: 'stale_timestamp' }
  | { status: 403; code: 'workspace_not_registered' }
  | { status: 409; code: 'replayed' }
  | { status: 413; code: 'body_too_large' }
  | { status: 429; code: 'rate_limited'; retryAfterSeconds: number };

let keyCache = new Map<string, { publicKey: string; until: number }>();

/** Revoking a key takes up to this long to reach every isolate. */
export function clearKeyCache() {
  keyCache = new Map();
}

async function cachedKey(db: D1Database, installationId: string, keyId: string): Promise<string | null> {
  const id = `${installationId}\n${keyId}`;
  const hit = keyCache.get(id);
  if (hit && Date.now() < hit.until) return hit.publicKey;
  const found = await findActiveKey(db, installationId, keyId);
  if (!found) {
    keyCache.delete(id);
    return null;
  }
  if (keyCache.size >= KEY_CACHE_MAX) keyCache = new Map();
  keyCache.set(id, { publicKey: found.publicKey, until: Date.now() + KEY_CACHE_MS });
  return found.publicKey;
}

export function readSignedHeaders(headers: Headers): SignedHeaders | null {
  const installationId = headers.get('x-installation-id');
  const workspaceId = headers.get('x-workspace-id');
  const keyId = headers.get('x-key-id');
  const requestId = headers.get('x-request-id');
  const timestamp = headers.get('x-timestamp');
  const signature = headers.get('x-signature');
  if (!installationId || !keyId || !requestId || !timestamp || !signature) return null;
  if (!ID_PATTERN.test(installationId) || !ID_PATTERN.test(keyId) || !REQUEST_ID_PATTERN.test(requestId) || !/^\d{1,12}$/.test(timestamp)) return null;
  if (workspaceId !== null && !ID_PATTERN.test(workspaceId)) return null;
  return { installationId, ...(workspaceId !== null ? { workspaceId } : {}), keyId, requestId, timestamp, signature };
}

/** Checks a signature against one key. Unknown keys and bad signatures answer alike. */
export async function checkSignature(publicKey: string, request: { method: string; path: string; body: Uint8Array }, signed: SignedHeaders): Promise<Rejection | null> {
  let key: CryptoKey;
  try {
    key = await importPublicKey(publicKey);
  } catch {
    return { status: 401, code: 'unauthorized' };
  }
  const result = await verifyRequest(
    key,
    { method: request.method, path: request.path, installationId: signed.installationId, ...(signed.workspaceId !== undefined ? { workspaceId: signed.workspaceId } : {}), keyId: signed.keyId, requestId: signed.requestId, timestamp: signed.timestamp, body: request.body },
    signed.signature,
  );
  if (result.ok) return null;
  return result.reason === 'stale_timestamp' ? { status: 401, code: 'stale_timestamp' } : { status: 401, code: 'unauthorized' };
}

/** Replay and rate limits, per installation. Runs after the signature, so strangers cannot use up either. */
export async function admitToGuard(env: Env, installationId: string, requestId: string): Promise<Rejection | null> {
  const result = await env.RELAY_GUARD.getByName(installationId).admit(requestId);
  if (result.ok) return null;
  return result.reason === 'replayed' ? { status: 409, code: 'replayed' } : { status: 429, code: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
}

export async function verifyKnownInstallation(env: Env, request: { method: string; path: string; body: Uint8Array }, signed: SignedHeaders): Promise<Rejection | null> {
  const publicKey = await cachedKey(env.DB, signed.installationId, signed.keyId);
  if (!publicKey) return { status: 401, code: 'unauthorized' };
  return checkSignature(publicKey, request, signed);
}
