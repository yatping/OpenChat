import {
  confirmEmailVerificationRoute,
  confirmPasswordResetRoute,
  deleteMeRoute,
  getMeRoute,
  loginRoute,
  logoutRoute,
  refreshRoute,
  requestPasswordResetRoute,
} from '@openchat/api-contracts';
import { authenticate, completeEmailVerification, completePasswordReset, deleteMe, getMe, login, logout, refresh, requestPasswordReset, type IssuedTokens } from '@openchat/core';
import { AppError } from '@openchat/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { authDeps, type App, type AppEnv } from '../context';

const REFRESH_COOKIE = 'oc_refresh';
const COOKIE_PATH = '/api/v1/auth';
const DASHBOARD_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const clientIp = (c: Context<AppEnv>) => c.req.header('cf-connecting-ip') ?? 'unknown';

/** The dashboard keeps its refresh token in a cookie that scripts cannot read. Mobile holds it directly. */
function tokenResponse(c: Context<AppEnv>, tokens: IssuedTokens) {
  const { accessToken, accessTokenExpiresAt, refreshToken, clientType } = tokens;
  if (clientType === 'mobile') return { accessToken, accessTokenExpiresAt, refreshToken };
  setCookie(c, REFRESH_COOKIE, refreshToken, { httpOnly: true, secure: true, sameSite: 'Strict', path: COOKIE_PATH, maxAge: DASHBOARD_COOKIE_MAX_AGE });
  return { accessToken, accessTokenExpiresAt };
}

/** Sets `principal`. Everything behind this has a live session and an enabled user. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) throw new AppError(401, 'unauthorized', 'Sign in again');
  c.set('principal', await authenticate(await authDeps(c.env), token));
  await next();
};

/** The cookie is sent automatically, so a cookie-based refresh must also prove it came from our own pages. */
function assertSameOrigin(c: Context<AppEnv>) {
  const origin = c.req.header('origin');
  if (!origin || origin !== new URL(c.req.url).origin) throw new AppError(403, 'bad_origin', 'Request origin is not allowed');
}

export function registerAuthRoutes(app: App) {
  app.openapi(loginRoute, async (c) => {
    const body = c.req.valid('json');
    const tokens = await login(await authDeps(c.env), {
      email: body.email,
      password: body.password,
      clientType: body.clientType,
      clientLabel: body.clientLabel ?? null,
      ip: clientIp(c),
    });
    return c.json(tokenResponse(c, tokens), 200);
  });

  app.openapi(refreshRoute, async (c) => {
    const bodyToken = c.req.valid('json')?.refreshToken;
    const cookieToken = getCookie(c, REFRESH_COOKIE);
    const presented = bodyToken ?? cookieToken;
    if (!presented) throw new AppError(401, 'unauthorized', 'Sign in again');
    if (!bodyToken) assertSameOrigin(c);
    try {
      return c.json(tokenResponse(c, await refresh(await authDeps(c.env), presented)), 200);
    } catch (error) {
      // Only when the cookie was what failed. A bad body token says nothing about the cookie.
      if (!bodyToken) deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH, secure: true });
      throw error;
    }
  });

  app.use(logoutRoute.path, requireAuth);
  app.openapi(logoutRoute, async (c) => {
    await logout(await authDeps(c.env), c.get('principal').sessionId);
    deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH, secure: true });
    return c.body(null, 204);
  });

  app.openapi(requestPasswordResetRoute, async (c) => {
    const { email } = c.req.valid('json');
    const deps = await authDeps(c.env);
    // Answered before any account lookup, so that timing does not reveal whether the account exists.
    c.executionCtx.waitUntil(
      requestPasswordReset(deps, { email, ip: clientIp(c) }).catch((error: unknown) => {
        c.get('log').error('password_reset_request_failed', { errorName: (error as Error).name });
      }),
    );
    return c.body(null, 202);
  });

  app.openapi(confirmPasswordResetRoute, async (c) => {
    const { token, password } = c.req.valid('json');
    await completePasswordReset(await authDeps(c.env), { token, password, ip: clientIp(c) });
    return c.body(null, 204);
  });

  app.openapi(confirmEmailVerificationRoute, async (c) => {
    const { token } = c.req.valid('json');
    await completeEmailVerification(await authDeps(c.env), { token, ip: clientIp(c) });
    return c.body(null, 204);
  });

  app.use(getMeRoute.path, requireAuth);
  app.openapi(getMeRoute, async (c) => c.json(await getMe(await authDeps(c.env), c.get('principal')), 200));
  app.use(deleteMeRoute.path, requireAuth);
  app.openapi(deleteMeRoute, async (c) => {
    const { password } = c.req.valid('json');
    await deleteMe(await authDeps(c.env), c.get('principal'), { password, ip: clientIp(c) });
    deleteCookie(c, REFRESH_COOKIE, { path: COOKIE_PATH, secure: true });
    return c.body(null, 204);
  });
}
