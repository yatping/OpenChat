/**
 * The hourly retention sweep. Each step is bounded, so a large backlog clears over several hours rather than
 * holding D1, which live traffic shares. Files are deleted by dispatch, from the outbox rows the sweep writes.
 * See docs/architecture/data-model.md#retention.
 */
import { expireContacts, expireConversations, purgeHousekeeping, workspacesWithRetention, type Database } from '@openchat/database';
import { createLogger } from '@openchat/shared';

const WORKSPACES_PER_RUN = 200;
const CHUNK = 50;
/** Chunks of conversations per workspace per run: 500 an hour, 12,000 a day. */
const CHUNKS_PER_WORKSPACE = 10;
const HOUSEKEEPING_CHUNK = 500;

export async function sweepRetention(db: Database): Promise<void> {
  const log = createLogger();
  try {
    const anonymous = await purgeHousekeeping(db, HOUSEKEEPING_CHUNK);
    if (anonymous > 0) log.info('retention_anonymous_contacts', { count: anonymous });
  } catch (error) {
    log.error('retention_housekeeping_failed', { errorName: (error as Error).name });
  }
  for (const workspace of await workspacesWithRetention(db, WORKSPACES_PER_RUN)) {
    try {
      let conversations = 0;
      for (let i = 0; i < CHUNKS_PER_WORKSPACE; i++) {
        const count = await expireConversations(db, workspace, CHUNK);
        conversations += count;
        if (count < CHUNK) break;
      }
      const contacts = await expireContacts(db, workspace, HOUSEKEEPING_CHUNK);
      if (conversations > 0) log.info('retention_conversations_expired', { workspaceId: workspace.id, count: conversations });
      if (contacts > 0) log.info('retention_contacts_expired', { workspaceId: workspace.id, count: contacts });
    } catch (error) {
      // One workspace's failure leaves the rest to run. The next hour tries again.
      log.error('retention_failed', { workspaceId: workspace.id, errorName: (error as Error).name });
    }
  }
}
