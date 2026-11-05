/** All relay queries about installations. Every one is keyed by installation ID: a workspace ID means nothing alone. */
export interface InstallationKey {
  publicKey: string;
  baseUrl: string;
}

export async function findActiveKey(db: D1Database, installationId: string, keyId: string): Promise<InstallationKey | null> {
  const row = await db
    .prepare(
      `SELECT k.public_key AS publicKey, i.base_url AS baseUrl FROM installation_keys k
       JOIN installations i ON i.id = k.installation_id
       WHERE k.installation_id = ? AND k.key_id = ? AND k.status = 'active' AND i.status = 'active'`,
    )
    .bind(installationId, keyId)
    .first<InstallationKey>();
  return row ?? null;
}

export async function hasInstallation(db: D1Database, installationId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM installations WHERE id = ?').bind(installationId).first()) !== null;
}

/**
 * First registration wins, enforced in SQL because D1 has no interactive transactions. The key goes in only if
 * this installation row has this address and no key yet, so a lost race cannot attach a second key.
 */
export async function insertInstallation(db: D1Database, input: { installationId: string; baseUrl: string; keyId: string; publicKey: string; now: number }): Promise<void> {
  const { installationId, baseUrl, keyId, publicKey, now } = input;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO installations (id, base_url, created_at) VALUES (?, ?, ?)').bind(installationId, baseUrl, now),
    db
      .prepare(
        `INSERT INTO installation_keys (installation_id, key_id, public_key, created_at)
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM installations WHERE id = ?1 AND base_url = ?5)
           AND NOT EXISTS (SELECT 1 FROM installation_keys WHERE installation_id = ?1)`,
      )
      .bind(installationId, keyId, publicKey, now, baseUrl),
  ]);
}

export async function upsertWorkspace(db: D1Database, input: { installationId: string; workspaceId: string; displayName: string | null; now: number }): Promise<'created' | 'updated'> {
  const { installationId, workspaceId, displayName, now } = input;
  const existing = await db.prepare('SELECT 1 FROM workspaces WHERE installation_id = ? AND workspace_id = ?').bind(installationId, workspaceId).first();
  await db
    .prepare(
      `INSERT INTO workspaces (installation_id, workspace_id, display_name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (installation_id, workspace_id) DO UPDATE SET display_name = excluded.display_name, status = 'active', updated_at = excluded.updated_at`,
    )
    .bind(installationId, workspaceId, displayName, now)
    .run();
  return existing ? 'updated' : 'created';
}

export async function revokeWorkspace(db: D1Database, installationId: string, workspaceId: string, now: number): Promise<void> {
  await db.prepare(`UPDATE workspaces SET status = 'revoked', updated_at = ? WHERE installation_id = ? AND workspace_id = ?`).bind(now, installationId, workspaceId).run();
}

export async function isWorkspaceActive(db: D1Database, installationId: string, workspaceId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM workspaces WHERE installation_id = ? AND workspace_id = ? AND status = 'active'`).bind(installationId, workspaceId).first()) !== null;
}
