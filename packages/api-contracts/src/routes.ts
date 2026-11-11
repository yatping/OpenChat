import { createRoute, z } from '@hono/zod-openapi';
import { NOTIFICATION_EVENTS } from '@openchat/notification-protocol';
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

export const RoleSchema = z.enum(['supervisor', 'agent']).openapi('Role');

export const WorkspaceSchema = z.object({ id: z.string(), name: z.string(), slug: z.string(), createdAt: z.string() }).openapi('Workspace');

export const MeSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    isInstallationAdmin: z.boolean(),
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

// ---------- Workspaces ----------

const workspaceParams = z.object({ workspaceId: z.string() });
const websiteParams = workspaceParams.extend({ websiteId: z.string() });

export const MemberStatusSchema = z.enum(['active', 'suspended', 'removed']);
export const MemberSchema = z
  .object({ id: z.string(), name: z.string(), email: z.string(), role: RoleSchema, status: MemberStatusSchema })
  .openapi('Member');

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

export const listMembersRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/members',
  tags: ['workspaces'],
  operationId: 'listMembers',
  summary: 'List members. People are changed by an installation admin, under /api/v1/admin.',
  security: bearer,
  request: { params: workspaceParams, query: PaginationQuery },
  responses: { 200: { description: 'Members', ...json(page(MemberSchema)) }, default: problemResponse },
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
  summary: 'List websites. They are changed by an installation admin, under /api/v1/admin.',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Websites', ...json(z.object({ data: z.array(WebsiteSchema) })) }, default: problemResponse },
});

// ---------- Push ----------

export const PushSubscriptionSchema = z
  .object({ id: z.string(), relaySubscriptionId: z.string(), platform: z.enum(['ios']), deviceLabel: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })
  .openapi('PushSubscription');

/** Only `push`. Members are not emailed about conversations (amendment A15). Adding a value is an additive change. */
export const NotificationPreferencesSchema = z
  .object({ preferences: z.array(z.object({ eventType: z.enum(NOTIFICATION_EVENTS), channel: z.enum(['push']), enabled: z.boolean() })).max(NOTIFICATION_EVENTS.length) })
  .openapi('NotificationPreferences');

export const createPushGrantRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/push/grants',
  tags: ['push'],
  operationId: 'createPushGrant',
  summary: 'Issue a short-lived, single-use grant for the device to present to the relay',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 201: { description: 'Grant', ...json(z.object({ grant: z.string(), relayUrl: z.string(), expiresAt: z.iso.datetime() })) }, default: problemResponse },
});

export const listPushSubscriptionsRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/push/subscriptions',
  tags: ['push'],
  operationId: 'listMyPushSubscriptions',
  summary: "The caller's registered devices",
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Subscriptions', ...json(z.object({ data: z.array(PushSubscriptionSchema) })) }, default: problemResponse },
});

export const recordPushSubscriptionRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/push/subscriptions',
  tags: ['push'],
  operationId: 'recordPushSubscription',
  summary: 'Store the opaque handle returned by the relay, and the public key this phone made for it. No device token is sent here.',
  security: bearer,
  request: {
    params: workspaceParams,
    body: {
      required: true,
      ...json(
        z.object({
          relaySubscriptionId: z.string().regex(/^sub_[A-Za-z0-9_-]{1,64}$/),
          // X25519, 32 bytes, base64url. Each notification is encrypted to it, so the relay cannot read it (ADR-0017).
          previewKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          deviceLabel: z.string().max(100).optional(),
        }),
      ),
    },
  },
  responses: { 201: { description: 'Recorded', ...json(PushSubscriptionSchema) }, default: problemResponse },
});

export const removePushSubscriptionRoute = createRoute({
  method: 'delete',
  path: '/api/v1/workspaces/{workspaceId}/push/subscriptions/{subscriptionId}',
  tags: ['push'],
  operationId: 'removePushSubscription',
  summary: 'Remove a device, and unregister it at the relay',
  security: bearer,
  request: { params: workspaceParams.extend({ subscriptionId: z.string() }) },
  responses: { 204: { description: 'Removed' }, default: problemResponse },
});

export const getNotificationPreferencesRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/notification-preferences',
  tags: ['push'],
  operationId: 'getNotificationPreferences',
  summary: "The caller's preferences. An event with no choice made is on.",
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Preferences', ...json(NotificationPreferencesSchema) }, default: problemResponse },
});

export const setNotificationPreferencesRoute = createRoute({
  method: 'put',
  path: '/api/v1/workspaces/{workspaceId}/notification-preferences',
  tags: ['push'],
  operationId: 'setNotificationPreferences',
  summary: "Replace the caller's preferences",
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(NotificationPreferencesSchema) } },
  responses: { 204: { description: 'Updated' }, default: problemResponse },
});

// ---------- Email consent ----------

const UnsubscribeQuery = z.object({ token: z.string().max(200).optional() });
const unsubscribePage = { content: { 'text/html': { schema: z.string() } } };

export const showUnsubscribeRoute = createRoute({
  method: 'get',
  path: '/api/v1/unsubscribe',
  tags: ['email'],
  security: [],
  operationId: 'showUnsubscribe',
  summary: 'A page that asks to confirm',
  description: 'Changes nothing, because mail scanners open links on their own. No sign-in. The token in the link is the only authority.',
  request: { query: UnsubscribeQuery },
  responses: { 200: { description: 'Page', ...unsubscribePage }, 404: { description: 'No such link', ...unsubscribePage }, default: problemResponse },
});

export const confirmUnsubscribeRoute = createRoute({
  method: 'post',
  path: '/api/v1/unsubscribe',
  tags: ['email'],
  security: [],
  operationId: 'confirmUnsubscribe',
  summary: 'Unsubscribe, from the page or by one click in a mail app (RFC 8058)',
  description: 'Adds the address to the workspace suppression list and clears its consent. Repeating it changes nothing more.',
  request: { query: UnsubscribeQuery },
  responses: { 200: { description: 'Page', ...unsubscribePage }, 404: { description: 'No such link', ...unsubscribePage }, default: problemResponse },
});

export const FollowUpRuleSchema = z
  .object({ id: z.string(), name: z.string(), enabled: z.boolean(), inactiveMinutes: z.number().int(), createdAt: z.number(), updatedAt: z.number() })
  .openapi('FollowUpRule');

/** Long enough that it is not a reply to someone still typing, and within what a conversation still means after a while. */
const InactiveMinutes = z.number().int().min(5).max(43_200);
const followUpRuleParams = workspaceParams.extend({ ruleId: z.string() });

export const listFollowUpRulesRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/follow-up-rules',
  tags: ['email'],
  operationId: 'listFollowUpRules',
  summary: 'Rules for following up on quiet conversations. For supervisors.',
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Rules', ...json(z.object({ data: z.array(FollowUpRuleSchema) })) }, default: problemResponse },
});

export const createFollowUpRuleRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/follow-up-rules',
  tags: ['email'],
  operationId: 'createFollowUpRule',
  summary: 'Add a rule. For supervisors.',
  description: 'A rule only ever emails an open conversation whose visitor gave an address and consent. It first applies after the next public message in a conversation.',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName, enabled: z.boolean().default(true), inactiveMinutes: InactiveMinutes })) } },
  responses: { 201: { description: 'Rule', ...json(FollowUpRuleSchema) }, default: problemResponse },
});

export const updateFollowUpRuleRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}/follow-up-rules/{ruleId}',
  tags: ['email'],
  operationId: 'updateFollowUpRule',
  summary: 'Change a rule. For supervisors.',
  security: bearer,
  request: {
    params: followUpRuleParams,
    body: {
      required: true,
      ...json(
        z
          .strictObject({ name: SafeName.optional(), enabled: z.boolean().optional(), inactiveMinutes: InactiveMinutes.optional() })
          .refine((b) => b.name !== undefined || b.enabled !== undefined || b.inactiveMinutes !== undefined, 'Nothing to change'),
      ),
    },
  },
  responses: { 200: { description: 'Rule', ...json(FollowUpRuleSchema) }, default: problemResponse },
});

export const deleteFollowUpRuleRoute = createRoute({
  method: 'delete',
  path: '/api/v1/workspaces/{workspaceId}/follow-up-rules/{ruleId}',
  tags: ['email'],
  operationId: 'deleteFollowUpRule',
  summary: 'Delete a rule. For supervisors.',
  security: bearer,
  request: { params: followUpRuleParams },
  responses: { 204: { description: 'Deleted' }, default: problemResponse },
});

export const EmailSuppressionSchema = z
  .object({ email: z.string(), reason: z.enum(['unsubscribe', 'bounce', 'complaint', 'manual']), createdAt: z.number() })
  .openapi('EmailSuppression');

const SuppressionBody = z.strictObject({ email: z.email().max(254) });

export const listEmailSuppressionsRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/email-suppressions',
  tags: ['email'],
  operationId: 'listEmailSuppressions',
  summary: 'Addresses this workspace must not email. For supervisors.',
  security: bearer,
  request: { params: workspaceParams, query: PaginationQuery },
  responses: { 200: { description: 'Addresses', ...json(page(EmailSuppressionSchema)) }, default: problemResponse },
});

export const addEmailSuppressionRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/email-suppressions',
  tags: ['email'],
  operationId: 'addEmailSuppression',
  summary: 'Add an address by hand. For supervisors.',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(SuppressionBody) } },
  responses: { 204: { description: 'Listed' }, default: problemResponse },
});

/** A POST with a body, because a path would put the address in request logs. */
export const removeEmailSuppressionRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/email-suppressions/remove',
  tags: ['email'],
  operationId: 'removeEmailSuppression',
  summary: 'Remove an address added by hand. For supervisors.',
  description: 'Refuses with 409 for anyone who unsubscribed, whose bounce or complaint is on record.',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(SuppressionBody) } },
  responses: { 204: { description: 'Removed' }, default: problemResponse },
});


// ---------- Conversations and messages, for agents ----------

const conversationParams = workspaceParams.extend({ conversationId: z.string() });


export const TagSchema = z.object({ id: z.string(), name: z.string() }).openapi('Tag');

export const ConversationSchema = z
  .object({
    id: z.string(),
    websiteId: z.string(),
    contactId: z.string(),
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable().openapi({ description: 'Given by the visitor or an agent. Never verified.' }),
    tags: z.array(TagSchema),
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
    sender: z.object({ type: z.enum(['visitor', 'member', 'system']), id: z.string().nullable(), displayName: z.string().nullable(), removed: z.boolean().optional() }),
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
          content: z.string().trim().max(16000),
          attachmentIds: z.array(z.string().max(64)).max(10).optional().openapi({ description: 'Files uploaded to this conversation by this member. Content may be empty if there is at least one.' }),
        }).refine((body) => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0, { message: 'Write something or attach a file' }),
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
/** The most that an installation can allow. Its own limit, 4,000 by default, is checked later and given in the bootstrap. */
const VISITOR_CONTENT_MAX = 16000;
const VisitorContent = z.string().trim().min(1).max(VISITOR_CONTENT_MAX);
const visitorConversationParams = z.object({ conversationId: z.string() });

export const WidgetBootstrapSchema = z
  .object({
    websiteId: z.string(),
    settings: WidgetSettingsSchema,
    availability: z.enum(['online', 'offline']),
    turnstileSiteKey: z.string().optional().openapi({ description: 'Present when this website requires Turnstile for a new visitor.' }),
    messageMaxChars: z.number().int().openapi({ description: "The longest message this installation accepts from a visitor. A longer one is refused with `message_too_long`." }),
  })
  .openapi('WidgetBootstrap');

export const VisitorSessionSchema = z
  .object({ visitorId: z.string(), accessToken: z.string(), accessTokenExpiresAt: z.string(), refreshToken: z.string() })
  .openapi('VisitorSession');

export const VisitorConversationSchema = z
  .object({ id: z.string(), status: ConversationStatusSchema, lastSeq: z.number().int().openapi({ description: 'The latest public sequence number.' }), readSeq: z.number().int().openapi({ description: "This visitor's own read position." }), agentReadSeq: z.number().int().openapi({ description: 'How far any agent has read, as a public sequence number.' }), createdAt: z.string() })
  .openapi('VisitorConversation', { description: 'A deliberately reduced view, with no assignee, priority, or internal counters.' });

const VisitorConversationStartedSchema = VisitorConversationSchema.extend({ message: VisitorWireMessageSchema }).openapi('VisitorConversationStarted', {
  description: 'The conversation, and the message that started it, so that a client knows it is committed without asking again.',
});

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
  request: { body: { required: true, ...json(z.strictObject({ websiteKey: z.string().max(128), refreshToken: z.string().max(256).optional(), turnstileToken: z.string().max(2048).optional().openapi({ description: 'Needed to start a new visitor on a website that requires Turnstile. Not needed to resume one.' }) })) } },
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
    201: { description: 'Created', ...json(VisitorConversationStartedSchema) },
    200: { description: 'A replay of an existing clientMessageId. Returns the same conversation.', ...json(VisitorConversationStartedSchema) },
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
  request: { params: visitorConversationParams, body: { required: true, ...json(z.strictObject({ clientMessageId: ClientMessageId, content: z.string().trim().max(VISITOR_CONTENT_MAX), attachmentIds: z.array(z.string().max(64)).max(5).optional() }).refine((body) => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0, { message: 'Write something or attach a file' })) } },
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

// ---------- Contacts and tags ----------

const contactParams = workspaceParams.extend({ contactId: z.string() });
const tagParams = workspaceParams.extend({ tagId: z.string() });

export const ContactSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable().openapi({ description: 'Never verified, so it proves nothing about who this is.' }),
    phone: z.string().nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
  })
  .openapi('Contact');

export const getContactRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/contacts/{contactId}',
  tags: ['conversations'],
  operationId: 'getContact',
  summary: 'Get a contact',
  security: bearer,
  request: { params: contactParams },
  responses: { 200: { description: 'Contact', ...json(ContactSchema) }, default: problemResponse },
});

export const updateContactRoute = createRoute({
  method: 'patch',
  path: '/api/v1/workspaces/{workspaceId}/contacts/{contactId}',
  tags: ['conversations'],
  operationId: 'updateContact',
  summary: 'Correct a name, email, or phone number',
  security: bearer,
  request: {
    params: contactParams,
    body: {
      required: true,
      ...json(
        z
          .strictObject({
            name: SafeName.nullable().optional(),
            email: z.email().max(254).nullable().optional(),
            phone: z.string().trim().max(40).regex(/^\P{Cc}*$/u, 'Must not contain control characters').nullable().optional(),
          })
          .refine((b) => b.name !== undefined || b.email !== undefined || b.phone !== undefined, 'Nothing to change'),
      ),
    },
  },
  responses: { 200: { description: 'Updated', ...json(ContactSchema) }, default: problemResponse },
});

export const listTagsRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/tags',
  tags: ['conversations'],
  operationId: 'listTags',
  summary: "The workspace's tags, by name",
  security: bearer,
  request: { params: workspaceParams },
  responses: { 200: { description: 'Tags', ...json(z.object({ data: z.array(TagSchema) })) }, default: problemResponse },
});

export const createTagRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/tags',
  tags: ['conversations'],
  operationId: 'createTag',
  summary: 'Create a tag, or return the one with this name',
  security: bearer,
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName.max(50) })) } },
  responses: {
    201: { description: 'Created', ...json(TagSchema) },
    200: { description: 'A tag with this name already exists, whatever its capitals.', ...json(TagSchema) },
    default: problemResponse,
  },
});

export const deleteTagRoute = createRoute({
  method: 'delete',
  path: '/api/v1/workspaces/{workspaceId}/tags/{tagId}',
  tags: ['conversations'],
  operationId: 'deleteTag',
  summary: 'Delete a tag, and take it off everything',
  security: bearer,
  request: { params: tagParams },
  responses: { 204: { description: 'Deleted' }, default: problemResponse },
});

export const setConversationTagsRoute = createRoute({
  method: 'put',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/tags',
  tags: ['conversations'],
  operationId: 'setConversationTags',
  summary: 'Replace the tags on a conversation',
  description: "Does not move the conversation's version, so tagging never conflicts with a reply or an assignment. The last write wins.",
  security: bearer,
  request: { params: conversationParams, body: { required: true, ...json(z.strictObject({ tagIds: z.array(z.string().max(64)).max(50) })) } },
  responses: { 204: { description: 'Updated' }, default: problemResponse },
});

const BinaryBody = { required: true, content: { 'application/octet-stream': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } } as const;
const BinaryFile = { description: 'The file, with safe headers', content: { 'application/octet-stream': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } } as const;
const FilenameQuery = z.object({ filename: z.string().min(1).max(1024) });
const UPLOAD_NOTE = 'The body is the file, as a stream, with its type in Content-Type and its size in Content-Length. Name its ID on a later message. A file that no message claims within a day is deleted.';

export const uploadAttachmentRoute = createRoute({
  method: 'post',
  path: '/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/attachments',
  tags: ['attachments'],
  operationId: 'uploadAttachment',
  summary: 'Upload a file',
  description: UPLOAD_NOTE,
  security: bearer,
  request: { params: conversationParams, query: FilenameQuery, body: BinaryBody },
  responses: { 201: { description: 'Stored', ...json(AttachmentSchema) }, default: problemResponse },
});

export const downloadAttachmentRoute = createRoute({
  method: 'get',
  path: '/api/v1/workspaces/{workspaceId}/attachments/{attachmentId}',
  tags: ['attachments'],
  operationId: 'downloadAttachment',
  summary: 'Download a file',
  security: bearer,
  request: { params: z.object({ workspaceId: z.string(), attachmentId: z.string() }) },
  responses: { 200: BinaryFile, default: problemResponse },
});

export const uploadVisitorAttachmentRoute = createRoute({
  method: 'post',
  path: '/api/v1/widget/conversations/{conversationId}/attachments',
  tags: ['widget'],
  operationId: 'uploadVisitorAttachment',
  summary: 'Upload a file to a conversation of this visitor',
  description: UPLOAD_NOTE,
  security: visitor,
  request: { params: visitorConversationParams, query: FilenameQuery, body: BinaryBody },
  responses: { 201: { description: 'Stored', ...json(AttachmentSchema) }, default: problemResponse },
});

export const downloadVisitorAttachmentRoute = createRoute({
  method: 'get',
  path: '/api/v1/widget/attachments/{attachmentId}',
  tags: ['widget'],
  operationId: 'downloadVisitorAttachment',
  summary: 'Download a file on a public message in a conversation of this visitor',
  security: visitor,
  request: { params: z.object({ attachmentId: z.string() }) },
  responses: { 200: BinaryFile, default: problemResponse },
});

// ---------- Installation admin ----------

const personParams = z.object({ userId: z.string() });
const personWorkspaceParams = personParams.extend({ workspaceId: z.string() });

export const PersonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    isInstallationAdmin: z.boolean(),
    deactivated: z.boolean(),
    memberships: z.array(z.object({ memberId: z.string(), workspaceId: z.string(), workspaceName: z.string(), role: RoleSchema, status: MemberStatusSchema })),
  })
  .openapi('Person');

export const AdminWorkspaceSchema = z.object({ id: z.string(), name: z.string() }).openapi('AdminWorkspace');

const adminRoute = { tags: ['admin'], security: bearer };

export const listPeopleRoute = createRoute({
  ...adminRoute,
  method: 'get',
  path: '/api/v1/admin/people',
  operationId: 'listPeople',
  summary: 'List every account on the installation. Anyone but an installation admin gets 404.',
  request: { query: PaginationQuery },
  responses: { 200: { description: 'People', ...json(page(PersonSchema)) }, default: problemResponse },
});

export const createPersonRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/people',
  operationId: 'createPerson',
  summary: 'Create an account and email a link that lasts seven days to choose a password. 409 if the address has an account.',
  request: { body: { required: true, ...json(z.strictObject({ name: SafeName, email: Email })) } },
  responses: { 201: { description: 'Created', ...json(PersonSchema) }, default: problemResponse },
});

export const updatePersonRoute = createRoute({
  ...adminRoute,
  method: 'patch',
  path: '/api/v1/admin/people/{userId}',
  operationId: 'updatePerson',
  summary: 'Grant or take away installation admin. The installation must keep one active admin.',
  request: { params: personParams, body: { required: true, ...json(z.strictObject({ isInstallationAdmin: z.boolean() })) } },
  responses: { 200: { description: 'Updated', ...json(PersonSchema) }, default: problemResponse },
});

export const deactivatePersonRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/people/{userId}/deactivate',
  operationId: 'deactivatePerson',
  summary: 'End all access, keeping the account and its memberships. Refused for yourself.',
  request: { params: personParams },
  responses: { 200: { description: 'Deactivated', ...json(PersonSchema) }, default: problemResponse },
});

export const reactivatePersonRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/people/{userId}/reactivate',
  operationId: 'reactivatePerson',
  summary: 'Restore a deactivated account, with its password and memberships as they were.',
  request: { params: personParams },
  responses: { 200: { description: 'Reactivated', ...json(PersonSchema) }, default: problemResponse },
});

export const assignPersonRoute = createRoute({
  ...adminRoute,
  method: 'put',
  path: '/api/v1/admin/people/{userId}/workspaces/{workspaceId}',
  operationId: 'assignPerson',
  summary: 'Put someone in a workspace with a role, or change their role there. Brings back a removed or suspended member. An admin who adds themselves can then read the workspace, and this is audited.',
  request: { params: personWorkspaceParams, body: { required: true, ...json(z.strictObject({ role: RoleSchema })) } },
  responses: { 200: { description: 'Assigned', ...json(PersonSchema) }, default: problemResponse },
});

export const unassignPersonRoute = createRoute({
  ...adminRoute,
  method: 'delete',
  path: '/api/v1/admin/people/{userId}/workspaces/{workspaceId}',
  operationId: 'unassignPerson',
  summary: 'Remove someone from a workspace. Their messages keep their name.',
  request: { params: personWorkspaceParams },
  responses: { 200: { description: 'Removed', ...json(PersonSchema) }, default: problemResponse },
});

export const listAdminWorkspacesRoute = createRoute({
  ...adminRoute,
  method: 'get',
  path: '/api/v1/admin/workspaces',
  operationId: 'listAdminWorkspaces',
  summary: 'List every workspace by name. Gives no access to its conversations.',
  request: { query: PaginationQuery },
  responses: { 200: { description: 'Workspaces', ...json(page(AdminWorkspaceSchema)) }, default: problemResponse },
});

export const createWorkspaceRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/workspaces',
  operationId: 'createWorkspace',
  summary: 'Create a workspace. Nobody joins it by creating it, so assign people to it afterwards.',
  request: { body: { required: true, ...json(z.strictObject({ name: SafeName })) } },
  responses: { 201: { description: 'Created', ...json(WorkspaceSchema) }, default: problemResponse },
});

export const updateWorkspaceRoute = createRoute({
  ...adminRoute,
  method: 'patch',
  path: '/api/v1/admin/workspaces/{workspaceId}',
  operationId: 'updateWorkspace',
  summary: 'Update workspace settings',
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName.optional() })) } },
  responses: { 200: { description: 'Updated', ...json(WorkspaceSchema) }, default: problemResponse },
});

export const listAdminWebsitesRoute = createRoute({
  ...adminRoute,
  method: 'get',
  path: '/api/v1/admin/workspaces/{workspaceId}/websites',
  operationId: 'listAdminWebsites',
  summary: 'List the websites of any workspace, without being a member of it',
  request: { params: workspaceParams },
  responses: { 200: { description: 'Websites', ...json(z.object({ data: z.array(WebsiteSchema) })) }, default: problemResponse },
});

export const createWebsiteRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/workspaces/{workspaceId}/websites',
  operationId: 'createWebsite',
  summary: 'Register a website and obtain its public key',
  request: { params: workspaceParams, body: { required: true, ...json(z.strictObject({ name: SafeName, ...websiteFields })) } },
  responses: { 201: { description: 'Created', ...json(WebsiteSchema) }, default: problemResponse },
});

export const updateWebsiteRoute = createRoute({
  ...adminRoute,
  method: 'patch',
  path: '/api/v1/admin/workspaces/{workspaceId}/websites/{websiteId}',
  operationId: 'updateWebsite',
  summary: 'Update a website',
  request: {
    params: websiteParams,
    body: { required: true, ...json(z.strictObject({ name: SafeName.optional(), allowedOrigins: websiteFields.allowedOrigins.optional(), settings: websiteFields.settings })) },
  },
  responses: { 200: { description: 'Updated', ...json(WebsiteSchema) }, default: problemResponse },
});

export const RelayStatusSchema = z
  .object({
    state: z.enum(['not_configured', 'connected', 'disconnected']).openapi({
      description: 'not_configured: no relay in this deployment. disconnected: an admin disconnected from the configured relay, which erased what it held, and push is off.',
    }),
    relay: z.object({ id: z.string(), url: z.string() }).nullable(),
    /** Whether the relay has accepted this installation. It registers when a phone first asks for push. */
    registered: z.boolean(),
    subscriptions: z.number().int().openapi({ description: 'Phones registered for push, across every workspace.' }),
  })
  .openapi('RelayStatus');

export const getRelayStatusRoute = createRoute({
  ...adminRoute,
  method: 'get',
  path: '/api/v1/admin/push',
  operationId: 'getRelayStatus',
  summary: 'The notification relay this installation uses, and whether push is on',
  responses: { 200: { description: 'Relay status', ...json(RelayStatusSchema) }, default: problemResponse },
});

export const disconnectRelayRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/push/disconnect',
  operationId: 'disconnectRelay',
  summary: 'Turn push off, and have the relay erase everything it holds about this installation. Push stays off until reconnected.',
  description: 'Repeat it if it answers 503: push is already off, and only the erasure at the relay is left.',
  responses: { 200: { description: 'Disconnected, and erased at the relay', ...json(RelayStatusSchema) }, default: problemResponse },
});

export const reconnectRelayRoute = createRoute({
  ...adminRoute,
  method: 'post',
  path: '/api/v1/admin/push/reconnect',
  operationId: 'reconnectRelay',
  summary: 'Turn push back on. Phones register again the next time the app starts.',
  responses: { 200: { description: 'Reconnected', ...json(RelayStatusSchema) }, default: problemResponse },
});
