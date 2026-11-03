# ADR-0004: Layered tenant isolation

**Status:** Accepted. **Date:** 2026-11-03.

## Context

D1 has no row-level security, and a shared database means one missed `WHERE` clause can expose another tenant's data.

## Decision

Five layers, in [security](../security.md#tenant-isolation): branded context type, scoped repositories with a private raw handle, composite foreign keys, a route-enumerating isolation test, and scoped non-SQL stores. Cross-tenant access returns 404.

## Consequences

- Every child table needs `UNIQUE (workspace_id, id)` on its parent and two-column foreign keys, which costs a little storage.
- `ON DELETE SET NULL` cannot be used on composite keys, because it would also null `workspace_id`.
- System jobs need an explicit, reviewable escape hatch.
