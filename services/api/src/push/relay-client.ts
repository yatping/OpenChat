/**
 * The installation's side of the relay protocol: signed requests and grants, and nothing else leaves here but IDs.
 * See docs/notification-relay/protocol.md. With no relay configured, push is off and everything else carries on.
 */
import type { SerializedKey } from '@openchat/auth';
import { importPrivateKey, signGrant, signRequest, GRANT_MAX_TTL_SECONDS, type NotificationRequest } from '@openchat/notification-protocol';
import { forgetRelayRegistration, getInstallation, markInstallationRegistered, markWorkspaceRegistered, relayRegistration, type Database } from '@openchat/database';
import { newId } from '@openchat/shared';
import type { Env } from '../env';

const TIMEOUT_MS = 10_000;
const MAX_DISPLAY_NAME = 40;

export interface RelayConfig {
  id: string;
  url: string;
  bundleIds: string[];
  key: SerializedKey;
}

export function relayConfig(env: Env): RelayConfig | null {
  if (!env.RELAY_URL || !env.RELAY_ID || !env.RELAY_BUNDLE_IDS || !env.RELAY_SIGNING_KEY) return null;
  let active: SerializedKey;
  try {
    ({ active } = JSON.parse(env.RELAY_SIGNING_KEY) as { active: SerializedKey });
  } catch {
    // Discovery and dispatch both come through here, and a bad secret must cost push and nothing else.
    return null;
  }
  return { id: env.RELAY_ID, url: env.RELAY_URL.replace(/\/+$/, ''), bundleIds: env.RELAY_BUNDLE_IDS.split(',').map((id) => id.trim()).filter(Boolean), key: active };
}

export function discoveryRelay(env: Env) {
  const relay = relayConfig(env);
  return relay && { id: relay.id, url: relay.url, bundleIds: relay.bundleIds, publicKeys: [{ id: relay.key.kid, alg: 'Ed25519' as const, key: relay.key.publicKey }] };
}

export class RelayError extends Error {
  /** `permanent` means the request itself is wrong. Anything else may succeed later, so it is retried. */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Relay answered ${status} ${code}`);
    this.name = 'RelayError';
  }
  get permanent(): boolean {
    return [400, 404, 409, 413, 422].includes(this.status);
  }
  /** The relay does not know this installation or workspace, as after it lost its data. */
  get unrecognised(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export async function relayRequest(relay: RelayConfig, installationId: string, path: string, body: unknown, workspaceId?: string): Promise<unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const requestId = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signRequest(await importPrivateKey(relay.key.privateKey), {
    method: 'POST',
    path,
    installationId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    keyId: relay.key.kid,
    requestId,
    timestamp,
    body: bytes,
  });
  const response = await fetch(`${relay.url}${path}`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      'x-installation-id': installationId,
      ...(workspaceId === undefined ? {} : { 'x-workspace-id': workspaceId }),
      'x-key-id': relay.key.kid,
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'x-signature': signature,
    },
    body: bytes,
  });
  if (response.ok) return response.status === 204 ? null : response.json().catch(() => null);
  const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const retryAfter = Number(response.headers.get('retry-after'));
  throw new RelayError(response.status, typeof problem?.code === 'string' ? problem.code : 'unknown', Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
}

/** The relay's limit counts UTF-16 units, and cutting a surrogate pair in half would leave broken text. */
function displayNameOf(name: string): string {
  let out = '';
  for (const character of name) {
    if (out.length + character.length > MAX_DISPLAY_NAME) break;
    out += character;
  }
  return out;
}

/**
 * Registers only what the relay does not have yet, so that this usually costs one read. Repeating is safe, since
 * the relay answers the same installation and key with success. A rename goes out here, before the next push.
 */
export async function ensureRegistered(db: Database, relay: RelayConfig, workspaceId: string): Promise<string> {
  const known = await relayRegistration(db, workspaceId);
  if (!known) throw new Error('Workspace or installation is missing');
  const { installationId } = known;
  let workspaceCurrent = known.workspaceStatus === 'registered';
  if (known.installationRelayId !== relay.id) {
    const installation = await getInstallation(db);
    await relayRequest(relay, installationId, '/v1/installations/register', {
      baseUrl: installation!.publicBaseUrl,
      publicKey: { id: relay.key.kid, alg: 'Ed25519', key: relay.key.publicKey },
    });
    await markInstallationRegistered(db, relay.id);
    workspaceCurrent = false;
  }
  const displayName = displayNameOf(known.workspaceName);
  if (!workspaceCurrent || known.workspaceDisplayName !== displayName) {
    await relayRequest(relay, installationId, '/v1/workspaces/register', { workspaceId, displayName }, workspaceId);
    await markWorkspaceRegistered(db, workspaceId, displayName);
  }
  return installationId;
}

export async function issueGrant(db: Database, relay: RelayConfig, workspaceId: string, memberId: string) {
  const installationId = await ensureRegistered(db, relay, workspaceId);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + GRANT_MAX_TTL_SECONDS;
  const grant = await signGrant(await importPrivateKey(relay.key.privateKey), relay.key.kid, { iss: installationId, aud: relay.id, wid: workspaceId, sub: memberId, jti: newId('grant'), iat, exp });
  return { grant, relayUrl: relay.url, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function sendNotifications(db: Database, relay: RelayConfig, workspaceId: string, notifications: NotificationRequest[]): Promise<void> {
  try {
    const installationId = await ensureRegistered(db, relay, workspaceId);
    await relayRequest(relay, installationId, '/v1/notifications/batch', { notifications }, workspaceId);
  } catch (error) {
    if (error instanceof RelayError && error.unrecognised) await forgetRelayRegistration(db);
    throw error;
  }
}
