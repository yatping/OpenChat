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

With a relay configured, dispatch also queues the [push jobs](#push). Without one, it only publishes to Durable Objects. The fast path finds rows by the ID of what was just written, so replaying a send also finishes a dispatch that died.

## Queues

Three queues plus DLQs, not one per job type. Few queues keep self-hosted setup simple, and job types share retry behaviour within each group.

| Queue | Job types | `max_batch_size` | `max_batch_timeout` | `max_retries` | `max_concurrency` |
|---|---|---|---|---|---|
| `oc-notifications` | `notification.fanout`, `notification.dispatch`, `notification.unregister` | 25 | 1 s | 8 | 20 |
| `oc-email` | `email.follow_up`, `auth.password_reset_email`, `auth.new_account_email` | 10 | 5 s | 8 | 5 |
| `oc-jobs` | `attachment.process`, `automation.evaluate`, `webhook.deliver` (later), `workspace.purge`, `analytics.rollup` | 10 | 5 s | 5 | 10 |
| `*-dlq` | All of the above | 25 | 30 s | 3 | 1 |

Email jobs hold IDs only and read the address when sending. System email (`auth.password_reset_email`, `auth.new_account_email`) has no delivery row, because the token is created at send time. Each attempt has a new token and so a new provider idempotency key. A crash after sending can deliver two emails, and failures of any kind retry and then dead-letter.

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
| `notification.unregister` | Removing nothing still succeeds at the relay | None |
| `email.follow_up` | Unique `email_deliveries (workspace_id, dedupe_key)`: claim, send, mark sent. A row marked `failed` can be claimed again by a retry | Two. A crash between send and mark leaves the row `claimed`, and nothing sends again, because a missed email is better than a duplicate. An answer lost after Cloudflare accepted the send marks it `failed`, and the retry sends twice, because Cloudflare documents no idempotency key |
| `automation.evaluate` | Unique `automation_runs (workspace_id, rule_id, conversation_id, trigger_key)`. A repeat queues `email.follow_up` again, in case a crash came before it, and the claim there keeps it to one | None for the decision |
| Internal state | SQL conditions per the [write patterns](data-model.md#write-patterns), or `job_receipts` | None |

<a id="push"></a>
## Push

```text
outbox row -> dispatch -> notification.fanout -> notification.dispatch -> relay
                          (reads D1, decides)    (up to 50 people each)
```

A job lives for one hour, by `notAfter`. Each step may run twice, because `notificationId` is a hash of the event, its type, and the member, so the relay drops a repeat. Fan-out reads what is true when it runs, and carries IDs only.

| Event | Who gets a push | Type |
|---|---|---|
| A visitor's message | Whoever has the conversation, or every member if nobody does | `new_conversation` for the first message, otherwise `new_message` |
| A member's reply or internal note | Whoever has the conversation, unless they wrote it. Nobody, if nobody has it | `new_message` |
| An assignment | The person assigned, unless they did it themselves or it has changed since | `conversation_assigned` |
| A system message, or any other change | Nobody | |

Recipients are active members, with an active account and a device, who have not turned that event off. A member with no preference row gets everything. The text is generic, and composed by the relay.

**Registration is lazy.** The first grant registers the installation and workspace with the relay, and a sending job repeats whichever part is missing or out of date. So a rename reaches the notification title with the next push. A `401` or `403` from the relay on sending forgets the registration, so that the retry registers again, in case the relay lost its data.

**Losing access.** `member.access_changed` queues `notification.unregister`. If the member is no longer active, or has no live session, the job deletes their rows and tells the relay to remove them by recipient. Removing one device goes through an outbox row, `push.subscription_removed`, because the row with the handle is deleted in the same commit.

A relay that is down delays pushes and refuses new grants with `503`. Messaging does not call the relay at any point. A `429` retries after the relay's `Retry-After`, a request the relay calls malformed is recorded in `failed_jobs`, and anything else retries with backoff.

## Cron

One schedule, `* * * * *`, with a dispatcher inside. Each sweep is bounded and must finish within the 30-second CPU limit.

| Sweep | Frequency | Query | Action |
|---|---|---|---|
| Outbox | Every minute | `dispatched_at IS NULL AND created_at < now - 60 s LIMIT 200` | Re-dispatch. If `attempts` exceeds 20, raise an alert |
| Automation | Every minute | `next_automation_at <= now LIMIT 200` | Enqueue `automation.evaluate`; clear or advance the column |
| Attachment orphans | Hourly | Unattached and older than 24 h, `LIMIT 200` | Delete from R2, then the row |
| Outbox purge | Hourly | Dispatched more than 14 days ago, in chunks | Delete |
| Retention | Hourly | Expired sessions and tokens, old receipts and failed jobs, and anonymous visitors, then each workspace's setting, in chunks | Delete. See [retention](data-model.md#retention) |
| Heartbeat | Every minute | | Record the time for `/health/queues` |

Sweeps from overlapping cron runs are harmless, because each action is idempotent. Sweep writes use small chunks, because D1 is shared with live traffic.

## What email is for

By the owner's decision ([amendment A15](spec-review.md#amendments-to-the-specification)), email has two uses: follow-ups to visitors who have gone quiet, and account email such as password resets. Members hear about conversations through push, not email. Job types from before, `email.alert` and `email.send`, are acknowledged and dropped, in case a Worker from before a deploy queues one.

## Consent and unsubscribe

Follow-ups need both consent and an address not on the list. [Follow-up automation](#why-follow-ups-are-database-driven) checks both just before sending.

- **Consent** comes from an unticked box in the widget, stored with its time and source. It belongs to one address, so a different address, set by the visitor or by a member, clears it.
- **An unsubscribe link** is a random token, new for each email, and only its hash is stored, in `email_unsubscribe_links`. It holds no personal data, needs no sign-in, and outlives any signing key. Opening it changes nothing, because mail scanners open links. Confirming it on the page, or one click in a mail app (RFC 8058), lists the address and clears its consent, in that workspace only.
- **The list** is `email_suppressions`. Supervisors can see it, add to it, and remove what was added by hand. An address that unsubscribed stays, and ticking the box again does not lift it, because an address typed into the widget is unverified.
- **Bounces and complaints** are kept by Cloudflare in a list of its own, and a send to such an address fails with `E_RECIPIENT_SUPPRESSED`. That is recorded as `suppressed` and not retried. The `bounce` and `complaint` reasons in our list are unused for now, because subscribing to Cloudflare's events is not built.

## Why follow-ups are database-driven

Queue delays cap at 24 hours and cannot be cancelled. A Durable Object alarm per conversation would mean a wake per conversation. Instead:

1. Each public message sets `next_automation_at` to `now + the workspace's shortest inactivity threshold` when the workspace has an enabled rule. Otherwise it becomes NULL. An internal note changes nothing, because the visitor never saw it.
2. The sweep finds due conversations through a partial index, at a cost proportional to the work.
3. `automation.evaluate` reads fresh state, evaluates rules, and claims `automation_runs` using `last_public_seq` as the `trigger_key`. So one quiet period produces at most one follow-up per rule, even with duplicates, and a new public message resets it. A rule with a longer wait sets the column again, for later.
4. It enqueues `email.follow_up`, which re-checks the rule, the conversation, the address, consent, and suppression immediately before sending.

Nothing here knows about browsers or sockets, so a disconnect alone triggers nothing.

Rule edits take effect at the next evaluation. A new rule, or a threshold that shrinks, reaches a conversation only after its next public message or its next scheduled check. That is acceptable, and the rule editor says so.

Follow-ups use one fixed template, in `packages/core/src/email-templates.ts`, with no message text. Its link goes to the website's first allowed origin.

## Failure monitoring

- The DLQ consumer writes to `failed_jobs`, because a DLQ message only lasts as long as retention. Records hold IDs only.
- The dashboard's **Failed jobs** page, for installation admins, lists failures newest first: the job type, workspace, attempts, and when. It never shows the envelope. Built in M6.
- **Replay** marks the record replayed, then sends the stored envelope, unchanged and with the same idempotency key, to the queue it came from: a `-dlq` name maps back to its original. A send that fails clears the mark, so it can be tried again. A record replays once; a job that fails again is recorded anew. Refused with `409 not_replayable` when the envelope is malformed, is past its `notAfter`, which the consumer would drop anyway, or names a queue this Worker has no binding for.
- **Dismiss** deletes the record. Replay and dismiss each write an audit row with no workspace, written first in the same batch, as for other installation-admin actions.
- Metrics to Analytics Engine: processed, retried, and failed by job type; queue-to-completion latency; outbox age.
- `/health/queues` reports the last cron heartbeat, the oldest undispatched outbox row, and unreviewed `failed_jobs`. Actual queue depth is on Cloudflare's dashboard and GraphQL API, since the binding does not expose it.

## Limits to respect

| Limit | Handling |
|---|---|
| `sendBatch`: 100 messages or 256 KB | Chunk in the `JobQueue` adapter |
| 5,000 messages/s per queue; `Too Many Requests` beyond | Treated as a failed dispatch; the outbox sweep recovers it |
| 6 simultaneous connections per invocation | Relay and email fan-out use a concurrency of 6 |
| Multi-tenant fairness | No per-tenant queues. Limit each workspace at the source. Revisit if one tenant's backlog affects others |
