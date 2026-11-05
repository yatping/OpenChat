import { rawHandle, type Database } from './internal/handle';
import { effectiveRole } from './internal/roles';

export type Role = 'supervisor' | 'agent';

declare const contextBrand: unique symbol;

/**
 * Proof that a user's active membership was checked. The type cannot be constructed outside this
 * file, so a repository can only be reached after authorisation. See ADR-0004.
 */
export interface WorkspaceContext {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly role: Role;
  readonly [contextBrand]: true;
}

/** Returns null for no membership, a suspended one, a disabled user, or an unknown workspace. */
export async function authorizeWorkspaceMember(
  database: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  const row = await rawHandle(database)
    .prepare(
      `SELECT m.id AS member_id, ${effectiveRole('m')} AS role
         FROM workspace_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ?1 AND m.user_id = ?2 AND m.status = 'active' AND u.disabled_at IS NULL`,
    )
    .bind(workspaceId, userId)
    .first<{ member_id: string; role: Role }>();
  if (!row) return null;
  return { workspaceId, memberId: row.member_id, role: row.role } as WorkspaceContext;
}
