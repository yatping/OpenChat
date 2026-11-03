/** Relay protocol types. See docs/notification-relay/protocol.md. */
export const RELAY_PROTOCOL_VERSION = 1 as const;
export const SIGNATURE_DOMAIN = 'OCRELAY-V1' as const;
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const NONCE_TTL_SECONDS = 600;
export const GRANT_MAX_TTL_SECONDS = 300;

export const NOTIFICATION_EVENTS = [
  'new_conversation',
  'new_message',
  'conversation_assigned',
  'conversation_transferred',
  'mention',
  'conversation_updated',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

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

/** The custom key inside the APNs payload. The app routes from this alone. */
export interface PushData {
  v: 1;
  event: NotificationEvent;
  installationId: string;
  workspaceId: string;
  conversationId: string;
  notificationId: string;
}

export interface DeviceGrantClaims {
  iss: string;
  aud: string;
  wid: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface DeviceRegisterRequest {
  grant: string;
  platform: Platform;
  apnsToken: string;
  bundleId: string;
  environment: PushEnvironment;
  locale: string;
  device?: { id: string; secret: string };
}

export interface DeviceRegisterResponse {
  deviceId: string;
  deviceSecret?: string;
  subscriptionId: string;
}

/** Transport seam, because Worker HTTP/2 to APNs is observed behaviour and not a guarantee. See ADR-0006. */
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
