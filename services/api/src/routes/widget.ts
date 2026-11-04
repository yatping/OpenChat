import {
  createVisitorConversationRoute,
  createVisitorSessionRoute,
  listVisitorConversationsRoute,
  listVisitorMessagesRoute,
  markVisitorConversationReadRoute,
  sendVisitorMessageRoute,
  updateVisitorProfileRoute,
  widgetBootstrapRoute,
} from '@openchat/api-contracts';
import {
  assertVisitorOrigin,
  authenticateVisitor,
  createVisitorConversation,
  createVisitorSession,
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
import { authDeps, type App, type AppEnv } from '../context';

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
}

/** Keeps busy pages off D1. A key that does not exist is cached too, so that guessing cannot reach D1 either. */
async function loadBootstrap(c: Context<AppEnv>, websiteKey: string): Promise<CachedBootstrap> {
  const cache = caches.default;
  const key = new Request(`https://widget-bootstrap.invalid/${encodeURIComponent(websiteKey)}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as CachedBootstrap;
  const website = await websiteForWidget(await authDeps(c.env), websiteKey);
  const value: CachedBootstrap = website ? { found: true, websiteId: website.id, settings: website.settings, allowedOrigins: website.allowedOrigins } : { found: false };
  await cache.put(key, new Response(JSON.stringify(value), { headers: { 'cache-control': `public, max-age=${BOOTSTRAP_TTL_SECONDS}` } }));
  return value;
}

export function registerWidgetRoutes(app: App) {
  app.use('/api/v1/widget/*', cors);
  for (const path of [updateVisitorProfileRoute.path, listVisitorConversationsRoute.path, '/api/v1/widget/conversations/*']) {
    app.use(path, requireVisitor as unknown as MiddlewareHandler<AppEnv>);
  }
  const visitorOf = (c: Context<AppEnv>) => (c as unknown as Context<WidgetEnv>).get('visitor');

  app.openapi(widgetBootstrapRoute, async (c) => {
    const bootstrap = await loadBootstrap(c, c.req.valid('query').websiteKey);
    if (!bootstrap.found) throw notFound();
    const origin = c.req.header('origin');
    if (origin !== undefined && !bootstrap.allowedOrigins!.includes(origin)) throw new AppError(403, 'bad_origin', 'This website does not allow requests from this origin');
    // In auto mode this will come from the workspace hub once sockets exist. Until then, nobody is shown as online.
    const availability = bootstrap.settings?.availabilityMode === 'online' ? ('online' as const) : ('offline' as const);
    return c.json({ websiteId: bootstrap.websiteId!, settings: bootstrap.settings!, availability }, 200);
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
    const { created, conversation } = await createVisitorConversation(await authDeps(c.env), visitorOf(c), c.req.valid('json'));
    return created ? c.json(conversation, 201) : c.json(conversation, 200);
  });

  app.openapi(listVisitorMessagesRoute, async (c) => c.json(await listVisitorMessages(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.valid('query')), 200));

  app.openapi(sendVisitorMessageRoute, async (c) => {
    const { created, message } = await sendVisitorMessage(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.valid('json'));
    return created ? c.json(message, 201) : c.json(message, 200);
  });

  app.openapi(markVisitorConversationReadRoute, async (c) => {
    await markVisitorConversationRead(await authDeps(c.env), visitorOf(c), c.req.valid('param').conversationId, c.req.valid('json'));
    return c.body(null, 204);
  });
}
