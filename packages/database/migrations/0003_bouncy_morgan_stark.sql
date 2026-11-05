ALTER TABLE `users` ADD `is_installation_admin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `removed_at` integer;--> statement-breakpoint
-- An installation that already exists needs someone who can manage it. Its first owner is who set it up.
UPDATE `users` SET `is_installation_admin` = 1
 WHERE `id` = (SELECT `user_id` FROM `workspace_members` WHERE `role` = 'owner' AND `status` = 'active' ORDER BY `created_at`, `id` LIMIT 1);
