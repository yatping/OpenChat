-- Local development data only. Applied by pnpm dev:setup. The password hash is not a real hash:
-- nobody can sign in with it, and authentication arrives in Milestone 1a.
INSERT OR IGNORE INTO installation (id, name, public_base_url, created_at, updated_at)
VALUES ('inst_00000000000000000000000DEV', 'OpenChat local', 'http://localhost:8787', 0, 0);
INSERT OR IGNORE INTO users (id, email, name, password_hash, created_at, updated_at)
VALUES ('user_00000000000000000000000DEV', 'owner@example.com', 'Local Owner', '!', 0, 0);
INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
VALUES ('work_00000000000000000000000DEV', 'Local workspace', 'local', 0, 0);
INSERT OR IGNORE INTO workspace_members (id, workspace_id, user_id, role, created_at, updated_at)
VALUES ('mem_00000000000000000000000DEV', 'work_00000000000000000000000DEV', 'user_00000000000000000000000DEV', 'owner', 0, 0);
