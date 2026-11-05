import type { ApnsCredential } from './apns/credential';
import type { RelayGuard } from './requests/guard';

export interface Env {
  DB: D1Database;
  RELAY_MODE: 'open' | 'private';
  /** Comma-separated installation IDs. Used only in private mode. */
  RELAY_ALLOWED_INSTALLATIONS?: string;
  RELAY_GUARD: DurableObjectNamespace<RelayGuard>;
  /** This relay's name, which a grant must carry as its audience. */
  RELAY_ID?: string;
  /** Comma-separated bundle IDs this relay holds an APNs key for. */
  RELAY_BUNDLE_IDS?: string;
  /** A Worker secret: base64url of 32 random bytes. Encrypts APNs tokens at rest. */
  RELAY_TOKEN_KEY?: string;
  /** Approximate, per IP, for device registration. */
  DEVICE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Approximate, per IP, for new registrations before any signature has been checked. */
  REGISTRATION_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
  APNS_CREDENTIAL: DurableObjectNamespace<ApnsCredential>;
  /** 'production' or 'sandbox'. A key can be limited to one of them. */
  APNS_ENVIRONMENT?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  /** The contents of the .p8 file. A Worker secret, never distributed. */
  APNS_PRIVATE_KEY?: string;
  /** The app's bundle ID, used only as the topic of the self-check. */
  APNS_SELF_CHECK_TOPIC?: string;
  /** A Worker secret. The operator routes do not exist unless this is set. */
  RELAY_OPERATOR_TOKEN?: string;
}
