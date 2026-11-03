import { createRoute, z } from '@hono/zod-openapi';
import { problemResponse } from './common';

export const HealthSchema = z.object({ status: z.literal('ok') }).openapi('Health');

export const getHealthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['discovery'],
  security: [], // Deliberately public.
  operationId: 'getHealth',
  summary: 'Liveness only. Exposes no configuration.',
  responses: {
    200: { description: 'Healthy', content: { 'application/json': { schema: HealthSchema } } },
    default: problemResponse,
  },
});

export const DiscoverySchema = z
  .object({
    installationId: z.string(),
    name: z.string(),
    api: z.object({ versions: z.array(z.string()), minor: z.number().int() }),
    realtime: z.object({ protocolVersions: z.array(z.number().int()) }),
    relay: z
      .object({
        id: z.string(),
        url: z.string(),
        bundleIds: z.array(z.string()),
        publicKeys: z.array(z.object({ id: z.string(), alg: z.literal('Ed25519'), key: z.string() })),
      })
      .nullable()
      .openapi({ description: 'Compared by the app with its build-time allowlist, and read by the relay to prove domain control.' }),
    auth: z.object({ signup: z.enum(['invite_only', 'open']) }),
  })
  .openapi('Discovery');

export const getDiscoveryRoute = createRoute({
  method: 'get',
  path: '/.well-known/openchat.json',
  tags: ['discovery'],
  security: [], // Deliberately public.
  operationId: 'getDiscovery',
  summary: 'Describe this installation and its compatibility',
  responses: {
    200: { description: 'Discovery document', content: { 'application/json': { schema: DiscoverySchema } } },
    default: problemResponse,
  },
});

export const API_MINOR_VERSION = 0;

// ---------- Authentication ----------

const Email = z.string().trim().max(320).pipe(z.email());
const bearer = [{ bearerAuth: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ content: { 'application/json': { schema } } });

export const TokenPairSchema = z
  .object({
    accessToken: z.string(),
    accessTokenExpiresAt: z.string(),
    refreshToken: z.string().optional().openapi({ description: 'Mobile only. Dashboard clients receive an HttpOnly cookie instead.' }),
  })
  .openapi('TokenPair');

export const RoleSchema = z.enum(['owner', 'admin', 'supervisor', 'agent']).openapi('Role');

export const WorkspaceSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), createdAt: z.string() }).openapi('Workspace');

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    memberships: z.array(z.object({ memberId: z.string(), role: RoleSchema, workspace: WorkspaceSchema })),
  })
  .openapi('Me');

export const loginRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/login',
  tags: ['auth'],
  operationId: 'login',
  summary: 'Sign in with email and password',
  security: [],
  request: {
    body: {
      required: true,
      ...json(
        z.strictObject({
          email: Email,
          password: z.string().min(1).max(1024),
          clientType: z.enum(['dashboard', 'mobile']),
          clientLabel: z.string().max(100).optional(),
        }),
      ),
    },
  },
  responses: { 200: { description: 'Session created', ...json(TokenPairSchema) }, default: problemResponse },
});

export const refreshRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/refresh',
  tags: ['auth'],
  operationId: 'refreshSession',
  summary: 'Rotate a refresh token. Reuse of an old token revokes the session.',
  security: [],
  request: {
    body: { required: false, ...json(z.strictObject({ refreshToken: z.string().max(256).optional() })) },
  },
  responses: { 200: { description: 'New tokens', ...json(TokenPairSchema) }, default: problemResponse },
});

export const logoutRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/logout',
  tags: ['auth'],
  operationId: 'logout',
  summary: 'Revoke the current session',
  security: bearer,
  responses: { 204: { description: 'Revoked' }, default: problemResponse },
});

export const requestPasswordResetRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/password-reset/request',
  tags: ['auth'],
  operationId: 'requestPasswordReset',
  summary: 'Always returns 202, whether or not the account exists',
  security: [],
  request: { body: { required: true, ...json(z.strictObject({ email: Email })) } },
  responses: { 202: { description: 'Accepted' }, default: problemResponse },
});

export const confirmPasswordResetRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/password-reset/confirm',
  tags: ['auth'],
  operationId: 'confirmPasswordReset',
  summary: 'Set a new password. Revokes all sessions for the user.',
  security: [],
  request: { body: { required: true, ...json(z.strictObject({ token: z.string().max(256), password: z.string().min(10).max(1024) })) } },
  responses: { 204: { description: 'Password changed' }, default: problemResponse },
});

export const confirmEmailVerificationRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/email-verification/confirm',
  tags: ['auth'],
  operationId: 'confirmEmailVerification',
  summary: 'Confirm an email address',
  security: [],
  request: { body: { required: true, ...json(z.strictObject({ token: z.string().max(256) })) } },
  responses: { 204: { description: 'Verified' }, default: problemResponse },
});

export const getMeRoute = createRoute({
  method: 'get',
  path: '/api/v1/me',
  tags: ['auth'],
  operationId: 'getMe',
  summary: 'The current user and their workspace memberships',
  security: bearer,
  responses: { 200: { description: 'Current user', ...json(MeSchema) }, default: problemResponse },
});
