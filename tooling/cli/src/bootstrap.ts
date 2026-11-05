/**
 * SQL for first-time setup and account recovery. These run through `wrangler d1 execute`, because the operator
 * who holds Cloudflare access already holds the database. Only token hashes appear in this SQL.
 */
import { newId } from '@openchat/shared';

export const OWNER_LINK_TTL_MS = 60 * 60 * 1000;
const NOW = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Validates here as well as in the API, because this SQL does not pass through the API's contracts. */
export function assertEmail(email: string): void {
  if (!/^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email) || email.length > 320) throw new Error(`Not a usable email address: ${email}`);
}

function assertName(label: string, value: string): void {
  if (value.trim() === '' || value.length > 100 || /\p{Cc}/u.test(value)) throw new Error(`${label} must be 1 to 100 characters, with no control characters`);
}

export function assertPublicUrl(url: string): void {
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:' || new URL(url).origin !== url) throw new Error('The public URL must be an https origin, such as https://chat.example.com');
}

export interface BootstrapInput {
  installationName: string;
  publicBaseUrl: string;
  ownerEmail: string;
  ownerName: string;
  workspaceName: string;
  ownerTokenHash: string;
}

/**
 * The owner is the first installation admin, and a supervisor of the first workspace so that they can use its
 * inbox. They start with an unusable password hash and set one through a reset link, so no password passes
 * through a command line or a shell history. Each row depends on the installation row being new.
 */
export function bootstrapSql(input: BootstrapInput): string {
  assertEmail(input.ownerEmail);
  assertName('The installation name', input.installationName);
  assertName('The owner name', input.ownerName);
  assertName('The workspace name', input.workspaceName);
  assertPublicUrl(input.publicBaseUrl);
  const installation = newId('installation');
  const user = newId('user');
  const workspace = newId('workspace');
  const member = newId('member');
  const slug = `${input.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace'}-${workspace.slice(-8).toLowerCase()}`;
  const isNew = `(SELECT id FROM installation) = ${quote(installation)}`;
  return [
    `INSERT INTO installation (id, name, public_base_url, signup_policy, created_at, updated_at) SELECT ${quote(installation)}, ${quote(input.installationName)}, ${quote(input.publicBaseUrl)}, 'invite_only', ${NOW}, ${NOW} WHERE NOT EXISTS (SELECT 1 FROM installation)`,
    `INSERT INTO users (id, email, name, password_hash, is_installation_admin, created_at, updated_at) SELECT ${quote(user)}, ${quote(input.ownerEmail)}, ${quote(input.ownerName)}, '!', 1, ${NOW}, ${NOW} WHERE ${isNew}`,
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at) SELECT ${quote(workspace)}, ${quote(input.workspaceName)}, ${quote(slug)}, ${NOW}, ${NOW} WHERE ${isNew}`,
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at) SELECT ${quote(member)}, ${quote(workspace)}, ${quote(user)}, 'supervisor', 'active', ${NOW}, ${NOW} WHERE ${isNew}`,
    `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) SELECT ${quote(input.ownerTokenHash)}, ${quote(user)}, 'password_reset', ${NOW} + ${OWNER_LINK_TTL_MS} WHERE ${isNew}`,
  ].join('; ');
}

/** Issues a reset token with no email involved. Using it revokes the account's sessions, as any reset does. */
export function recoverySql(email: string, tokenHash: string): string {
  assertEmail(email);
  return `INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) SELECT ${quote(tokenHash)}, id, 'password_reset', ${NOW} + ${OWNER_LINK_TTL_MS} FROM users WHERE email = ${quote(email)} AND disabled_at IS NULL`;
}

export const resetLink = (publicBaseUrl: string, token: string) => `${publicBaseUrl}/reset-password#token=${token}`;
