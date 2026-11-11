/**
 * D1 has no interactive transactions, so each change is one batch, with its conditions in SQL. Queries on behalf of
 * an installation always filter by its ID.
 */
export interface NewDevice {
  newDeviceId: string;
  secretHash: string;
  bundleId: string;
  environment: 'sandbox' | 'production';
  encryptedToken: string;
  lookup: string;
  now: number;
}

export interface NewSubscription {
  subscriptionId: string;
  installationId: string;
  workspaceId: string;
  recipientId: string;
  now: number;
}

const deleteOtherHolderOfToken = (db: D1Database, device: Pick<NewDevice, 'bundleId' | 'lookup'>, keepId: string) => [
  db.prepare('DELETE FROM subscriptions WHERE device_id IN (SELECT id FROM devices WHERE bundle_id = ? AND token_lookup = ? AND id <> ?)').bind(device.bundleId, device.lookup, keepId),
  db.prepare('DELETE FROM devices WHERE bundle_id = ? AND token_lookup = ? AND id <> ?').bind(device.bundleId, device.lookup, keepId),
];

/**
 * A new subscription, only if the workspace is still active when this commits. A different member on the same device
 * gets a new subscription ID, so the installation cannot keep treating it as the previous member's.
 */
const upsertSubscription = (db: D1Database, deviceId: string, sub: NewSubscription) =>
  db
    .prepare(
      `INSERT INTO subscriptions (id, device_id, installation_id, workspace_id, recipient_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE EXISTS (SELECT 1 FROM devices WHERE id = ?2)
         AND EXISTS (SELECT 1 FROM workspaces w JOIN installations i ON i.id = w.installation_id
                     WHERE w.installation_id = ?3 AND w.workspace_id = ?4 AND w.status = 'active' AND i.status = 'active')
       ON CONFLICT (device_id, installation_id, workspace_id) DO UPDATE SET
         id = CASE WHEN recipient_id = excluded.recipient_id THEN id ELSE excluded.id END,
         recipient_id = excluded.recipient_id,
         muted = CASE WHEN recipient_id = excluded.recipient_id THEN muted ELSE 0 END`,
    )
    .bind(sub.subscriptionId, deviceId, sub.installationId, sub.workspaceId, sub.recipientId, sub.now);

const readSubscription = (db: D1Database, deviceId: string, sub: NewSubscription) =>
  db.prepare('SELECT id FROM subscriptions WHERE device_id = ? AND installation_id = ? AND workspace_id = ?').bind(deviceId, sub.installationId, sub.workspaceId);

/**
 * A device with no proof of who it was, holding a token already on file. Holding the token is the proof: it is an app
 * reinstalled, or a phone passed on. So it gets a new secret, and what the earlier user subscribed to is removed.
 */
export async function registerAnonymousDevice(db: D1Database, device: NewDevice, sub: NewSubscription): Promise<{ deviceId: string; subscriptionId: string | null }> {
  const results = await db.batch([
    db.prepare('DELETE FROM subscriptions WHERE device_id IN (SELECT id FROM devices WHERE bundle_id = ? AND token_lookup = ?)').bind(device.bundleId, device.lookup),
    db
      .prepare(
        // `locale` is no longer used, and is written empty until a later migration drops it.
        `INSERT INTO devices (id, secret_hash, platform, bundle_id, environment, apns_token, token_lookup, locale, created_at, updated_at)
         VALUES (?, ?, 'ios', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bundle_id, token_lookup) DO UPDATE SET secret_hash = excluded.secret_hash, environment = excluded.environment, apns_token = excluded.apns_token, updated_at = excluded.updated_at`,
      )
      .bind(device.newDeviceId, device.secretHash, device.bundleId, device.environment, device.encryptedToken, device.lookup, '', device.now, device.now),
    db.prepare('SELECT id FROM devices WHERE bundle_id = ? AND token_lookup = ?').bind(device.bundleId, device.lookup),
    db
      .prepare(
        `INSERT INTO subscriptions (id, device_id, installation_id, workspace_id, recipient_id, created_at)
         SELECT ?1, d.id, ?2, ?3, ?4, ?5 FROM devices d
         WHERE d.bundle_id = ?6 AND d.token_lookup = ?7
           AND EXISTS (SELECT 1 FROM workspaces w JOIN installations i ON i.id = w.installation_id
                       WHERE w.installation_id = ?2 AND w.workspace_id = ?3 AND w.status = 'active' AND i.status = 'active')`,
      )
      .bind(sub.subscriptionId, sub.installationId, sub.workspaceId, sub.recipientId, sub.now, device.bundleId, device.lookup),
    db.prepare('SELECT s.id FROM subscriptions s JOIN devices d ON d.id = s.device_id WHERE d.bundle_id = ? AND d.token_lookup = ? AND s.installation_id = ? AND s.workspace_id = ?').bind(device.bundleId, device.lookup, sub.installationId, sub.workspaceId),
  ]);
  const deviceId = (results[2]?.results[0] as { id: string }).id;
  const subscription = results[4]?.results[0] as { id: string } | undefined;
  return { deviceId, subscriptionId: subscription?.id ?? null };
}

export async function findDeviceSecret(db: D1Database, deviceId: string): Promise<{ secretHash: string; bundleId: string } | null> {
  return db.prepare('SELECT secret_hash AS secretHash, bundle_id AS bundleId FROM devices WHERE id = ?').bind(deviceId).first();
}

/** A known device's token may have changed, and another device row may hold that token after a restore. */
export async function updateDeviceToken(db: D1Database, deviceId: string, device: Pick<NewDevice, 'bundleId' | 'encryptedToken' | 'lookup' | 'now'> & { environment?: NewDevice['environment'] }): Promise<void> {
  await db.batch([
    ...deleteOtherHolderOfToken(db, device, deviceId),
    db
      .prepare('UPDATE devices SET apns_token = ?, token_lookup = ?, environment = COALESCE(?, environment), updated_at = ? WHERE id = ?')
      .bind(device.encryptedToken, device.lookup, device.environment ?? null, device.now, deviceId),
  ]);
}

export async function subscribeKnownDevice(db: D1Database, deviceId: string, device: Pick<NewDevice, 'bundleId' | 'encryptedToken' | 'lookup' | 'now' | 'environment'>, sub: NewSubscription): Promise<string | null> {
  const results = await db.batch([
    ...deleteOtherHolderOfToken(db, device, deviceId),
    db.prepare('UPDATE devices SET apns_token = ?, token_lookup = ?, environment = ?, updated_at = ? WHERE id = ?').bind(device.encryptedToken, device.lookup, device.environment, device.now, deviceId),
    upsertSubscription(db, deviceId, sub),
    readSubscription(db, deviceId, sub),
  ]);
  return (results[4]?.results[0] as { id: string } | undefined)?.id ?? null;
}

export async function removeOwnSubscription(db: D1Database, deviceId: string, subscriptionId: string): Promise<void> {
  await db.prepare('DELETE FROM subscriptions WHERE id = ? AND device_id = ?').bind(subscriptionId, deviceId).run();
}

export async function removeInstallationSubscription(db: D1Database, installationId: string, target: { subscriptionId: string } | { workspaceId: string; recipientId: string }): Promise<void> {
  if ('subscriptionId' in target) {
    await db.prepare('DELETE FROM subscriptions WHERE id = ? AND installation_id = ?').bind(target.subscriptionId, installationId).run();
  } else {
    await db.prepare('DELETE FROM subscriptions WHERE installation_id = ? AND workspace_id = ? AND recipient_id = ?').bind(installationId, target.workspaceId, target.recipientId).run();
  }
}
