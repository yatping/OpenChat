import { createRoute, z } from '@hono/zod-openapi';
import { page, PaginationQuery, problemResponse } from './common';

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

export const SafeName = z.string().trim().min(1).max(100).regex(/^\P{Cc}*$/u, 'Must not contain control characters');
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

export const deleteMeRoute = createRoute({
  method: 'post',
  path: '/api/v1/me/delete',
  tags: ['auth'],
  operationId: 'deleteMe',
  summary: 'Anonymise the account and leave all workspaces. Needs the password. Refused for the last owner of a workspace.',
  description: 'A POST, because the password travels in the body and a DELETE body has no defined meaning. A wrong password answers 403, not 401, since the access token is valid and a client must not refresh and retry. Attempts share the login limit for the account.',
  security: bearer,
  request: { body: { required: true, ...json(z.strictObject({ password: z.string().min(1).max(1024) })) } },
  responses: { 204: { description: 'Deleted' }, default: problemResponse },
});

// ---------- Workspaces ----------

const workspaceParams = z.object({ workspaceId: z.string() });
const memberParams = workspaceParams.extend({ memberId: z.string() });
const websiteParams = workspaceParams.extend({ websiteId: z.string() });

export const MemberStatusSchema = z.enum(['active', 'suspended']);
export const MemberSchema = z
  .object({ id: z.string(), name: z.string(), email: z.string(), role: RoleSchema, status: MemberStatusSchema })
  .openapi('Member');

export const createWorkspaceRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces',
  tags: ['workspaces'],
  operationId: 'createWorkspace',
  summary: 'Create a workspace, subject to the installation signup policy',
  security: bearer,
  request: { body: { required: true, ...json(z.strictObject({ name: SafeName })) } },
  responses: { 201: { description: 'Created', ...json(WorkspaceSchema) }, default: problemResponse },
});

export const getWorkspaceRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}',
  tags: ['workspaces'],
  operationId: 'getWorkspace',
  summary: 'Get a workspace',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Workspace', ...json(WorkspaceSchema) }, default: problemResponse },
});

export const updateWorkspaceRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}',
  tags: ['workspaces'],
  operationId: 'updateWorkspace',
  summary: 'Update workspace settings',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName.optional() })) } },
  responses: { 200: { description: 'Updated', ...json(WorkspaceSchema) }, default: problemResponse },
});

export const listMembersRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/members',
  tags: ['workspaces'],
  operationId: 'listMembers',
  summary: 'List members',
  security: bearer,
  request: { params: workspaceParams, query: PaginationQuery },
  responses: { 200: { description: 'Members', ...json(page(MemberSchema)) }, default: problemResponse },
});

export const updateMemberRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}/members/{memberId}',
  tags: ['workspaces'],
  operationId: 'updateMember',
  summary: 'Change a role or status. A workspace must keep one active owner.',
  security: bearer,
  request: {
    params: memberParams,
    body: {
      required: true,
      ...json(
        z
          .strictObject({ role: RoleSchema.optional(), status: MemberStatusSchema.optional() })
          .refine((v) => v.role !== undefined || v.status !== undefined, 'Change a role or a status'),
      ),
    },
  },
  responses: { 200: { description: 'Updated', ...json(MemberSchema) }, default: problemResponse },
});

export const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/api/v1/workspaces/{workspaceId}/members/{memberId}',
  tags: ['workspaces'],
  operationId: 'removeMember',
  summary: 'Remove a member and their push subscriptions',
  security: bearer,
  request: { params: memberParams },
  responses: { 204: { description: 'Removed' }, default: problemResponse },
});

export const InvitationSchema = z
  .object({ id: z.string(), email: z.string(), role: z.enum(['admin', 'supervisor', 'agent']), expiresAt: z.string() })
  .openapi('Invitation');

export const createInvitationRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/invitations',
  tags: ['workspaces'],
  operationId: 'createInvitation',
  summary: 'Invite someone by email. Replaces any pending invitation for the address.',
  security: bearer,
  request: {
    params: workspaceParams,
    body: { required: true, ...json(z.strictObject({ email: Email, role: z.enum(['admin', 'supervisor', 'agent']) })) },
  },
  responses: { 201: { description: 'Invitation queued', ...json(InvitationSchema) }, default: problemResponse },
});

export const acceptInvitationRoute = createRoute({
  method: 'post',
  path: '/api/v1/invitations/accept',
  tags: ['workspaces'],
  operationId: 'acceptInvitation',
  summary: 'Accept an invitation. A new account needs a name and password; an existing account keeps its own.',
  security: [],
  request: {
    body: {
      required: true,
      ...json(z.strictObject({ token: z.string().max(256), name: SafeName.optional(), password: z.string().min(10).max(1024).optional() })),
    },
  },
  responses: { 200: { description: 'Accepted', ...json(z.object({ workspaceId: z.string() })) }, default: problemResponse },
});

// ---------- Websites ----------

/** An exact origin. No wildcards, paths, or plain HTTP, except on the local machine. */
const isOrigin = (value: string) => {
  if (!URL.canParse(value) || value.includes('*')) return false;
  const url = new URL(value);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && local));
};
const Origin = z.string().max(300).refine(isOrigin, 'Must be an exact origin, such as https://example.com');

export const WidgetSettingsSchema = z
  .strictObject({
    welcomeMessage: z.string().max(500).optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    availabilityMode: z.enum(['auto', 'online', 'offline']).optional(),
    collectEmail: z.enum(['never', 'optional', 'required']).optional(),
    requireTurnstile: z.boolean().optional(),
    showAgentNames: z.boolean().optional(),
  })
  .openapi('WidgetSettings');

const websiteFields = { allowedOrigins: z.array(Origin).max(50), settings: WidgetSettingsSchema.optional() };

export const WebsiteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    websiteKey: z.string().openapi({ description: 'Public identifier embedded in page source. Not a credential.' }),
    allowedOrigins: z.array(z.string()),
    settings: WidgetSettingsSchema,
  })
  .openapi('Website');

export const listWebsitesRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/websites',
  tags: ['websites'],
  operationId: 'listWebsites',
  summary: 'List websites',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Websites', ...json(z.object({ data: z.array(WebsiteSchema) })) }, default: problemResponse },
});

export const createWebsiteRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/websites',
  tags: ['websites'],
  operationId: 'createWebsite',
  summary: 'Register a website and obtain its public key',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName, ...websiteFields })) } },
  responses: { 201: { description: 'Created', ...json(WebsiteSchema) }, default: problemResponse },
});

export const updateWebsiteRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}/websites/{websiteId}',
  tags: ['websites'],
  operationId: 'updateWebsite',
  summary: 'Update a website',
  security: bearer,
  request: {
    params: websiteParams,
    body: { required: true, ...json(z.strictObject({ name: SafeName.optional(), allowedOrigins: websiteFields.allowedOrigins.optional(), settings: websiteFields.settings })) },
  },
  responses: { 200: { description: 'Updated', ...json(WebsiteSchema) }, default: problemResponse },
});
