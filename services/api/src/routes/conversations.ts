import { createAgentTicketRoute, getConversationRoute, listConversationsRoute, listMessagesRoute, markConversationReadRoute, sendMessageRoute, updateConversationRoute } from '@openchat/api-contracts';
import { createAgentTicket, getConversation, listConversations, listMessages, markConversationRead, sendMessage, updateConversation, workspaceContext } from '@openchat/core';
import type { Context } from 'hono';
import { authDeps, type App, type AppEnv } from '../context';
import { dispatchSoon, socketUrl } from '../dispatch';

/** Authentication comes from the /api/v1/workspaces/* prefix in routes/workspaces.ts. */
async function scoped(c: Context<AppEnv>, workspaceId: string) {
  const deps = await authDeps(c.env);
  return { db: deps.db, ctx: await workspaceContext(deps.db, c.get('principal'), workspaceId) };
}

export function registerConversationRoutes(app: App) {
  app.openapi(listConversationsRoute, async (c) => {
    const { db, ctx } = await scoped(c, c.req.valid('param').workspaceId);
    return c.json(await listConversations(db, ctx, c.req.valid('query')), 200);
  });

  app.openapi(getConversationRoute, async (c) => {
    const { workspaceId, conversationId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    return c.json(await getConversation(db, ctx, conversationId), 200);
  });

  app.openapi(updateConversationRoute, async (c) => {
    const { workspaceId, conversationId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    const updated = await updateConversation(db, ctx, conversationId, c.req.valid('json'));
    dispatchSoon(c, workspaceId, [conversationId]);
    return c.json(updated, 200);
  });

  app.openapi(listMessagesRoute, async (c) => {
    const { workspaceId, conversationId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    return c.json(await listMessages(db, ctx, conversationId, c.req.valid('query')), 200);
  });

  app.openapi(sendMessageRoute, async (c) => {
    const { workspaceId, conversationId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    const { created, message } = await sendMessage(db, ctx, conversationId, c.req.valid('json'));
    // A replay too: if the first attempt died before dispatching, this finishes the job.
    dispatchSoon(c, workspaceId, [message.id]);
    return created ? c.json(message, 201) : c.json(message, 200);
  });

  app.openapi(createAgentTicketRoute, async (c) => {
    const deps = await authDeps(c.env);
    const ctx = await workspaceContext(deps.db, c.get('principal'), c.req.valid('param').workspaceId);
    const { ticket, expiresAt } = await createAgentTicket(deps, ctx, c.req.header('origin'));
    return c.json({ ticket, expiresAt, url: socketUrl(c, ticket) }, 201);
  });

  app.openapi(markConversationReadRoute, async (c) => {
    const { workspaceId, conversationId } = c.req.valid('param');
    const { db, ctx } = await scoped(c, workspaceId);
    await markConversationRead(db, ctx, conversationId, c.req.valid('json'));
    return c.body(null, 204);
  });
}
