import type { ApnsCredential } from './apns/credential';
import type { RelayGuard } from './requests/guard';

export interface Env {
  DB: D1Database;
  RELAY_MODE: 'open' | 'private';
  /** Comma-separated installation IDs. Used only in private mode. */
  RELAY_ALLOWED_INSTALLATIONS?: string;
  RELAY_GUARD: DurableObjectNamespace<RelayGuard>;
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
