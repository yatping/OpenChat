import { createRoute, z } from '@hono/zod-openapi';
import { page, PaginationQuery, problemResponse } from './common';
import { ConversationPrioritySchema, ConversationStatusSchema, VisitorWireMessageSchema } from './realtime';

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

// ---------- Conversations and messages, for agents ----------

const conversationParams = workspaceParams.extend({ conversationId: z.string() });


export const ConversationSchema = z
  .object({
    id: z.string(),
    websiteId: z.string(),
    contactId: z.string(),
    assignedMemberId: z.string().nullable(),
    status: ConversationStatusSchema,
    priority: ConversationPrioritySchema,
    subject: z.string().nullable(),
    version: z.number().int(),
    lastMessageSeq: z.number().int(),
    lastMessageAt: z.string().nullable(),
    lastReadSeq: z.number().int().openapi({ description: "The caller's read position, for unread counts." }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Conversation');

export const AttachmentSchema = z
  .object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), status: z.enum(['pending', 'ready', 'rejected']), url: z.string() })
  .openapi('Attachment');

export const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    seq: z.number().int(),
    publicSeq: z.number().int().nullable().openapi({ description: 'Null for internal notes.' }),
    clientMessageId: z.string().nullable(),
    sender: z.object({ type: z.enum(['visitor', 'member', 'system']), id: z.string().nullable(), displayName: z.string().nullable() }),
    type: z.enum(['text', 'image', 'file', 'system', 'internal_note']),
    visibility: z.enum(['public', 'internal']),
    content: z.string(),
    attachments: z.array(AttachmentSchema),
    createdAt: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi('Message');

const SeqQuery = z.coerce.number().int().min(0);

export const listConversationsRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/conversations',
  tags: ['conversations'],
  operationId: 'listConversations',
  summary: 'An inbox view, most recent first',
  security: bearer,
  request: {
    params: workspaceParams,
    query: PaginationQuery.extend({
      status: ConversationStatusSchema.default('open'),
      assignee: z.string().max(64).optional().openapi({ description: 'A member ID, `me`, or `none`.' }),
      updatedAfter: z.string().max(512).optional().openapi({ description: 'A `syncCursor` from an earlier response. Returns everything changed since, in any status, oldest change first. Other filters are ignored.' }),
    }),
  },
  responses: { 200: { description: 'Conversations', ...json(page(ConversationSchema).extend({ syncCursor: z.string().openapi({ description: 'Pass as `updatedAfter` to catch up later.' }) })) }, default: problemResponse },
});

export const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}',
  tags: ['conversations'],
  operationId: 'getConversation',
  summary: 'Get a conversation',
  security: bearer,
  request: { params: conversationParams },
  responses: { 200: { description: 'Conversation', ...json(ConversationSchema) }, default: problemResponse },
});

export const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}',
  tags: ['conversations'],
  operationId: 'updateConversation',
  summary: 'Assign, transfer, resolve, reopen, archive, or reprioritise',
  description: 'Compare-and-set on `expectedVersion`. A stale version answers 409 with the current version.',
  security: bearer,
  request: {
    params: conversationParams,
    body: {
      required: true,
      ...json(
        z
          .strictObject({
            expectedVersion: z.number().int().min(1),
            assignedMemberId: z.string().max(64).nullable().optional(),
            status: ConversationStatusSchema.optional(),
            priority: ConversationPrioritySchema.optional(),
          })
          .refine((b) => b.assignedMemberId !== undefined || b.status !== undefined || b.priority !== undefined, 'Nothing to change'),
      ),
    },
  },
  responses: { 200: { description: 'Updated', ...json(ConversationSchema) }, default: problemResponse },
});

export const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/messages',
  tags: ['conversations'],
  operationId: 'listMessages',
  summary: 'Messages, including internal notes, oldest first',
  security: bearer,
  request: {
    params: conversationParams,
    query: z.object({
      afterSeq: SeqQuery.optional().openapi({ description: 'Forward from this sequence number, for catch-up.' }),
      beforeSeq: SeqQuery.optional().openapi({ description: 'Backward from this sequence number, for history.' }),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  },
  responses: { 200: { description: 'Messages', ...json(z.object({ data: z.array(MessageSchema) })) }, default: problemResponse },
});

export const sendMessageRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/messages',
  tags: ['conversations'],
  operationId: 'sendMessage',
  summary: 'Send a reply or an internal note',
  security: bearer,
  request: {
    params: conversationParams,
    body: {
      required: true,
      ...json(
        z.strictObject({
          clientMessageId: z.string().min(8).max(64),
          type: z.enum(['text', 'internal_note']),
          content: z.string().trim().min(1).max(16000),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'Committed', ...json(MessageSchema) },
    200: { description: 'A replay of an existing clientMessageId. Returns the original.', ...json(MessageSchema) },
    default: problemResponse,
  },
});

export const markConversationReadRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/read',
  tags: ['conversations'],
  operationId: 'markConversationRead',
  summary: "Move the caller's delivered and read positions forward",
  security: bearer,
  request: {
    params: conversationParams,
    body: { required: true, ...json(z.strictObject({ deliveredSeq: z.number().int().min(0), readSeq: z.number().int().min(0) })) },
  },
  responses: { 204: { description: 'Recorded' }, default: problemResponse },
});

// ---------- The widget, for visitors ----------

const visitor = [{ visitorAuth: [] }];
const ClientMessageId = z.string().min(8).max(64);
const VisitorContent = z.string().trim().min(1).max(16000);
const visitorConversationParams = z.object({ conversationId: z.string() });

export const WidgetBootstrapSchema = z
  .object({ websiteId: z.string(), settings: WidgetSettingsSchema, availability: z.enum(['online', 'offline']) })
  .openapi('WidgetBootstrap');

export const VisitorSessionSchema = z
  .object({ visitorId: z.string(), accessToken: z.string(), accessTokenExpiresAt: z.string(), refreshToken: z.string() })
  .openapi('VisitorSession');

export const VisitorConversationSchema = z
  .object({ id: z.string(), status: ConversationStatusSchema, lastSeq: z.number().int().openapi({ description: 'The latest public sequence number.' }), createdAt: z.string() })
  .openapi('VisitorConversation', { description: 'A deliberately reduced view, with no assignee, priority, or internal counters.' });

export const widgetBootstrapRoute = createRoute({
  method: 'get',
  path: '/api/v1/widget/bootstrap',
  tags: ['widget'],
  operationId: 'widgetBootstrap',
  summary: 'Public configuration. Cached for 30 seconds. The Origin must be allowed for the website.',
  security: [],
  request: { query: z.object({ websiteKey: z.string().max(128) }) },
  responses: { 200: { description: 'Widget configuration', ...json(WidgetBootstrapSchema) }, default: problemResponse },
});

export const createVisitorSessionRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/sessions',
  tags: ['widget'],
  operationId: 'createVisitorSession',
  summary: 'Create or resume an anonymous visitor session. The Origin must be allowed for the website.',
  description: 'A refresh token that is unknown or belongs to another website starts a new visitor, with no history.',
  security: [],
  request: { body: { required: true, ...json(z.strictObject({ websiteKey: z.string().max(128), refreshToken: z.string().max(256).optional() })) } },
  responses: { 200: { description: 'Visitor session', ...json(VisitorSessionSchema) }, default: problemResponse },
});

export const updateVisitorProfileRoute = createRoute({
  method: 'patch',
  path: '/api/v1/widget/me',
  tags: ['widget'],
  operationId: 'updateVisitorProfile',
  summary: 'Provide a name, email, and follow-up consent',
  description: 'An email is unverified, and never merges with an existing contact automatically.',
  security: visitor,
  request: {
    body: {
      required: true,
      ...json(
        z
          .strictObject({ name: SafeName.optional(), email: z.email().max(254).optional(), followUpConsent: z.boolean().optional() })
          .refine((b) => b.name !== undefined || b.email !== undefined || b.followUpConsent !== undefined, 'Nothing to change'),
      ),
    },
  },
  responses: { 204: { description: 'Updated' }, default: problemResponse },
});

export const listVisitorConversationsRoute = createRoute({
  method: 'get',
  path: '/api/v1/widget/conversations',
  tags: ['widget'],
  operationId: 'listVisitorConversations',
  summary: "The visitor's own conversations",
  security: visitor,
  responses: { 200: { description: 'Conversations', ...json(z.object({ data: z.array(VisitorConversationSchema) })) }, default: problemResponse },
});

export const createVisitorConversationRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/conversations',
  tags: ['widget'],
  operationId: 'createVisitorConversation',
  summary: 'Start a conversation with a first message',
  security: visitor,
  request: { body: { required: true, ...json(z.strictObject({ clientMessageId: ClientMessageId, content: VisitorContent })) } },
  responses: {
    201: { description: 'Created', ...json(VisitorConversationSchema) },
    200: { description: 'A replay of an existing clientMessageId. Returns the same conversation.', ...json(VisitorConversationSchema) },
    default: problemResponse,
  },
});

export const listVisitorMessagesRoute = createRoute({
  method: 'get',
  path: '/api/v1/widget/conversations/{conversationId}/messages',
  tags: ['widget'],
  operationId: 'listVisitorMessages',
  summary: 'Public messages only, oldest first. Here seq is the public sequence.',
  security: visitor,
  request: {
    params: visitorConversationParams,
    query: z.object({ afterSeq: SeqQuery.optional(), beforeSeq: SeqQuery.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  },
  responses: { 200: { description: 'Messages', ...json(z.object({ data: z.array(VisitorWireMessageSchema) })) }, default: problemResponse },
});

export const sendVisitorMessageRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/conversations/{conversationId}/messages',
  tags: ['widget'],
  operationId: 'sendVisitorMessage',
  summary: 'Send a message. Rate limited per visitor and per website.',
  security: visitor,
  request: { params: visitorConversationParams, body: { required: true, ...json(z.strictObject({ clientMessageId: ClientMessageId, content: VisitorContent })) } },
  responses: {
    201: { description: 'Committed', ...json(VisitorWireMessageSchema) },
    200: { description: 'A replay of an existing clientMessageId', ...json(VisitorWireMessageSchema) },
    default: problemResponse,
  },
});

export const markVisitorConversationReadRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/conversations/{conversationId}/read',
  tags: ['widget'],
  operationId: 'markVisitorConversationRead',
  summary: "Move the visitor's delivered and read positions forward, in public sequence numbers",
  security: visitor,
  request: { params: visitorConversationParams, body: { required: true, ...json(z.strictObject({ deliveredSeq: z.number().int().min(0), readSeq: z.number().int().min(0) })) } },
  responses: { 204: { description: 'Recorded' }, default: problemResponse },
});

// ---------- Realtime ----------

export const RealtimeTicketSchema = z
  .object({ ticket: z.string(), url: z.string(), expiresAt: z.string() })
  .openapi('RealtimeTicket', { description: 'Connect to `url` within 30 seconds. The ticket is good for one purpose only, and grants nothing over REST.' });

export const createAgentTicketRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/realtime/tickets',
  tags: ['realtime'],
  operationId: 'createAgentTicket',
  summary: 'A ticket for a socket that receives everything in this workspace',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 201: { description: 'Ticket', ...json(RealtimeTicketSchema) }, default: problemResponse },
});

export const createVisitorTicketRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/conversations/{conversationId}/realtime/tickets',
  tags: ['widget'],
  operationId: 'createVisitorTicket',
  summary: "A ticket for a socket that receives this conversation's public events",
  security: visitor,
  request: { params: visitorConversationParams },
  responses: { 201: { description: 'Ticket', ...json(RealtimeTicketSchema) }, default: problemResponse },
});

export const connectRealtimeRoute = createRoute({
  method: 'get',
  path: '/api/v1/realtime/connect',
  tags: ['realtime'],
  operationId: 'connectRealtime',
  summary: 'Upgrade to a WebSocket',
  description: 'Frames are published as AgentServerFrame, AgentClientFrame, VisitorServerFrame, and VisitorClientFrame.',
  security: [],
  request: { query: z.object({ ticket: z.string().max(4096) }) },
  responses: { 101: { description: 'Switching protocols' }, default: problemResponse },
});
