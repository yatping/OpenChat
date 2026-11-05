-- Delivery records. Opaque IDs and counts only, with no message content. Kept for 30 days.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  event TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivering', 'completed', 'expired', 'no_devices')),
  delivered INTEGER NOT NULL DEFAULT 0,
  invalid_token INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  -- The last delivery attempt whose results were counted. Queues deliver at least once.
  processed_attempt INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, workspace_id, notification_id)
) STRICT;

CREATE INDEX notifications_created_idx ON notifications (created_at);
