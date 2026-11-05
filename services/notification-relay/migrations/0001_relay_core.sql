-- The relay's own database. No messages, names, or email addresses, ever. See docs/notification-relay/protocol.md.
CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE installation_keys (
  installation_id TEXT NOT NULL REFERENCES installations (id),
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, key_id)
) STRICT;

CREATE TABLE workspaces (
  installation_id TEXT NOT NULL REFERENCES installations (id),
  workspace_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, workspace_id)
) STRICT;
