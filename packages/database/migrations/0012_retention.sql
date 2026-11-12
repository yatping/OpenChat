ALTER TABLE `workspaces` ADD `retention_days` integer;--> statement-breakpoint
CREATE INDEX `contacts_stale_idx` ON `contacts` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `job_receipts_claimed_idx` ON `job_receipts` (`claimed_at`);