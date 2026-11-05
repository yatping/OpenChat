-- ADR-0016: the installation admin replaces the workspace owner and admin roles. Whoever held them keeps
-- working as a supervisor. The CHECK constraint keeps the old values for now, because a Worker from before
-- this migration can still write them. A later migration removes them.
UPDATE `workspace_members` SET `role` = 'supervisor', `updated_at` = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE `role` IN ('owner', 'admin');--> statement-breakpoint
-- Their links no longer lead anywhere, and these rows hold email addresses with no further use.
DELETE FROM `invitations`;
