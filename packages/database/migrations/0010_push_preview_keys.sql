ALTER TABLE `push_subscriptions` ADD `preview_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- ADR-0017: every subscription needs a key. Rows from before have none and could never be sent to, so they go.
-- The previous Worker still inserts without a key; its rows default to '' and are never sent to either.
DELETE FROM `push_subscriptions` WHERE `preview_key` = '';
