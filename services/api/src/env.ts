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
  /** `console` for local development only. Slice 5 adds real providers. */
  EMAIL_PROVIDER?: string;
  /** The sending address for system email. */
  SYSTEM_EMAIL_FROM?: string;
  NOTIFICATIONS_QUEUE: Queue;
  EMAIL_QUEUE: Queue;
  JOBS_QUEUE: Queue;
  /** Optional: Analytics Engine has to be enabled per account. See tooling/cli/src/render-config.ts. */
  METRICS?: AnalyticsEngineDataset;
}
