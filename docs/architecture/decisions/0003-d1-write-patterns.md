# ADR-0003: D1 writes use batches, SQL conditions, and an outbox

**Status:** Accepted. **Date:** 2026-11-03.

## Context

D1 offers no interactive transactions, only an atomic `batch()` with no application logic between statements. Queue sends cannot join a D1 transaction.

## Decision

1. Every invariant is expressed inside the batch, in SQL.
2. Follow-up statements are guarded by a value unique to the request: a fresh row ID or `last_mutation_id`. **Not** by a computed version, which a prototype showed can match another writer's update.
3. Side effects go through a transactional outbox: written in the batch, dispatched in `waitUntil`, and swept by cron.
4. Ordering comes from `seq`, and for visitors `public_seq`, assigned in SQL.

## Consequences

- Duplicates can occur downstream, so all consumers are idempotent.
- There is one extra write per message to mark the outbox row dispatched.
- Moving tables to another database later would break atomic batches, which limits how D1 can be sharded.

Worked patterns and test results: [data model](../data-model.md#write-patterns).
