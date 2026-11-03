/**
 * Password hashing, tokens, and the RBAC policy arrive in Milestone 1a. The role table is here now
 * because it is pure data, and later milestones build on it. See docs/architecture/security.md.
 */
export const ROLES = ['owner', 'admin', 'supervisor', 'agent'] as const;
export type Role = (typeof ROLES)[number];
