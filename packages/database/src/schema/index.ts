/**
 * The installation database. Rationale: docs/architecture/data-model.md.
 *
 * Conventions
 *  - IDs are TEXT, `<prefix>_<26 chars>`. Timestamps are INTEGER milliseconds UTC.
 *  - Every workspace-owned table has workspace_id, and child tables reference parents by
 *    (workspace_id, id) so that a cross-tenant reference cannot be stored at all.
 *  - No ON DELETE SET NULL on composite keys: it would also null workspace_id.
 *  - JSON lives in TEXT columns suffixed _json, validated by Zod at the application boundary.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const nocase = customType<{ data: string }>({ dataType: () => 'text COLLATE NOCASE' });
const json = (name: string) => text(name).notNull().default('{}');
const ts = (name: string) => integer(name).notNull();

// ---------- Installation scope (deliberately no workspace_id) ----------

export const installation = sqliteTable(
  'installation',
  {
    id: text('id').primaryKey(),
    singleton: integer('singleton').notNull().default(1).unique(),
    name: text('name').notNull(),
    publicBaseUrl: text('public_base_url').notNull(),
    signupPolicy: text('signup_policy', { enum: ['invite_only', 'open'] }).notNull().default('invite_only'),
    systemEmailEnc: text('system_email_enc'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    check('installation_singleton_ck', sql`${t.singleton} = 1`),
    check('installation_signup_ck', sql`${t.signupPolicy} IN ('invite_only','open')`),
  ],
);

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: nocase('email').notNull().unique(),
  name: text('name').notNull(),
  /** PHC string, so that parameters can be upgraded per hash. */
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: integer('email_verified_at'),
  disabledAt: integer('disabled_at'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    /** Presenting this hash again means a token was stolen, and revokes the session. */
    previousTokenHash: text('previous_token_hash'),
    clientType: text('client_type', { enum: ['dashboard', 'mobile'] }).notNull(),
    clientLabel: text('client_label'),
    createdAt: ts('created_at'),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    index('auth_sessions_user_idx').on(t.userId, t.revokedAt),
    index('auth_sessions_expiry_idx').on(t.expiresAt),
    check('auth_sessions_client_ck', sql`${t.clientType} IN ('dashboard','mobile')`),
  ],
);

export const authTokens = sqliteTable(
  'auth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['password_reset', 'email_verification'] }).notNull(),
    expiresAt: ts('expires_at'),
    consumedAt: integer('consumed_at'),
  },
  (t) => [
    index('auth_tokens_expiry_idx').on(t.expiresAt),
    check('auth_tokens_purpose_ck', sql`${t.purpose} IN ('password_reset','email_verification')`),
  ],
);

// ---------- Workspace, membership ----------

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    settingsJson: json('settings_json'),
    relayWorkspaceStatus: text('relay_workspace_status', { enum: ['unregistered', 'registered', 'revoked'] })
      .notNull()
      .default('unregistered'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [check('workspaces_relay_ck', sql`${t.relayWorkspaceStatus} IN ('unregistered','registered','revoked')`)],
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    /** Doubles as the relay recipientId, so that no user ID or email leaves the installation. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** No cascade: users are anonymised, never hard-deleted. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'admin', 'supervisor', 'agent'] }).notNull(),
    status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('workspace_members_tenant_uq').on(t.workspaceId, t.id),
    unique('workspace_members_user_uq').on(t.workspaceId, t.userId),
    index('workspace_members_user_idx').on(t.userId, t.status),
    check('workspace_members_role_ck', sql`${t.role} IN ('owner','admin','supervisor','agent')`),
    check('workspace_members_status_ck', sql`${t.status} IN ('active','suspended')`),
  ],
);

export const invitations = sqliteTable(
  'invitations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: nocase('email').notNull(),
    role: text('role', { enum: ['admin', 'supervisor', 'agent'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByMemberId: text('invited_by_member_id').notNull(),
    expiresAt: ts('expires_at'),
    acceptedAt: integer('accepted_at'),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('invitations_tenant_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'invitations_inviter_fk',
      columns: [t.workspaceId, t.invitedByMemberId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.id],
    }).onDelete('cascade'),
    check('invitations_role_ck', sql`${t.role} IN ('admin','supervisor','agent')`),
  ],
);

// ---------- Websites, visitors, contacts ----------

export const websites = sqliteTable(
  'websites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A public identifier embedded in page source. Not a credential. */
    websiteKey: text('website_key').notNull().unique(),
    allowedOriginsJson: text('allowed_origins_json').notNull().default('[]'),
    settingsJson: json('settings_json'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [unique('websites_tenant_uq').on(t.workspaceId, t.id)],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name'),
    email: nocase('email'),
    phone: text('phone'),
    attributesJson: json('attributes_json'),
    /** NULL means no consent recorded. */
    followUpConsentAt: integer('follow_up_consent_at'),
    followUpConsentSource: text('follow_up_consent_source'),
    mergedIntoContactId: text('merged_into_contact_id'),
    firstSeenAt: ts('first_seen_at'),
    lastSeenAt: ts('last_seen_at'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('contacts_tenant_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'contacts_merged_fk',
      columns: [t.workspaceId, t.mergedIntoContactId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    index('contacts_email_idx').on(t.workspaceId, t.email).where(sql`${t.email} IS NOT NULL`),
    index('contacts_list_idx').on(t.workspaceId, sql`${t.lastSeenAt} DESC`, sql`${t.id} DESC`),
  ],
);

/** A contact can be many browsers and devices. Merging contacts only repoints visitors. */
export const visitors = sqliteTable(
  'visitors',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    websiteId: text('website_id').notNull(),
    contactId: text('contact_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    createdAt: ts('created_at'),
    lastSeenAt: ts('last_seen_at'),
  },
  (t) => [
    unique('visitors_tenant_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'visitors_website_fk',
      columns: [t.workspaceId, t.websiteId],
      foreignColumns: [websites.workspaceId, websites.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'visitors_contact_fk',
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }).onDelete('cascade'),
    index('visitors_contact_idx').on(t.workspaceId, t.contactId),
    index('visitors_stale_idx').on(t.lastSeenAt),
  ],
);

// ---------- Conversations, messages ----------

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    websiteId: text('website_id').notNull(),
    contactId: text('contact_id').notNull(),
    assignedMemberId: text('assigned_member_id'),
    status: text('status', { enum: ['open', 'pending', 'resolved', 'archived'] }).notNull().default('open'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] }).notNull().default('normal'),
    subject: text('subject'),
    lastMessageSeq: integer('last_message_seq').notNull().default(0),
    /** The gapless sequence shown to visitors. */
    lastPublicSeq: integer('last_public_seq').notNull().default(0),
    lastMessageAt: integer('last_message_at'),
    lastVisitorMessageAt: integer('last_visitor_message_at'),
    lastAgentMessageAt: integer('last_agent_message_at'),
    /** Cron work-list. See docs/architecture/background-jobs.md. */
    nextAutomationAt: integer('next_automation_at'),
    /** Optimistic concurrency token. */
    version: integer('version').notNull().default(1),
    /** Guards follow-up statements in a batch. See data-model.md, Pattern 2. */
    lastMutationId: text('last_mutation_id'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('conversations_tenant_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'conversations_website_fk',
      columns: [t.workspaceId, t.websiteId],
      foreignColumns: [websites.workspaceId, websites.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversations_contact_fk',
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversations_assignee_fk',
      columns: [t.workspaceId, t.assignedMemberId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.id],
    }),
    index('conversations_inbox_idx').on(t.workspaceId, t.status, sql`${t.lastMessageAt} DESC`, sql`${t.id} DESC`),
    index('conversations_assignee_idx').on(
      t.workspaceId,
      t.assignedMemberId,
      t.status,
      sql`${t.lastMessageAt} DESC`,
      sql`${t.id} DESC`,
    ),
    index('conversations_contact_idx').on(t.workspaceId, t.contactId, sql`${t.lastMessageAt} DESC`),
    index('conversations_automation_idx').on(t.nextAutomationAt).where(sql`${t.nextAutomationAt} IS NOT NULL`),
    index('conversations_updated_idx').on(t.workspaceId, t.updatedAt, t.id),
    check('conversations_status_ck', sql`${t.status} IN ('open','pending','resolved','archived')`),
    check('conversations_priority_ck', sql`${t.priority} IN ('low','normal','high','urgent')`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** All messages, used by agents. */
    seq: integer('seq').notNull(),
    /** Visitors see this as their seq. Notes do not consume it, so gaps cannot reveal them. */
    publicSeq: integer('public_seq'),
    /** Idempotency key supplied by the client. */
    clientMessageId: text('client_message_id'),
    senderType: text('sender_type', { enum: ['visitor', 'member', 'system'] }).notNull(),
    senderId: text('sender_id'),
    messageType: text('message_type', { enum: ['text', 'image', 'file', 'system', 'internal_note'] }).notNull(),
    /** Stored rather than derived so that every visitor-facing query can filter on it directly. */
    visibility: text('visibility', { enum: ['public', 'internal'] }).notNull(),
    content: text('content').notNull().default(''),
    metadataJson: json('metadata_json'),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('messages_tenant_uq').on(t.workspaceId, t.id),
    unique('messages_seq_uq').on(t.workspaceId, t.conversationId, t.seq),
    unique('messages_public_seq_uq').on(t.workspaceId, t.conversationId, t.publicSeq),
    unique('messages_client_uq').on(t.workspaceId, t.conversationId, t.clientMessageId),
    foreignKey({
      name: 'messages_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    check('messages_sender_ck', sql`${t.senderType} IN ('visitor','member','system')`),
    check('messages_type_ck', sql`${t.messageType} IN ('text','image','file','system','internal_note')`),
    check('messages_visibility_ck', sql`${t.visibility} IN ('public','internal')`),
    check('messages_note_visibility_ck', sql`(${t.messageType} = 'internal_note') = (${t.visibility} = 'internal')`),
    check('messages_public_seq_ck', sql`(${t.visibility} = 'public') = (${t.publicSeq} IS NOT NULL)`),
    check('messages_note_sender_ck', sql`${t.messageType} <> 'internal_note' OR ${t.senderType} = 'member'`),
  ],
);

/** Cursors, not one row per message and reader. For visitors they compare with public_seq. */
export const conversationReadCursors = sqliteTable(
  'conversation_read_cursors',
  {
    workspaceId: text('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    readerType: text('reader_type', { enum: ['visitor', 'member'] }).notNull(),
    readerId: text('reader_id').notNull(),
    deliveredSeq: integer('delivered_seq').notNull().default(0),
    readSeq: integer('read_seq').notNull().default(0),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.conversationId, t.readerType, t.readerId] }),
    foreignKey({
      name: 'read_cursors_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    check('read_cursors_reader_ck', sql`${t.readerType} IN ('visitor','member')`),
  ],
);

export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    eventType: text('event_type').notNull(),
    actorType: text('actor_type', { enum: ['visitor', 'member', 'system'] }).notNull(),
    actorId: text('actor_id'),
    metadataJson: json('metadata_json'),
    createdAt: ts('created_at'),
  },
  (t) => [
    foreignKey({
      name: 'conversation_events_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    index('conversation_events_idx').on(t.workspaceId, t.conversationId, t.createdAt),
    check('conversation_events_actor_ck', sql`${t.actorType} IN ('visitor','member','system')`),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** NULL until the sending message commits. */
    messageId: text('message_id'),
    /** w/<workspace_id>/c/<conversation_id>/<id> */
    storageKey: text('storage_key').notNull().unique(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'rejected'] }).notNull().default('pending'),
    uploadedByType: text('uploaded_by_type', { enum: ['visitor', 'member'] }).notNull(),
    uploadedById: text('uploaded_by_id').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('attachments_tenant_uq').on(t.workspaceId, t.id),
    foreignKey({
      name: 'attachments_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'attachments_message_fk',
      columns: [t.workspaceId, t.messageId],
      foreignColumns: [messages.workspaceId, messages.id],
    }),
    index('attachments_message_idx').on(t.workspaceId, t.messageId),
    index('attachments_orphan_idx').on(t.createdAt).where(sql`${t.messageId} IS NULL`),
    check('attachments_size_ck', sql`${t.size} > 0`),
    check('attachments_status_ck', sql`${t.status} IN ('pending','ready','rejected')`),
    check('attachments_uploader_ck', sql`${t.uploadedByType} IN ('visitor','member')`),
  ],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: nocase('name').notNull(),
    color: text('color'),
    createdAt: ts('created_at'),
  },
  (t) => [unique('tags_tenant_uq').on(t.workspaceId, t.id), unique('tags_name_uq').on(t.workspaceId, t.name)],
);

export const conversationTags = sqliteTable(
  'conversation_tags',
  {
    workspaceId: text('workspace_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    tagId: text('tag_id').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.conversationId, t.tagId] }),
    foreignKey({
      name: 'conversation_tags_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'conversation_tags_tag_fk',
      columns: [t.workspaceId, t.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete('cascade'),
  ],
);

export const contactTags = sqliteTable(
  'contact_tags',
  {
    workspaceId: text('workspace_id').notNull(),
    contactId: text('contact_id').notNull(),
    tagId: text('tag_id').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.contactId, t.tagId] }),
    foreignKey({
      name: 'contact_tags_contact_fk',
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contacts.workspaceId, contacts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'contact_tags_tag_fk',
      columns: [t.workspaceId, t.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete('cascade'),
  ],
);

// ---------- Push: handles only. APNs tokens never enter this database (ADR-0005) ----------

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    relayId: text('relay_id').notNull(),
    /** Opaque handle issued by the relay. */
    relaySubscriptionId: text('relay_subscription_id').notNull(),
    platform: text('platform', { enum: ['ios'] }).notNull(),
    deviceLabel: text('device_label'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('push_subscriptions_tenant_uq').on(t.workspaceId, t.id),
    uniqueIndex('push_subscriptions_relay_uq').on(t.relayId, t.relaySubscriptionId),
    foreignKey({
      name: 'push_subscriptions_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.id],
    }).onDelete('cascade'),
    index('push_subscriptions_member_idx').on(t.workspaceId, t.memberId),
    check('push_subscriptions_platform_ck', sql`${t.platform} IN ('ios')`),
  ],
);

export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    eventType: text('event_type').notNull(),
    channel: text('channel', { enum: ['push', 'email'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.memberId, t.eventType, t.channel] }),
    foreignKey({
      name: 'notification_preferences_member_fk',
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.id],
    }).onDelete('cascade'),
    check('notification_preferences_channel_ck', sql`${t.channel} IN ('push','email')`),
  ],
);

// ---------- Email, automation ----------

export const emailSettings = sqliteTable('email_settings', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  senderName: text('sender_name').notNull(),
  senderEmail: text('sender_email').notNull(),
  /** AES-GCM ciphertext, never plaintext JSON. */
  configurationEnc: text('configuration_enc').notNull(),
  keyVersion: integer('key_version').notNull(),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const emailSuppressions = sqliteTable(
  'email_suppressions',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: nocase('email').notNull(),
    reason: text('reason', { enum: ['unsubscribe', 'bounce', 'complaint', 'manual'] }).notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.email] }),
    check('email_suppressions_reason_ck', sql`${t.reason} IN ('unsubscribe','bounce','complaint','manual')`),
  ],
);

export const emailDeliveries = sqliteTable(
  'email_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    template: text('template').notNull(),
    /** No plaintext address in the delivery log. */
    recipientHash: text('recipient_hash').notNull(),
    status: text('status', { enum: ['claimed', 'sent', 'failed', 'suppressed'] }).notNull(),
    providerMessageId: text('provider_message_id'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('email_deliveries_dedupe_uq').on(t.workspaceId, t.dedupeKey),
    check('email_deliveries_status_ck', sql`${t.status} IN ('claimed','sent','failed','suppressed')`),
  ],
);

export const automationRules = sqliteTable(
  'automation_rules',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    triggerType: text('trigger_type').notNull(),
    conditionsJson: text('conditions_json').notNull(),
    actionsJson: text('actions_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    unique('automation_rules_tenant_uq').on(t.workspaceId, t.id),
    index('automation_rules_trigger_idx').on(t.workspaceId, t.triggerType, t.enabled),
  ],
);

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    ruleId: text('rule_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    /** For inactivity rules: last_message_seq at evaluation. One run per rule per quiet period. */
    triggerKey: text('trigger_key').notNull(),
    outcome: text('outcome').notNull(),
    createdAt: ts('created_at'),
  },
  (t) => [
    unique('automation_runs_dedupe_uq').on(t.workspaceId, t.ruleId, t.conversationId, t.triggerKey),
    foreignKey({
      name: 'automation_runs_rule_fk',
      columns: [t.workspaceId, t.ruleId],
      foreignColumns: [automationRules.workspaceId, automationRules.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'automation_runs_conversation_fk',
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }).onDelete('cascade'),
  ],
);

// ---------- Reliability, audit ----------

export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    topic: text('topic').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: ts('created_at'),
    dispatchedAt: integer('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('outbox_pending_idx').on(t.createdAt).where(sql`${t.dispatchedAt} IS NULL`),
    index('outbox_purge_idx').on(t.dispatchedAt).where(sql`${t.dispatchedAt} IS NOT NULL`),
  ],
);

export const jobReceipts = sqliteTable(
  'job_receipts',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    jobType: text('job_type').notNull(),
    status: text('status', { enum: ['claimed', 'done'] }).notNull(),
    claimedAt: ts('claimed_at'),
    completedAt: integer('completed_at'),
  },
  (t) => [check('job_receipts_status_ck', sql`${t.status} IN ('claimed','done')`)],
);

/** The DLQ sink, so that failures outlive queue retention. IDs only, no message content. */
export const failedJobs = sqliteTable(
  'failed_jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    queue: text('queue').notNull(),
    jobType: text('job_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    attempts: integer('attempts').notNull(),
    envelopeJson: text('envelope_json').notNull(),
    failedAt: ts('failed_at'),
    replayedAt: integer('replayed_at'),
  },
  (t) => [index('failed_jobs_recent_idx').on(sql`${t.failedAt} DESC`)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadataJson: json('metadata_json'),
    createdAt: ts('created_at'),
  },
  (t) => [index('audit_log_idx').on(t.workspaceId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`)],
);

/** Tables with no workspace_id. Every other table must have the column, and a test enforces this. */
export const TABLES_WITHOUT_WORKSPACE = [
  'installation',
  'users',
  'auth_sessions',
  'auth_tokens',
  'workspaces',
  'job_receipts',
  'failed_jobs',
] as const;
