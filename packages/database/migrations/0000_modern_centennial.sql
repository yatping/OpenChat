CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`storage_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`uploaded_by_type` text NOT NULL,
	`uploaded_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`message_id`) REFERENCES `messages`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attachments_size_ck" CHECK("attachments"."size" > 0),
	CONSTRAINT "attachments_status_ck" CHECK("attachments"."status" IN ('pending','ready','rejected')),
	CONSTRAINT "attachments_uploader_ck" CHECK("attachments"."uploaded_by_type" IN ('visitor','member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_storage_key_unique` ON `attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`workspace_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_orphan_idx` ON `attachments` (`created_at`) WHERE "attachments"."message_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_tenant_uq` ON `attachments` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_idx` ON `audit_log` (`workspace_id`,"created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`previous_token_hash` text,
	`client_type` text NOT NULL,
	`client_label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_sessions_client_ck" CHECK("auth_sessions"."client_type" IN ('dashboard','mobile'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_refresh_token_hash_unique` ON `auth_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_user_idx` ON `auth_sessions` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_tokens_purpose_ck" CHECK("auth_tokens"."purpose" IN ('password_reset','email_verification'))
);
--> statement-breakpoint
CREATE INDEX `auth_tokens_expiry_idx` ON `auth_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger_type` text NOT NULL,
	`conditions_json` text NOT NULL,
	`actions_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_rules_trigger_idx` ON `automation_rules` (`workspace_id`,`trigger_type`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_rules_tenant_uq` ON `automation_rules` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`trigger_key` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`rule_id`) REFERENCES `automation_rules`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_dedupe_uq` ON `automation_runs` (`workspace_id`,`rule_id`,`conversation_id`,`trigger_key`);--> statement-breakpoint
CREATE TABLE `contact_tags` (
	`workspace_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `contact_id`, `tag_id`),
	FOREIGN KEY (`workspace_id`,`contact_id`) REFERENCES `contacts`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`tag_id`) REFERENCES `tags`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text,
	`email` text COLLATE NOCASE,
	`phone` text,
	`attributes_json` text DEFAULT '{}' NOT NULL,
	`follow_up_consent_at` integer,
	`follow_up_consent_source` text,
	`merged_into_contact_id` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`merged_into_contact_id`) REFERENCES `contacts`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_email_idx` ON `contacts` (`workspace_id`,`email`) WHERE "contacts"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `contacts_list_idx` ON `contacts` (`workspace_id`,"last_seen_at" DESC,"id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_tenant_uq` ON `contacts` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_events_actor_ck" CHECK("conversation_events"."actor_type" IN ('visitor','member','system'))
);
--> statement-breakpoint
CREATE INDEX `conversation_events_idx` ON `conversation_events` (`workspace_id`,`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_read_cursors` (
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`reader_type` text NOT NULL,
	`reader_id` text NOT NULL,
	`delivered_seq` integer DEFAULT 0 NOT NULL,
	`read_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `conversation_id`, `reader_type`, `reader_id`),
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "read_cursors_reader_ck" CHECK("conversation_read_cursors"."reader_type" IN ('visitor','member'))
);
--> statement-breakpoint
CREATE TABLE `conversation_tags` (
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `conversation_id`, `tag_id`),
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`tag_id`) REFERENCES `tags`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`website_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`assigned_member_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`subject` text,
	`last_message_seq` integer DEFAULT 0 NOT NULL,
	`last_public_seq` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_visitor_message_at` integer,
	`last_agent_message_at` integer,
	`next_automation_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`website_id`) REFERENCES `websites`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`contact_id`) REFERENCES `contacts`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`assigned_member_id`) REFERENCES `workspace_members`(`workspace_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_status_ck" CHECK("conversations"."status" IN ('open','pending','resolved','archived')),
	CONSTRAINT "conversations_priority_ck" CHECK("conversations"."priority" IN ('low','normal','high','urgent'))
);
--> statement-breakpoint
CREATE INDEX `conversations_inbox_idx` ON `conversations` (`workspace_id`,`status`,"last_message_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `conversations_assignee_idx` ON `conversations` (`workspace_id`,`assigned_member_id`,`status`,"last_message_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `conversations_contact_idx` ON `conversations` (`workspace_id`,`contact_id`,"last_message_at" DESC);--> statement-breakpoint
CREATE INDEX `conversations_automation_idx` ON `conversations` (`next_automation_at`) WHERE "conversations"."next_automation_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`workspace_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_tenant_uq` ON `conversations` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`template` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_deliveries_status_ck" CHECK("email_deliveries"."status" IN ('claimed','sent','failed','suppressed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_deliveries_dedupe_uq` ON `email_deliveries` (`workspace_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `email_settings` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`sender_name` text NOT NULL,
	`sender_email` text NOT NULL,
	`configuration_enc` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`workspace_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `email`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "email_suppressions_reason_ck" CHECK("email_suppressions"."reason" IN ('unsubscribe','bounce','complaint','manual'))
);
--> statement-breakpoint
CREATE TABLE `failed_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`queue` text NOT NULL,
	`job_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempts` integer NOT NULL,
	`envelope_json` text NOT NULL,
	`failed_at` integer NOT NULL,
	`replayed_at` integer
);
--> statement-breakpoint
CREATE INDEX `failed_jobs_recent_idx` ON `failed_jobs` ("failed_at" DESC);--> statement-breakpoint
CREATE TABLE `installation` (
	`id` text PRIMARY KEY NOT NULL,
	`singleton` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`public_base_url` text NOT NULL,
	`signup_policy` text DEFAULT 'invite_only' NOT NULL,
	`system_email_enc` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "installation_singleton_ck" CHECK("installation"."singleton" = 1),
	CONSTRAINT "installation_signup_ck" CHECK("installation"."signup_policy" IN ('invite_only','open'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installation_singleton_unique` ON `installation` (`singleton`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_member_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`invited_by_member_id`) REFERENCES `workspace_members`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invitations_role_ck" CHECK("invitations"."role" IN ('admin','supervisor','agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_tenant_uq` ON `invitations` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `job_receipts` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "job_receipts_status_ck" CHECK("job_receipts"."status" IN ('claimed','done'))
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`public_seq` integer,
	`client_message_id` text,
	`sender_type` text NOT NULL,
	`sender_id` text,
	`message_type` text NOT NULL,
	`visibility` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`conversation_id`) REFERENCES `conversations`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_sender_ck" CHECK("messages"."sender_type" IN ('visitor','member','system')),
	CONSTRAINT "messages_type_ck" CHECK("messages"."message_type" IN ('text','image','file','system','internal_note')),
	CONSTRAINT "messages_visibility_ck" CHECK("messages"."visibility" IN ('public','internal')),
	CONSTRAINT "messages_note_visibility_ck" CHECK(("messages"."message_type" = 'internal_note') = ("messages"."visibility" = 'internal')),
	CONSTRAINT "messages_public_seq_ck" CHECK(("messages"."visibility" = 'public') = ("messages"."public_seq" IS NOT NULL)),
	CONSTRAINT "messages_note_sender_ck" CHECK("messages"."message_type" <> 'internal_note' OR "messages"."sender_type" = 'member')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_tenant_uq` ON `messages` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_seq_uq` ON `messages` (`workspace_id`,`conversation_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_public_seq_uq` ON `messages` (`workspace_id`,`conversation_id`,`public_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_uq` ON `messages` (`workspace_id`,`conversation_id`,`client_message_id`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`event_type` text NOT NULL,
	`channel` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `member_id`, `event_type`, `channel`),
	FOREIGN KEY (`workspace_id`,`member_id`) REFERENCES `workspace_members`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_preferences_channel_ck" CHECK("notification_preferences"."channel" IN ('push','email'))
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`topic` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`dispatched_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox` (`created_at`) WHERE "outbox"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX `outbox_purge_idx` ON `outbox` (`dispatched_at`) WHERE "outbox"."dispatched_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`member_id` text NOT NULL,
	`relay_id` text NOT NULL,
	`relay_subscription_id` text NOT NULL,
	`platform` text NOT NULL,
	`device_label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`member_id`) REFERENCES `workspace_members`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "push_subscriptions_platform_ck" CHECK("push_subscriptions"."platform" IN ('ios'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_relay_uq` ON `push_subscriptions` (`relay_id`,`relay_subscription_id`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_member_idx` ON `push_subscriptions` (`workspace_id`,`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_tenant_uq` ON `push_subscriptions` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text COLLATE NOCASE NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_tenant_uq` ON `tags` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_uq` ON `tags` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`email_verified_at` integer,
	`disabled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `visitors` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`website_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`,`website_id`) REFERENCES `websites`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`,`contact_id`) REFERENCES `contacts`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitors_refresh_token_hash_unique` ON `visitors` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `visitors_contact_idx` ON `visitors` (`workspace_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `visitors_stale_idx` ON `visitors` (`last_seen_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `visitors_tenant_uq` ON `visitors` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `websites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`website_key` text NOT NULL,
	`allowed_origins_json` text DEFAULT '[]' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `websites_website_key_unique` ON `websites` (`website_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `websites_tenant_uq` ON `websites` (`workspace_id`,`id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_members_role_ck" CHECK("workspace_members"."role" IN ('owner','admin','supervisor','agent')),
	CONSTRAINT "workspace_members_status_ck" CHECK("workspace_members"."status" IN ('active','suspended'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_tenant_uq` ON `workspace_members` (`workspace_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_user_uq` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`relay_workspace_status` text DEFAULT 'unregistered' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "workspaces_relay_ck" CHECK("workspaces"."relay_workspace_status" IN ('unregistered','registered','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);