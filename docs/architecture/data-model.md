# Data model and D1 design

The schema is [`packages/database/src/schema/index.ts`](../../packages/database/src/schema/index.ts), and the generated migrations sit beside it. The tests under [Verification](#verification) run in workerd against those migrations, and spike S4 repeated the key ones on real D1 ([results](cloudflare-validation.md#phase-0-spike-results)).

## Principles

- **D1 is the source of truth.** Durable Objects, queues, and the relay hold nothing that cannot be rebuilt.
- **One database per installation for the MVP.** Static bindings make per-tenant databases awkward, and the 1,000 queries/s ballpark is enough for early installations.
- **Tenant boundaries are enforced by the schema**, not just by application code.

## Identifiers and time

| Item | Decision | Reason |
|---|---|---|
| IDs | `<prefix>_<26 chars>`: Crockford base32 of a UUIDv7, for example `conv_01JCQ...` | Time-sorted primary keys keep B-tree writes local. The prefix makes logs readable and catches mistakes. Generated in `packages/shared`, because `randomUUIDv7` is unavailable in Workers. |
| Tenant identifier in a record | `workspace_id` on every workspace-owned table | Spec requirement |
| Timestamps | INTEGER milliseconds UTC in the database, RFC 3339 in the API | Compact and sortable |
| Clock for cursors | Columns used as sync cursors take their time from the database in SQL | Worker clocks at different edge locations can disagree, and a cursor based on them can skip rows. Sync also overlaps its cursor by 5 seconds. Confirm SQL function support on D1 in S4. |

## Schema notes

Beyond the spec's entities, the schema adds what stated requirements need:

| Addition | Requirement it serves |
|---|---|
| `installation` | Which relay has accepted it, and which one an admin disconnected from (`relay_disconnected_id`, which turns push off while that relay is configured), public URL. `signup_policy` is no longer read ([ADR-0016](decisions/0016-installation-admin-replaces-workspace-managers.md)) |
| `auth_sessions`, `auth_tokens` | Sessions, refresh tokens, reset, verification. `invitations` is unused, and stays until a later migration removes it |
| `visitors` | Multiple devices per contact; contact merge |
| `messages.seq`, `public_seq`, `visibility`, `client_message_id` | Ordering, note isolation, idempotency |
| `conversation_read_cursors` | Delivered and read status without one row per message and reader |
| `conversations.version`, `last_mutation_id` | Optimistic concurrency without interactive transactions |
| `auth_tokens.consumed_by` | The same guard for one-time tokens: later statements in a reset batch apply only to the attempt that spent the token |
| `conversations.next_automation_at` | Inactivity detection without table scans |
| `tags`, `conversation_tags`, `contact_tags` | Tagging |
| `push_subscriptions` | Replaces `Devices`. Holds handles, never APNs tokens, and `preview_key`, the phone's public key that each notification is encrypted to ([ADR-0017](decisions/0017-encrypted-notifications.md)). Migration `0010` deleted rows without one. `workspaces.relay_display_name` is no longer used, and goes in a later migration |
| `email_suppressions`, `email_deliveries` | Suppression and duplicate prevention |
| `email_unsubscribe_links` | One row per link sent, with a hash of its token. Contact erasure must remove these too |
| `contacts.follow_up_consent_*` | Consent evidence |
| `automation_runs` | At most one follow-up per rule and quiet period |
| `outbox`, `job_receipts`, `failed_jobs` | Reliable dispatch, consumer idempotency, durable failure records |
| `audit_log` | §18 |

### Tables without `workspace_id`

`installation`, `users`, `auth_sessions`, `auth_tokens`, `workspaces`, `job_receipts`, `failed_jobs`. This list is the allowlist for the CI check that every other table has the column. `outbox`, `audit_log`, and others do carry it.

Users are global to an installation, because one person can be a member of several workspaces.

Neither users nor members are deleted, because messages find their author through them. `users.disabled_at` marks a deactivated account and `workspace_members.removed_at` a removed member, whose `status` is also `suspended` so that every access check refuses them. Both can be undone ([ADR-0015](decisions/0015-installation-admin-and-reversible-removal.md)).

## Write patterns

D1 has no interactive transactions. A `batch()` commits atomically, but JavaScript cannot act between its statements. Therefore **all conditions must be expressed in SQL**, and a statement must be able to tell whether an earlier one in the batch took effect.

### Pattern 1: idempotent message insert

```sql
-- batch([...]) with $mid a freshly generated message ID
INSERT INTO messages (id, workspace_id, conversation_id, seq, public_seq, client_message_id, visibility, ...)
  SELECT $mid, c.workspace_id, c.id, c.last_message_seq + 1,
         CASE WHEN $vis = 'public' THEN c.last_public_seq + 1 END, $clientId, $vis, ...
  FROM conversations c WHERE c.workspace_id = $w AND c.id = $c
  ON CONFLICT (workspace_id, conversation_id, client_message_id) DO NOTHING;

UPDATE conversations
   SET last_message_seq = last_message_seq + 1,
       last_public_seq = last_public_seq + CASE WHEN $vis = 'public' THEN 1 ELSE 0 END,
       last_message_at = $now, version = version + 1, updated_at = $now
 WHERE workspace_id = $w AND id = $c
   AND EXISTS (SELECT 1 FROM messages m WHERE m.id = $mid);

INSERT INTO outbox (id, workspace_id, topic, aggregate_id, payload_json, created_at)
  SELECT $oid, m.workspace_id, 'message.created', m.id, $payload, $now
  FROM messages m WHERE m.id = $mid;
```

- The freshly generated `$mid` exists only if the insert took effect, which guards the two later statements.
- A replay of the same `clientMessageId` changes nothing. `meta.changes = 0` on the first statement tells the handler to read and return the original message with 200, not 201.
- A wrong workspace or conversation also changes nothing, so the handler returns 404.
- Because D1 executes one batch at a time, `seq` cannot collide. The unique index is a second safeguard.
- **Two sequences.** Agents use `seq`, covering everything. Visitors see `public_seq` under the name `seq`. Internal notes do not consume it, because gaps would let a visitor count private notes and would break gap detection in the widget.

A visitor's first message also creates the conversation, in the same batch. The conversation's ID is derived from the visitor and the `clientMessageId`, so a retry reaches the same row and becomes a replay. Those IDs are not time-sorted, which matters less here than a retry never creating a second conversation.

### Pattern 2: compare-and-set with a follow-up statement

```sql
UPDATE conversations
   SET assigned_member_id = $m, version = version + 1, last_mutation_id = $mutation, updated_at = $now
 WHERE workspace_id = $w AND id = $c AND version = $expected;

INSERT INTO conversation_events (id, workspace_id, conversation_id, event_type, ...)
  SELECT $eid, workspace_id, id, 'assigned', ...
  FROM conversations WHERE workspace_id = $w AND id = $c AND last_mutation_id = $mutation;
```

If the update changed no rows, the API returns 409 with the current version.

> **Do not guard follow-up statements with `version = $expected + 1`.** A prototype did this and failed: when a concurrent writer has already advanced the version, the stale request's update correctly does nothing, but its follow-up still matches and writes a false audit event. `last_mutation_id` is unique to the request, so it can only match the request's own update. `changes()` might also work, but its behaviour across D1 batch statements is not documented, so it is not used.

### Pattern 2a: the audit row as the guard

For a table with no `last_mutation_id`, such as `workspace_members`, the first statement inserts an audit row with `INSERT ... SELECT ... WHERE <the rule>`, using a fresh ID. Later statements check that this row exists. The action and its audit record therefore cannot disagree, and a refused action leaves no trace. `consumed_by` on `auth_tokens` does the same job for one-time tokens.

### Pattern 3: reads that inform a write

Authorisation reads happen before the batch, and that is acceptable because the batch re-checks tenancy in its own SQL. A membership revoked in the gap between the two allows at most one further write. Where that matters, such as last-owner protection, the rule goes in the statement's `WHERE` clause.

## Concurrency and capacity rules

| Rule | Reason |
|---|---|
| Hot path is one batch per message | Round trips cost more than statements |
| Target under 5 ms per query, alert above 20 ms at p95 | One query at a time means slow queries delay every tenant |
| Keyset pagination only, no `OFFSET` | `OFFSET` scans |
| No unbounded `UPDATE` or `DELETE`; chunk with `WHERE id IN (SELECT id ... LIMIT 500)` and continue in a queue job | Long statements block everything. This includes **workspace deletion**: cascades over a large tenant must be chunked, even though the schema supports a single cascade |
| At most 100 bound parameters; chunk `IN` lists | Limit |
| Message content capped at 16 KB, JSON columns at 16 KB | Well under the 2 MB row limit |
| Retry only on transient errors, and only for idempotent statements, at most twice with jitter | Retrying under overload makes it worse. Surface 503 with `Retry-After` |
| `next_automation_at`, `outbox` scans use partial indexes | Keeps sweeps cheap as tables grow |

### Read replication

Off for the MVP. Queries go through a `DatabaseProvider` so that `withSession()` and bookmarks can be added later. When enabled, read-your-writes requires a bookmark to travel with the client, which the API could return in a header.

### Reaching the 10 GB limit

1. Expose database size at `/health/database` to operators, and alert at 70%.
2. After MVP, archive old conversations to R2 as NDJSON and delete in chunks. A retention setting per workspace comes with Milestone 6.
3. Move message bodies to a second D1 database if necessary. The repository layer hides this, though `batch()` cannot span two databases, so that move needs a redesign of Pattern 1. Treat it as a major change, not a tuning step.

## Migration strategy

**Pipeline**

1. Edit the Drizzle schema in `packages/database/src/schema`.
2. `pnpm db:generate` writes SQL to `packages/database/migrations`. Reviewed and committed like code. CI fails if the schema and migrations disagree.
3. Apply with `wrangler d1 migrations apply`, set up with `migrations_dir`. Drizzle's flat output needs no `migrations_pattern`.

S8 confirmed this pipeline on local and real D1. Drizzle expresses partial indexes, descending index columns (through `sql` fragments), and `COLLATE NOCASE` (through a custom type), so no hand-written migrations are needed so far. It cannot express `WITHOUT ROWID`, so the tables that used it in the draft are ordinary rowid tables. That costs a little space and lookup speed on small association tables and changes no behaviour. If it ever matters, a custom migration can rebuild those tables.

**Compatibility rules**

A migration and a Worker deploy are not atomic, and rollback restores code but not schema. So every migration must work with both the previous and next Worker versions:

| Change | How |
|---|---|
| Add column | Nullable or with a default. Backfill through a job. Then begin using it. |
| Remove column | Stop reading, deploy; stop writing, deploy; drop in a later release. |
| Rename | Add new, write both, backfill, switch reads, drop old. Never rename directly. |
| Table rebuild | Avoid. If unavoidable, use `PRAGMA defer_foreign_keys = on`, and never `PRAGMA foreign_keys = off`, since D1 does not allow changing it. Beware that `DROP TABLE` runs an implicit delete with cascades; test on a copy. |
| Large backfill | A chunked queue job, never a migration, because a query is limited to 30 seconds and blocks other work. |

**Self-hosted upgrades.** Customers may skip versions, so migrations always run in order and contract steps are never squashed into the expand release. The compatibility window is documented per release.

**Safety.** The deploy CLI records `wrangler d1 time-travel info` output before applying migrations, and prints the restore command. Restores are destructive and also discard messages written since that point, so they are a last resort. Prefer forward fixes.

**Failure behaviour.** Cloudflare's documentation does not state whether a failed migration file rolls back, so S4 tests this. Until confirmed, migrations are single-purpose and small.

## Verification

Run on Node's SQLite with `PRAGMA foreign_keys = ON` on 2026-11-03. These establish that the SQL is correct. They do not show D1 behaviour or performance.

| Scenario | Result |
|---|---|
| Send two messages | `seq` 1 and 2, conversation counter 2, two outbox rows |
| Public, internal note, public | `seq` 1, 2, 3 and `public_seq` 1, NULL, 2, with no gap visible to the visitor |
| Replay a `clientMessageId` | Zero changes in all three statements |
| Send with the wrong workspace | Zero changes in all three statements |
| Reference another tenant's parent (messages, contacts) | Blocked by the foreign key |
| Internal note marked public; public message marked internal; visitor-authored note | Blocked by `CHECK` |
| Stale compare-and-set | Zero rows updated, and no event written |
| Delete a conversation; delete a workspace | Cascades complete and leave other tenants intact |
| Inbox, assignee, history, public history, sync, automation, and outbox query plans | Index search, no temp B-tree, no scan |
| All 29 tables | Every table outside the allowlist has `workspace_id` |

In addition, `toVisitorEvent` from the [draft contract](../api/realtime-protocol.draft.ts) was run directly. Notes and assignment changes map to nothing, and output contains no member IDs, metadata, or `visibility`. Sequence and read positions use `public_seq` values only.
