import type { ConversationRoom, WorkspaceHub } from '@openchat/realtime';

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS: Fetcher;
  WORKSPACE_HUB: DurableObjectNamespace<WorkspaceHub>;
  CONVERSATION_ROOM: DurableObjectNamespace<ConversationRoom>;
  NOTIFICATIONS_QUEUE: Queue;
  EMAIL_QUEUE: Queue;
  JOBS_QUEUE: Queue;
  /** Optional: Analytics Engine has to be enabled per account. See tooling/cli/src/render-config.ts. */
  METRICS?: AnalyticsEngineDataset;
}
