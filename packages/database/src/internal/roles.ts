/**
 * A Worker from before migration 0004 can still write the old roles until the new one is live. They mean
 * supervisor now, so that no one is locked out of their inbox. Remove this in the migration that contracts the
 * CHECK constraint. See ADR-0016.
 */
export const effectiveRole = (member: string) => `CASE WHEN ${member}.role IN ('owner', 'admin') THEN 'supervisor' ELSE ${member}.role END`;
