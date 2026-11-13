# Monitoring

How an operator watches an OpenChat installation, and what to do when something is wrong. It assumes a deployment made with `pnpm oc deploy`, as [deployment](deployment.md) describes.

## Health checks

`/health` is public and says only that the Worker answers. Four more checks say what is wrong. They need the **operator token**, per [amendment A9](../architecture/spec-review.md#amendments-to-the-specification). Without it, or with the wrong one, they answer 404, as if they did not exist.

`oc deploy` generates the token once, sets it as the Worker secret `OPERATOR_TOKEN`, and keeps the only copy in `.openchat/<name>/operator-token`, readable only by you. A deployment made before this existed gets one the next time `oc deploy --env <name>` runs. `oc upgrade` does not create it.

To read them all:

```sh
pnpm oc health --env acme
```

```text
OK   database: 4 ms, 2.0 MB of 10240.0 MB, migration 0013_audit_log_recent.sql
WARN queues (failed_jobs): heartbeat 31 s ago, oldest outbox row none, 2 failed jobs to review
OK   realtime: 12 ms round trip
OK   notifications: relay ok, 85 ms
```

It exits with 1 if any check fails. A monitor calls each check directly:

```sh
curl -H "authorization: Bearer $(cat .openchat/acme/operator-token)" https://chat.example.com/health/queues
```

Each answers JSON with a `status` of `ok`, `warn` or `fail`, the `problems` behind it, and the figures below. The status code is **200 for ok or warn, and 503 for fail**, so a monitor can watch the status code alone. The contract is in the [OpenAPI document](../../packages/api-contracts/generated/openapi.json). Answers are never cached.

| Check | What it measures | Problems |
|---|---|---|
| `/health/database` | Latency of `SELECT 1`; the newest applied migration; database size, from D1's result metadata, against the 10 GB limit of the Paid plan | `database_filling` warns at 70%, and `database_nearly_full` fails at 90%. `database_slow` warns over one second. `migrations_unknown` warns. `database_unreachable` fails |
| `/health/queues` | Age of the last cron heartbeat to come back through the jobs queue; age of the oldest outbox row not yet sent; failed jobs not yet replayed or dismissed | `no_heartbeat` and `heartbeat_stale`, over five minutes, fail. `outbox_slow` warns over three minutes, and `outbox_stuck` fails over ten. `failed_jobs` warns |
| `/health/realtime` | Round trip to a Durable Object that holds no data and no sockets | `realtime_unreachable` fails. `realtime_slow` warns over one second |
| `/health/notifications` | Whether the relay answers, and accepts this installation's signature | `relay_rejected`, `relay_unreachable` and `relay_slow` only **warn**: messaging works without push. Never 503 |

### What the queue check proves

The cron trigger sends a heartbeat job each minute, and its consumer records a receipt in D1. A fresh receipt therefore shows that cron runs, the jobs queue delivers, and the consumer reaches the database. Queue depth itself is not visible to a Worker; it is on Cloudflare's dashboard, under **Queues** ([G-14](../architecture/spec-review.md)).

A new deployment reports `no_heartbeat` for its first few minutes, until Cloudflare starts its cron trigger. Alert on two failures in a row, not one.

### What the push check proves

`relay` is one of:

- `off`: no relay is configured;
- `disconnected`: an installation admin disconnected it in the dashboard;
- `unregistered`: no phone has asked for push yet, so the relay has nothing to check against;
- `ok`;
- `rejected`;
- `unreachable`.

For `ok`, the installation sends the relay a signed request about a notification that cannot exist. A 404 means the relay knows the installation and accepted the signature. Nothing is sent to a phone, and the request counts once against the installation's [relay limits](../notification-relay/protocol.md#rate-limits).

## What to alert on

Poll from an uptime service that can send a header, from outside Cloudflare. Five minutes is often enough. Every check reads a handful of rows, so polling costs almost nothing.

| Watch | Alert when | Why |
|---|---|---|
| `GET /health`, no token | Not 200 twice in a row | The Worker, its route, or the domain is down. Nobody can chat |
| `/health/queues` | 503 twice in a row | Background work has stopped: no push, no follow-up email, no retention, no sweep of the outbox. Chat itself still works |
| `/health/database` | 503 once; `database_filling` once | Writes fail when D1 is full. At 70%, set [retention](../architecture/data-model.md#retention) or plan the [next step](../architecture/data-model.md#reaching-the-10-gb-limit) |
| `/health/realtime` | 503 twice in a row | Live updates stop. Clients fall back to reloading through REST, so nothing is lost |
| `/health/notifications` | `warn` for an hour | Push has stopped. Lower priority: the inbox still works |
| `/health/queues` problem `failed_jobs` | Daily, not paged | Someone should look at the **Failed jobs** page |

Set these on the Cloudflare account too:

- **A budget alert**, under **Billing**, **Billable Usage**. It emails when the month's usage-based spend crosses an amount you choose. It fires the day after, not in real time.
- **Billable Usage notifications**, under **Notifications**, for a single metric such as Workers requests or D1 rows read. These suit an installation that has a sudden spike, such as a widget on a page with heavy traffic.

Both are for Pay-as-you-go accounts. See Cloudflare's [usage-based billing](https://developers.cloudflare.com/billing/usage-based-billing/) and [budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) documentation, which changes more often than this guide.

## When a check fails

| Problem | Look at | Usually |
|---|---|---|
| `GET /health` fails | `wrangler deployments status`, the domain's DNS | A failed deploy: `pnpm oc rollback --env <name>` if it followed an upgrade |
| `no_heartbeat`, `heartbeat_stale` | Cloudflare dashboard, the Worker's **Triggers**, then **Queues**, `oc-<name>-jobs` | The cron trigger was removed, or the consumer is failing. `wrangler tail` shows the consumer's errors |
| `outbox_stuck` | `wrangler tail`, for `outbox_dispatch_failed` | A queue refusing sends, or a malformed row. The sweep retries each minute |
| `failed_jobs` | The dashboard's **Failed jobs** page | Fix the cause, then **Replay**, or **Dismiss** |
| `database_filling` | `/health/database`, then the largest workspaces | Retention, or archiving |
| `database_slow`, `realtime_slow` | Cloudflare's status page, then the D1 metrics | Usually Cloudflare's side. Persisting, check for an expensive query |
| `relay_rejected` | Dashboard, **Workspaces**, **Push notifications** | The relay does not know this installation's key, or the managed relay has not allowed it yet |
| `relay_unreachable` | The relay's own `/health` | The relay is down. Push resumes on its own, since jobs retry |

To read logs as they happen:

```sh
pnpm --filter @openchat/api exec wrangler tail oc-acme --format json -c ../../.openchat/acme/api.wrangler.jsonc
```

Log lines never hold message content, tokens or personal data ([security](../architecture/security.md)), so they can go to any log service.

## Not covered

- **Queue depth and age** come from Cloudflare's dashboard or GraphQL API, not from a check.
- **The relay's own health** beyond `/health` is the relay operator's concern. Orango Labs watches the managed relay.
- **Email delivery** is not checked. A bounce or a provider outage shows up as failed jobs.
- **Metrics dashboards.** Analytics Engine records counts, if enabled with `--analytics`, but OpenChat has no ready-made dashboard over them.
