import { newId } from '@openchat/shared';
import { DB_NOW_MS } from './handle';

/**
 * Removing keeps the member row, because messages find their author through it, and suspending it is what
 * every access check already understands. Runs only if the audit row was written.
 */
export function removeMembershipStatements(d1: D1Database, workspaceId: string, memberId: string, auditId: string): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`;
  return [
    d1
      .prepare(
        `UPDATE conversations SET assigned_member_id = NULL, version = version + 1, updated_at = ${DB_NOW_MS}
          WHERE workspace_id = ?1 AND assigned_member_id = ?2 AND ${guard}`,
      )
      .bind(workspaceId, memberId, auditId),
    // A removed member must get no more notifications. These cascaded when the row was deleted.
    d1.prepare(`DELETE FROM push_subscriptions WHERE workspace_id = ?1 AND member_id = ?2 AND ${guard}`).bind(workspaceId, memberId, auditId),
    d1
      .prepare(
        `UPDATE workspace_members SET status = 'suspended', removed_at = COALESCE(removed_at, ${DB_NOW_MS}), updated_at = ${DB_NOW_MS}
          WHERE workspace_id = ?1 AND id = ?2 AND ${guard}`,
      )
      .bind(workspaceId, memberId, auditId),
    accessChangedStatement(d1, workspaceId, memberId, auditId),
  ];
}

/** So that the member's sockets close even if the isolate dies right after the commit. */
export function accessChangedStatement(d1: D1Database, workspaceId: string, memberId: string, auditId: string): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
       SELECT ?1, ?2, 'member.access_changed', ?3, json_object('memberId', ?3), ${DB_NOW_MS} WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?4)`,
    )
    .bind(newId('outbox'), workspaceId, memberId, auditId);
}
