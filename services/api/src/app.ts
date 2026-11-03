import { OpenAPIHono } from '@hono/zod-openapi';
import { getDiscoveryRoute, getHealthRoute, API_MINOR_VERSION, REALTIME_PROTOCOL_VERSION } from '@openchat/api-contracts';
import openapi from '@openchat/api-contracts/openapi.json';
import { getInstallation, openDatabase } from '@openchat/database';
import { AppError, createLogger, newId, toProblem } from '@openchat/shared';
import type { AppEnv } from './context';
import { registerAuthRoutes } from './routes/auth';
import { registerWorkspaceRoutes } from './routes/workspaces';

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    // A contract violation in a request is a client error with a stable shape.
    defaultHook: (result) => {
      if (!result.success) {
        throw new AppError(400, 'validation_failed', 'The request is invalid', {
          fields: result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
        });
      }
      return undefined;
    },
  });

  app.use('*', async (c, next) => {
    const supplied = c.req.header('x-request-id');
    // A client-supplied ID ends up in logs, so it is constrained rather than trusted.
    const requestId = supplied && /^[A-Za-z0-9_-]{1,64}$/.test(supplied) ? supplied : newId('request');
    const log = createLogger({ requestId, method: c.req.method, route: new URL(c.req.url).pathname });
    c.set('requestId', requestId);
    c.set('log', log);
    await next();
    c.header('x-request-id', requestId);
    log.info('request', { status: c.res.status });
  });

  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const problem = toProblem(error, requestId);
    // An AppError is a decision the code made. Only surprises are logged as errors.
    if (!(error instanceof AppError)) {
      createLogger({ requestId }).error('unhandled_error', { errorName: error.name, status: problem.status });
    }
    const retryAfter = error instanceof AppError ? error.details?.retryAfterSeconds : undefined;
    return c.newResponse(JSON.stringify(problem), problem.status as 500, {
      'content-type': 'application/problem+json',
      'x-request-id': requestId,
      ...(typeof retryAfter === 'number' ? { 'retry-after': String(retryAfter) } : {}),
    });
  });

  app.notFound((c) => {
    const problem = toProblem(new AppError(404, 'not_found', 'Not found'), c.get('requestId') ?? 'unknown');
    return c.newResponse(JSON.stringify(problem), 404, { 'content-type': 'application/problem+json' });
  });

  app.openapi(getHealthRoute, (c) => c.json({ status: 'ok' as const }, 200));

  app.openapi(getDiscoveryRoute, async (c) => {
    const installation = await getInstallation(openDatabase(c.env.DB));
    if (!installation) throw new AppError(503, 'not_initialized', 'This installation has not been initialised');
    return c.json(
      {
        installationId: installation.id,
        name: installation.name,
        api: { versions: ['v1'], minor: API_MINOR_VERSION },
        realtime: { protocolVersions: [REALTIME_PROTOCOL_VERSION] },
        relay: null,
        auth: { signup: installation.signupPolicy },
      },
      200,
    );
  });

  // Set after the handler, so that it also covers error responses. These can carry tokens or personal data.
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('x-content-type-options', 'nosniff');
  });

  registerAuthRoutes(app);
  registerWorkspaceRoutes(app);

  app.get('/api/v1/openapi.json', (c) => c.json(openapi));

  return app;
}
