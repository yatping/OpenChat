/**
 * Notification relay protocol: DESIGN DRAFT.
 *
 * Becomes packages/notification-protocol, which uses only Web-standard APIs so that it runs in both
 * Workers and React Native. It must not import anything from the installation.
 */

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const SIGNATURE_DOMAIN = 'OCRELAY-V1' as const;
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const NONCE_TTL_SECONDS = 600;
export const GRANT_MAX_TTL_SECONDS = 300;

export type NotificationEvent =
  | 'new_conversation'
  | 'new_message'
  | 'conversation_assigned'
  | 'conversation_transferred'
  | 'mention'
  | 'conversation_updated';

export type PushEnvironment = 'sandbox' | 'production';
export type Platform = 'ios';

/** Closed by design. Adding free text here would break the promise that the relay receives no content. */
export interface NotificationRequest {
  workspaceId: string;
  event: NotificationEvent;
  recipientId: string;
  conversationId: string;
  notificationId: string;
  expiresAt?: string;
  metadata?: { websiteId?: string };
}

export interface NotificationAccepted {
  id: string;
  notificationId: string;
  status: 'queued' | 'duplicate';
}

export interface NotificationStatus {
  id: string;
  notificationId: string;
  status: 'queued' | 'delivering' | 'completed' | 'expired' | 'no_devices';
  outcomes: { delivered: number; invalidToken: number; failed: number; muted: number };
  updatedAt: string;
}

/** Custom key inside the APNs payload. The app routes from this alone. */
export interface PushData {
  v: 1;
  event: NotificationEvent;
  installationId: string;
  workspaceId: string;
  conversationId: string;
  notificationId: string;
}

export interface DeviceGrantClaims {
  iss: string; // installationId
  aud: string; // relay ID
  wid: string; // workspaceId
  sub: string; // memberId, opaque to the relay
  jti: string; // single use
  iat: number;
  exp: number; // at most GRANT_MAX_TTL_SECONDS after iat
}

export interface DeviceRegisterRequest {
  grant: string;
  platform: Platform;
  apnsToken: string;
  bundleId: string;
  environment: PushEnvironment;
  locale: string;
  /** Present on subsequent registrations, so one device is reused across workspaces. */
  device?: { id: string; secret: string };
}

export interface DeviceRegisterResponse {
  deviceId: string;
  /** Returned only when the device is created. Stored by the app in secure storage. */
  deviceSecret?: string;
  subscriptionId: string;
}

export interface SignedHeaders {
  'X-Installation-ID': string;
  'X-Workspace-ID'?: string;
  'X-Key-ID': string;
  'X-Request-ID': string;
  'X-Timestamp': string;
  'X-Signature': `v1=${string}`;
}

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The exact bytes that are signed. Shared by signer and verifier so that they cannot diverge. */
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

/** Transport seam, because Worker HTTP/2 to APNs is observed behaviour and not a guarantee. */
export interface ApnsRequest {
  host: 'api.push.apple.com' | 'api.sandbox.push.apple.com';
  token: string;
  headers: Record<string, string>;
  body: string;
}
export interface ApnsResponse {
  status: number;
  apnsId?: string;
  reason?: string;
  timestamp?: number;
}
export interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
}
