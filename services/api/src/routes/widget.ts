import {
  downloadVisitorAttachmentRoute,
  uploadVisitorAttachmentRoute,
  createVisitorConversationRoute,
  createVisitorSessionRoute,
  createVisitorTicketRoute,
  listVisitorConversationsRoute,
  listVisitorMessagesRoute,
  markVisitorConversationReadRoute,
  sendVisitorMessageRoute,
  updateVisitorProfileRoute,
  widgetBootstrapRoute,
} from '@openchat/api-contracts';
import {
  beginVisitorUpload,
  visitorAttachment,
  assertVisitorOrigin,
  authenticateVisitor,
  createVisitorConversation,
  createVisitorSession,
  createVisitorTicket,
  listVisitorConversations,
  listVisitorMessages,
  markVisitorConversationRead,
  sendVisitorMessage,
  updateVisitorProfile,
  websiteForWidget,
  type VisitorContext,
} from '@openchat/core';
import { AppError, notFound } from '@openchat/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { hubName } from '@openchat/realtime';
import { authDeps, type App, type AppEnv } from '../context';
import { receiveUpload, sendFile } from '../attachments';
import { dispatchSoon, publishRead, socketUrl } from '../dispatch';

type WidgetEnv = { Bindings: AppEnv['Bindings']; Variables: AppEnv['Variables'] & { visitor: VisitorContext } };

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

/**
 * Bearer tokens only and no cookies, so a cross-origin read carries no ambient authority, and the header can
 * name the caller. Refusing an origin the website does not allow happens on the server, in each route.
 */
const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...(origin ? { 'access-control-allow-origin': origin } : {}),
        'access-control-allow-methods': 'GET, POST, PATCH',
        'access-control-allow-headers': 'authorization, content-type, x-request-id',
        'access-control-max-age': '600',
        vary: 'Origin',
      },
    });
  }
  await next();
  if (origin) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-expose-headers', 'retry-after, x-request-id');
  }
  c.header('vary', 'Origin');
};

const requireVisitor: MiddlewareHandler<WidgetEnv> = async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) throw new AppError(401, 'unauthorized', 'Start a new visitor session');
  const visitor = await authenticateVisitor(await authDeps(c.env), token);
  assertVisitorOrigin(visitor, c.req.header('origin'));
  c.set('visitor', visitor);
  await next();
};

const BOOTSTRAP_TTL_SECONDS = 30;

interface CachedBootstrap {
  found: boolean;
  websiteId?: string;
  settings?: Record<string, unknown>;
  allowedOrigins?: string[];
  availability?: 'online' | 'offline';
}

/** Cached with the rest, so that page views on a busy site do not wake the hub. */
async function availabilityOf(c: Context<AppEnv>, workspaceId: string, mode: unknown): Promise<'online' | 'offline'> {
  if (mode === 'online' || mode === 'offline') return mode;
  const agents = await c.env.WORKSPACE_HUB.getByName(hubName(workspaceId))
    .connectionCount()
    .catch(() => 0);
  return agents > 0 ? 'online' : 'offline';
}

/** Keeps busy pages off D1. A key that does not exist is cached too, so that guessing cannot reach D1 either. */
async function loadBootstrap(c: Context<AppEnv>, websiteKey: string): Promise<CachedBootstrap> {
  const cache = caches.default;
  const key = new Request(`https://widget-bootstrap.invalid/${encodeURIComponent(websiteKey)}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as CachedBootstrap;
  const website = await websiteForWidget(await authDeps(c.env), websiteKey);
  const value: CachedBootstrap = website ? { found: true, availability: await availabilityOf(c, website.workspaceId, website.settings.availabilityMode), websiteId: website.id, settings: website.settings, allowedOrigins: website.allowedOrigins } : { found: false };
  await cache.put(key, new Response(JSON.stringify(value), { headers: { 'cache-control': `public, max-age=${BOOTSTRAP_TTL_SECONDS}` } }));
  return value;
}

export function registerWidgetRoutes(app: App) {
  app.use('/api/v1/widget/*', cors);
  for (const path of [updateVisitorProfileRoute.path, listVisitorConversationsRoute.path, '/api/v1/widget/conversations/*', '/api/v1/widget/attachments/*']) {
    app.use(path, requireVisitor as unknown as MiddlewareHandler<AppEnv>);
  }
  const visitorOf = (c: Context<AppEnv>) => (c as unknown as Context<WidgetEnv>).get('visitor');

  app.openapi(widgetBootstrapRoute, async (c) => {
    const bootstrap = await loadBootstrap(c, c.req.valid('query').websiteKey);
    if (!bootstrap.found) throw notFound();
    const origin = c.req.header('origin');
    if (origin !== undefined && !bootstrap.allowedOrigins!.includes(origin)) throw new AppError(403, 'bad_origin', 'This website does not allow requests from this origin');
    return c.json({ websiteId: bootstrap.websiteId!, settings: bootstrap.settings!, availability: bootstrap.availability ?? 'offline' }, 200);
  });

  app.openapi(createVisitorSessionRoute, async (c) => {
    const body = c.req.valid('json');
    return c.json(await createVisitorSession(await authDeps(c.env), { ...body, origin: c.req.header('origin'), ip: clientIp(c) }), 200);
  });

  app.openapi(updateVisitorProfileRoute, async (c) => {
    await updateVisitorProfile(await authDeps(c.env), visitorOf(c), c.req.valid('json'));
    return c.body(null, 204);
  });

  app.openapi(listVisitorConversationsRoute, async (c) => c.json(await listVisitorConversations(await authDeps(c.env), visitorOf(c)), 200));

  app.openapi(createVisitorConversationRoute, async (c) => {
    const { created, conversation, messageId } = await createVisitorConversation(await authDeps(c.env), visitorOf(c), c.req.valid('json'));
    dispatchSoon(c, visitorOf(c).workspaceId, [conversation.id, messageId]);
    return created ? c.json(conversation, 201) : c.json(conversation, 200);
  });

  app.openapi(listVisitorMessagesRoute, async (c) => c.json(await listVisitorMessages(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.valid('query')), 200));

  app.openapi(sendVisitorMessageRoute, async (c) => {
    const { created, message } = await sendVisitorMessage(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.valid('json'));
    dispatchSoon(c, visitorOf(c).workspaceId, [message.id, message.conversationId]);
    return created ? c.json(message, 201) : c.json(message, 200);
  });

  app.openapi(createVisitorTicketRoute, async (c) => {
    const { ticket, expiresAt } = await createVisitorTicket(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.header('origin'));
    return c.json({ ticket, expiresAt, url: socketUrl(c, ticket) }, 201);
  });

  app.openapi(uploadVisitorAttachmentRoute, async (c) => {
    const deps = await authDeps(c.env);
    return c.json(await receiveUpload(c, c.req.valid('param').conversationId, c.req.valid('query').filename, (input) => beginVisitorUpload(deps, visitorOf(c), input)), 201);
  });

  app.openapi(downloadVisitorAttachmentRoute, (async (c: Context<AppEnv>) => sendFile(c, await visitorAttachment(await authDeps(c.env), visitorOf(c), c.req.param('attachmentId')!))) as never);

  app.openapi(markVisitorConversationReadRoute, async (c) => {
    const visitor = visitorOf(c);
    const { conversationId } = c.req.valid('param');
    const position = await markVisitorConversationRead(await authDeps(c.env), visitor, conversationId, c.req.valid('json'));
    publishRead(c, { v: 1, kind: 'conversation.read', workspaceId: visitor.workspaceId, conversationId, reader: { type: 'visitor', id: visitor.visitorId }, publicReadSeq: null, ...position });
    return c.body(null, 204);
  });
}
