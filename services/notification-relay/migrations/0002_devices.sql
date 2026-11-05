-- APNs tokens are encrypted, so uniqueness uses token_lookup, a keyed hash. See docs/notification-relay/protocol.md.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios')),
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  apns_token TEXT NOT NULL,
  token_lookup TEXT NOT NULL,
  locale TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (bundle_id, token_lookup)
) STRICT;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices (id),
  installation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (device_id, installation_id, workspace_id),
  FOREIGN KEY (installation_id, workspace_id) REFERENCES workspaces (installation_id, workspace_id)
) STRICT;

CREATE INDEX subscriptions_recipient_idx ON subscriptions (installation_id, workspace_id, recipient_id);
