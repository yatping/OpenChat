-- Members are no longer emailed about conversations (amendment A15). Removing their choices means a Worker from
-- before this deploy sends no alert in the meantime. The column stays until a later contract migration.
DELETE FROM `notification_preferences` WHERE `channel` = 'email';--> statement-breakpoint
UPDATE `conversations` SET `next_unanswered_alert_at` = NULL WHERE `next_unanswered_alert_at` IS NOT NULL;
