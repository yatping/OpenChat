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

/** `display_name` is no longer written, and goes in a later migration. */
export async function upsertWorkspace(db: D1Database, input: { installationId: string; workspaceId: string; now: number }): Promise<'created' | 'updated'> {
  const { installationId, workspaceId, now } = input;
  const existing = await db.prepare('SELECT 1 FROM workspaces WHERE installation_id = ? AND workspace_id = ?').bind(installationId, workspaceId).first();
  await db
    .prepare(
      `INSERT INTO workspaces (installation_id, workspace_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (installation_id, workspace_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
    )
    .bind(installationId, workspaceId, now)
    .run();
  return existing ? 'updated' : 'created';
}

/** Stops delivery and removes the workspace's subscriptions, in one batch, so that none can be left behind. */
export async function revokeWorkspace(db: D1Database, installationId: string, workspaceId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE workspaces SET status = 'revoked', updated_at = ? WHERE installation_id = ? AND workspace_id = ?`).bind(now, installationId, workspaceId),
    db.prepare('DELETE FROM subscriptions WHERE installation_id = ? AND workspace_id = ?').bind(installationId, workspaceId),
  ]);
}

export async function isWorkspaceActive(db: D1Database, installationId: string, workspaceId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM workspaces WHERE installation_id = ? AND workspace_id = ? AND status = 'active'`).bind(installationId, workspaceId).first()) !== null;
}

/** Signing out leaves a device with no subscription. If it is not used again in this time, it is deleted. */
export const ORPHAN_DEVICE_TTL_MS = 7 * 24 * 60 * 60_000;

export interface Erasure {
  installation: boolean;
  workspaces: number;
  subscriptions: number;
  devices: number;
  notifications: number;
}

/**
 * Everything the relay holds for an installation, in one batch: its key, its workspaces, its subscriptions, its
 * delivery records, and every device left with no subscription. It can register again afterwards, as a stranger
 * would. Answers what was deleted. See docs/notification-relay/protocol.md#erasure.
 */
export async function eraseInstallation(db: D1Database, installationId: string): Promise<Erasure> {
  const results = await db.batch([
    db.prepare('DELETE FROM notifications WHERE installation_id = ?').bind(installationId),
    db.prepare('DELETE FROM subscriptions WHERE installation_id = ?').bind(installationId),
    // Every batch commits whole, so no device is caught between registering and subscribing. One left with nothing
    // was this installation's, or signed out of everything, and the daily cleanup would delete it anyway.
    db.prepare('DELETE FROM devices WHERE id NOT IN (SELECT device_id FROM subscriptions)'),
    db.prepare('DELETE FROM workspaces WHERE installation_id = ?').bind(installationId),
    db.prepare('DELETE FROM installation_keys WHERE installation_id = ?').bind(installationId),
    db.prepare('DELETE FROM installations WHERE id = ?').bind(installationId),
  ]);
  const changes = (i: number) => results[i]?.meta.changes ?? 0;
  return { notifications: changes(0), subscriptions: changes(1), devices: changes(2), workspaces: changes(3), installation: changes(5) > 0 };
}

/** Daily. Devices that signed out of everything and were not used again. */
export async function deleteOrphanDevices(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM devices WHERE id NOT IN (SELECT device_id FROM subscriptions) AND updated_at < ?').bind(now - ORPHAN_DEVICE_TTL_MS).run();
  return result.meta.changes;
}
