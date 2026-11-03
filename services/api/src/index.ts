import { createApp } from './app';
import { handleQueue, handleScheduled } from './background';
import type { Env } from './env';

export { ConversationRoom, WorkspaceHub } from '@openchat/realtime';

const app = createApp();

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleQueue(batch, env),
  scheduled: (controller, env) => handleScheduled(controller, env),
} satisfies ExportedHandler<Env>;
