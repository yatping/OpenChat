/**
 * The installation's side of the relay protocol: signed requests and grants. Nothing leaves here but IDs and
 * notifications encrypted for each phone, which the relay cannot read (ADR-0017).
 * See docs/notification-relay/protocol.md. With no relay configured, push is off and everything else carries on.
 */
import type { SerializedKey } from '@openchat/auth';
import { importPrivateKey, MAX_NOTIFICATION_PAYLOADS, sealNotification, signGrant, signRequest, GRANT_MAX_TTL_SECONDS, type NotificationPayload, type NotificationRequest } from '@openchat/notification-protocol';
import { forgetRelayRegistration, getInstallation, markInstallationRegistered, markWorkspaceRegistered, pushTargets, relayRegistration, type Database, type PushTarget } from '@openchat/database';
import { newId } from '@openchat/shared';
import type { Env } from '../env';

const TIMEOUT_MS = 10_000;

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

/** The configured relay, unless an installation admin disconnected from it. Every path that could register goes through this. */
export async function connectedRelay(env: Env, db: Database): Promise<RelayConfig | null> {
  const relay = relayConfig(env);
  if (!relay) return null;
  const installation = await getInstallation(db);
  return installation?.relayDisconnectedId === relay.id ? null : relay;
}

/** Thrown instead of registering with a relay an admin disconnected from. */
export class RelayDisconnectedError extends Error {
  constructor() {
    super('An installation admin disconnected from this relay');
    this.name = 'RelayDisconnectedError';
  }
}

export function discoveryRelay(env: Env, disconnectedId: string | null) {
  const relay = relayConfig(env);
  if (relay?.id === disconnectedId) return null;
  return relay && { id: relay.id, url: relay.url, bundleIds: relay.bundleIds, publicKeys: [{ id: relay.key.kid, alg: 'Ed25519' as const, key: relay.key.publicKey }] };
}

export class RelayError extends Error {
  /**
   * `permanent` means the request itself is wrong. Anything else may succeed later, so it is retried. That includes a
   * 404, which is what the platform answers for a relay that is gone or misrouted, and which no relay POST route sends.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Relay answered ${status} ${code}`);
    this.name = 'RelayError';
  }
  get permanent(): boolean {
    return [400, 409, 413, 422].includes(this.status);
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

/**
 * Registers only what the relay does not have yet, so that this usually costs one read. Repeating is safe, since
 * the relay answers the same installation and key with success. The relay is never told the workspace's name.
 */
export async function ensureRegistered(db: Database, relay: RelayConfig, workspaceId: string): Promise<{ installationId: string; workspaceName: string }> {
  const known = await relayRegistration(db, workspaceId);
  if (!known) throw new Error('Workspace or installation is missing');
  // Read in the same query as the rest, so that a job queued before the disconnect cannot register again.
  if (known.relayDisconnectedId === relay.id) throw new RelayDisconnectedError();
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
  if (!workspaceCurrent) {
    await relayRequest(relay, installationId, '/v1/workspaces/register', { workspaceId }, workspaceId);
    await markWorkspaceRegistered(db, workspaceId);
  }
  return { installationId, workspaceName: known.workspaceName };
}

export async function issueGrant(db: Database, relay: RelayConfig, workspaceId: string, memberId: string) {
  let installationId: string;
  try {
    ({ installationId } = await ensureRegistered(db, relay, workspaceId));
  } catch (error) {
    // The relay erased this installation, so the next attempt registers it again.
    if (error instanceof RelayError && error.unrecognised) await forgetRelayRegistration(db);
    throw error;
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + GRANT_MAX_TTL_SECONDS;
  const grant = await signGrant(await importPrivateKey(relay.key.privateKey), relay.key.kid, { iss: installationId, aud: relay.id, wid: workspaceId, sub: memberId, jti: newId('grant'), iat, exp });
  return { grant, relayUrl: relay.url, expiresAt: new Date(exp * 1000).toISOString() };
}

/** A notification before it is encrypted for each of the recipient's phones. */
export type UnsealedNotification = Omit<NotificationRequest, 'payloads'>;
/** What the phone shows under the workspace's name. The same for every recipient of one event. */
export interface NotificationText {
  sender: string;
  text: string;
}

/**
 * Encrypts each notification once for each of its recipient's phones, newest first. A notification for someone with
 * no phone left on this relay is dropped here, since the relay could deliver nothing.
 */
export async function sealForPhones(
  targets: PushTarget[],
  ids: { installationId: string; workspaceId: string; workspaceName: string },
  notifications: UnsealedNotification[],
  text: NotificationText,
): Promise<NotificationRequest[]> {
  const byMember = new Map<string, PushTarget[]>();
  for (const target of targets) byMember.set(target.memberId, [...(byMember.get(target.memberId) ?? []), target]);
  const content = { title: ids.workspaceName, ...text };
  const sealed: NotificationRequest[] = [];
  for (const notification of notifications) {
    const phones = (byMember.get(notification.recipientId) ?? []).slice(0, MAX_NOTIFICATION_PAYLOADS);
    const payloads = await Promise.all(
      phones.map(async (phone): Promise<NotificationPayload | null> => {
        const binding = { installationId: ids.installationId, workspaceId: ids.workspaceId, notificationId: notification.notificationId, subscriptionId: phone.relaySubscriptionId };
        try {
          return { subscriptionId: phone.relaySubscriptionId, ciphertext: await sealNotification(phone.previewKey, content, binding) };
        } catch {
          // A key that cannot be used costs that phone its notification, and nobody else theirs.
          return null;
        }
      }),
    );
    const usable = payloads.filter((payload) => payload !== null);
    if (usable.length > 0) sealed.push({ ...notification, payloads: usable });
  }
  return sealed;
}

export async function sendNotifications(db: Database, relay: RelayConfig, workspaceId: string, notifications: UnsealedNotification[], text: NotificationText): Promise<void> {
  try {
    const { installationId, workspaceName } = await ensureRegistered(db, relay, workspaceId);
    const targets = await pushTargets(db, workspaceId, relay.id, [...new Set(notifications.map((notification) => notification.recipientId))]);
    const sealed = await sealForPhones(targets, { installationId, workspaceId, workspaceName }, notifications, text);
    if (sealed.length === 0) return;
    await relayRequest(relay, installationId, '/v1/notifications/batch', { notifications: sealed }, workspaceId);
  } catch (error) {
    // Pushes queued before an admin disconnected are dropped. Messaging does not depend on them.
    if (error instanceof RelayDisconnectedError) return;
    if (error instanceof RelayError && error.unrecognised) await forgetRelayRegistration(db);
    throw error;
  }
}

/**
 * Push off first, then the relay erases everything it holds about this installation. A relay that no longer knows
 * the installation has nothing to erase. Anything else is thrown, and repeating this finishes the job.
 */
export async function eraseAtRelay(db: Database, relay: RelayConfig): Promise<void> {
  const installation = await getInstallation(db);
  if (!installation) throw new Error('The installation is missing');
  try {
    await relayRequest(relay, installation.id, '/v1/installations/unregister', {});
  } catch (error) {
    if (!(error instanceof RelayError && error.unrecognised)) throw error;
  }
}
