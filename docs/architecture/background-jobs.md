# Queues, outbox, and cron

## Delivery model

Queues are at-least-once, with no ordering assumption. There is no atomic "commit to D1 and send to a queue", so:

```text
D1 batch: domain write + outbox row       (atomic)
          |
          v  waitUntil, fast path, usually under a second
   publish to Durable Objects + queue.sendBatch + mark outbox dispatched
          |
          |  if the isolate dies, or the queue send fails
          v
   cron every minute: rows undispatched for over 60 s  ->  same dispatch
          |
          v
   Queue consumer: idempotent, explicit ack or retry
          |
          v  after max_retries
   DLQ consumer: writes failed_jobs, emits metric, acks
```

Duplicates are possible at every arrow, and consumers must tolerate them. Sockets dedupe by message ID, and the relay and email layers by dedupe key.

Until push arrives in M3, dispatch means publishing to Durable Objects only. The fast path finds rows by the ID of what was just written, so replaying a send also finishes a dispatch that died.

## Queues

Three queues plus DLQs, not one per job type. Few queues keep self-hosted setup simple, and job types share retry behaviour within each group.

| Queue | Job types | `max_batch_size` | `max_batch_timeout` | `max_retries` | `max_concurrency` |
|---|---|---|---|---|---|
| `oc-notifications` | `notification.fanout`, `notification.dispatch` | 25 | 1 s | 8 | 20 |
| `oc-email` | System email (`auth.password_reset_email`, `workspace.invitation_email`) | No delivery row, because the token is created at send time. Each attempt has a new token and so a new provider idempotency key, since Resend refuses a reused key with a changed body. A crash after sending can deliver two emails, and failures of any kind retry and then dead-letter. |
| `email.send` | 10 | 5 s | 8 | 5 |
| `oc-jobs` | `attachment.process`, `automation.evaluate`, `webhook.deliver` (later), `workspace.purge`, `analytics.rollup` | 10 | 5 s | 5 | 10 |
| `*-dlq` | All of the above | 25 | 30 s | 3 | 1 |

These values are starting points to be tuned from Milestone 3 and 4 measurements. `max_retries` is set explicitly everywhere, because the default is 3 and messages are **deleted** if retries run out without a DLQ. CI validates that every consumer has a DLQ configured.

Retention is set to the 14-day maximum on Workers Paid.

## Job envelope

Defined in `packages/shared`, under 128 KB, and carrying IDs rather than content.

```typescript
interface JobEnvelope<T = unknown> {
  v: 1;
  type: string;
  id: string;                 // job ID
  idempotencyKey: string;     // stable across retries and re-dispatches
  workspaceId: string | null;
  occurredAt: string;
  notAfter?: string;          // drop the job if processed later than this
  payload: T;                 // IDs only, never message content or email addresses
}
```

Consumers read current state from D1 at processing time. So a job for a since-resolved conversation can correctly do nothing.

## Consumer rules

```typescript
async queue(batch, env, ctx) {
  for (const msg of batch.messages) {
    try {
      await handle(msg.body);
      msg.ack();
    } catch (err) {
      if (isPermanent(err)) { await recordFailure(msg, err); msg.ack(); continue; }
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}
// backoff: min(3600, 5 * 2^attempts) seconds, with +/- 20% jitter
```

1. **Acknowledge per message.** Otherwise one bad message causes a retry of the whole batch.
2. **Classify errors.** A permanent failure such as validation or a 4xx does not retry. Transient ones do.
3. **Check `notAfter`.** A push about a message from four hours ago is noise, so it is dropped.
4. **Protect the database.** A D1 overload error is a retry with delay, not an immediate failure.

## Idempotency

Exactly-once is impossible for external effects, so each consumer aims for the narrowest possible duplicate window.

| Job | Mechanism | Remaining duplicate risk |
|---|---|---|
| `notification.dispatch` | Relay dedupes on `notificationId` for 72 hours | None within the window |
| `email.send` | Unique `email_deliveries (workspace_id, dedupe_key)`: claim, send, mark sent. Passes the idempotency key to providers that accept it | A crash between send and mark. If a row is `claimed` for over 15 minutes, the job resends only if the provider supports idempotency; otherwise it records `failed` for review, because a missed email is better than a duplicate follow-up |
| `automation.evaluate` | Unique `automation_runs (workspace_id, rule_id, conversation_id, trigger_key)` | None for the decision |
| Internal state | SQL conditions per the [write patterns](data-model.md#write-patterns), or `job_receipts` | None |

## Cron

One schedule, `* * * * *`, with a dispatcher inside. Each sweep is bounded and must finish within the 30-second CPU limit.

| Sweep | Frequency | Query | Action |
|---|---|---|---|
| Outbox | Every minute | `dispatched_at IS NULL AND created_at < now - 60 s LIMIT 200` | Re-dispatch. If `attempts` exceeds 20, raise an alert |
| Automation | Every minute | `next_automation_at <= now LIMIT 200` | Enqueue `automation.evaluate`; clear or advance the column |
| Attachment orphans | Hourly | Unattached and older than 24 h, `LIMIT 200` | Delete from R2, then the row |
| Token and session expiry | Hourly | Expired, in chunks | Delete |
| Outbox and receipt purge | Hourly | Older than 14 days, in chunks | Delete |
| Heartbeat | Every minute | | Record the time for `/health/queues` |

Sweeps from overlapping cron runs are harmless, because each action is idempotent. Sweep writes use small chunks, because D1 is shared with live traffic.

## Why follow-ups are database-driven

Queue delays cap at 24 hours and cannot be cancelled. A Durable Object alarm per conversation would mean a wake per conversation. Instead:

1. Each message update sets `next_automation_at` to `now + the workspace's shortest inactivity threshold` when the workspace has an enabled rule. Otherwise it stays NULL.
2. The sweep finds due conversations through a partial index, at a cost proportional to the work.
3. `automation.evaluate` reads fresh state, evaluates rules, and claims `automation_runs` using `last_message_seq` as the `trigger_key`. So one quiet period produces at most one follow-up, even with duplicates, and new activity naturally resets it.
4. It enqueues `email.send`, which re-checks consent and suppression immediately before sending.

Rule edits take effect at the next evaluation. If a threshold shrinks, conversations already scheduled are picked up later than the new threshold suggests. That is acceptable, and documented in the rule editor.

## Failure monitoring

- The DLQ consumer writes to `failed_jobs`, because a DLQ message only lasts as long as retention. Records hold IDs only.
- The dashboard's operator page lists failures and offers replay. Replay re-enqueues the envelope with the same idempotency key, so it remains safe.
- Metrics to Analytics Engine: processed, retried, and failed by job type; queue-to-completion latency; outbox age.
- `/health/queues` reports the last cron heartbeat, the oldest undispatched outbox row, and unreviewed `failed_jobs`. Actual queue depth is on Cloudflare's dashboard and GraphQL API, since the binding does not expose it.

## Limits to respect

| Limit | Handling |
|---|---|
| `sendBatch`: 100 messages or 256 KB | Chunk in the `JobQueue` adapter |
| 5,000 messages/s per queue; `Too Many Requests` beyond | Treated as a failed dispatch; the outbox sweep recovers it |
| 6 simultaneous connections per invocation | Relay and email fan-out use a concurrency of 6 |
| Multi-tenant fairness | No per-tenant queues. Limit each workspace at the source. Revisit if one tenant's backlog affects others |
