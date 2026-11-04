import type { ConversationRoom, WorkspaceHub } from '@openchat/realtime';
import type { AuthGuard } from './auth-guard';

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  WORKSPACE_HUB: DurableObjectNamespace<WorkspaceHub>;
  CONVERSATION_ROOM: DurableObjectNamespace<ConversationRoom>;
  AUTH_GUARD: DurableObjectNamespace<AuthGuard>;
  /** JSON: { active: { kid, privateKey, publicKey }, retired?: [{ kid, publicKey }] }. Worker secret. */
  AUTH_SIGNING_KEY?: string;
  /** `resend`, `cloudflare`, or `console` for local development only. With none, email jobs retry and dead-letter. */
  EMAIL_PROVIDER?: string;
  /** Worker secret. */
  RESEND_API_KEY?: string;
  /** Cloudflare Email Service. Only rendered for a deployment that chose it, restricted to its sending address. */
  EMAIL?: SendEmail;
  /** The sending address for system email, on a domain verified with the provider. */
  SYSTEM_EMAIL_FROM?: string;
  NOTIFICATIONS_QUEUE: Queue;
  EMAIL_QUEUE: Queue;
  JOBS_QUEUE: Queue;
  /** Worker secret, with its pair. Without both, no website can require Turnstile. */
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  /** Optional: Analytics Engine has to be enabled per account. See tooling/cli/src/render-config.ts. */
  METRICS?: AnalyticsEngineDataset;
}
