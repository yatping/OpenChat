CREATE TABLE `email_unsubscribe_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `email_unsubscribe_links_email_idx` ON `email_unsubscribe_links` (`workspace_id`,`email`);