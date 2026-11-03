# Platform validation

Each assumption checked against vendor documentation or direct testing on **2026-11-03**. Limits change, so re-check before relying on a value near its limit.

Evidence levels:

- **Documented**: stated in vendor documentation.
- **Tested**: run directly during this review.
- **Observed**: reported by others, or implied by a maintainer, with no vendor guarantee.
- **Unverified**: needs a spike.

Spike results are in [Phase 0 spike results](#phase-0-spike-results).

## Verdict on the proposed architecture

| Spec component | Verdict | Notes |
|---|---|---|
| Workers for the HTTP API | Fits | Requires Workers Paid in practice |
| Durable Objects for WebSockets | Fits well | Hibernation makes idle sockets inexpensive |
| D1 as primary database | Fits with discipline | No interactive transactions; 10 GB; one query at a time |
| R2 for attachments | Fits | Stream through the Worker; presigned URLs need extra credentials |
| Queues | Fits | At-least-once; configure a DLQ or lose messages after retries |
| Cron Triggers | Fits | Used for sweeps, not per-conversation timers |
| Workers static assets | Fits | Preferred over Pages for atomic deploys |
| Rate limiting binding | Partly | Approximate and per location |
| APNs from a Worker | **Risk, reduced** | Reached APNs from every Worker context in S1, but still rests on undocumented proxy behaviour |
| Cloudflare Email Service | Optional | Public beta, paid plan |
| Wrangler as deploy tool | Fits | The `cf` CLI is in beta; do not adopt it yet |

## D1

| Fact | Value | Evidence |
|---|---|---|
| Max database size | 10 GB Paid, 500 MB Free | Documented |
| Concurrency | Single-threaded, one query at a time. 1 ms average gives about 1,000 queries/s; 100 ms gives about 10 | Documented |
| Overload | Requests queue; a full queue returns an "overloaded" error | Documented |
| Bound parameters | 100 per query | Documented |
| Queries per invocation | 1,000 Paid, 50 Free. A `batch()` counts as one | Documented |
| Row or string size | 2 MB | Documented |
| SQL statement length | 100 KB | Documented |
| Query duration | 30 s | Documented |
| `batch()` | Sequential, transactional, rolls back the whole sequence on failure | Documented |
| Interactive transactions | Not available through the binding; `batch()` is the only documented transaction | Documented (by omission) |
| Read replication | Requires the Sessions API; replicas lag; writes go to the primary | Documented. Status not stated on the page |
| Foreign keys | Enforced by default; `PRAGMA defer_foreign_keys` available, ends with the transaction | Documented |
| Migrations | Tracked in `d1_migrations`; nested layouts through `migrations_pattern`. A failing file left nothing behind and was not recorded as applied, though the docs do not promise this | Documented, and **Tested** once in S4 |
| Time Travel | 30 days Paid, 7 days Free. Restore is destructive but reversible | Documented |
| `INSERT ... SELECT ... ON CONFLICT DO NOTHING` idempotent write | Works | **Tested** on real D1 in S4 |
| Composite foreign keys blocking cross-tenant references | Works | Tested on SQLite, including cascades |
| Index plans for inbox and history queries | No sort, no scan | Tested on SQLite |

## Durable Objects

| Fact | Value | Evidence |
|---|---|---|
| Hibernation connections | Up to 32,768 per object; CPU and memory may lower this | Documented |
| Tags | Up to 10 per socket, 256 characters each | Documented |
| Attachment size | 16,384 bytes. Older references say 2 KB | Documented |
| Received message size | 32 MiB | Documented |
| Soft request limit | 1,000 requests/s per object | Documented |
| Auto-response | Strings up to 2,048 characters; does not wake the object or bill duration; timestamp available | Documented |
| Ping frames | Automatic pong without waking, but browsers cannot send ping frames, so an application-level ping is required | Documented |
| Close frames | Auto-reply with compatibility date 2026-04-07 or later | Documented |
| What blocks hibernation | Alarms in progress, requests, `setTimeout`/`setInterval`, outbound WebSockets | Documented |
| Storage | SQLite-backed required on Free. 10 GB per object Paid | Documented |
| Alarms | One per object; at-least-once; up to 6 retries with backoff from 2 s | Documented |
| Code updates | **Changed 2026-10-30.** Default is `deferred`, 300 s `max_delay`, configurable up to 86,400 s. Applies when the object hibernates or at `max_delay`. Best effort | Documented |
| Sockets on update | Hibernation connections survive a hibernate-then-update cycle. A forced update disconnects them | Documented. The surviving case is **Tested** in S2 |
| Version skew | Docs advise keeping code forward and backward compatible for as long as a version may run | Documented |
| Class declaration | `exports` in Wrangler config is preferred for new Workers; legacy `migrations` still works; they are mutually exclusive | Documented. **Tested** with the Vitest plugin, `wrangler dev`, and a real deploy |

## Queues

| Fact | Value | Evidence |
|---|---|---|
| Delivery | At least once | Documented |
| Ordering | Not addressed in the delivery guarantees page; design assumes none | Documented (by omission) |
| Message size | 128 KB | Documented |
| Batch | 100 messages per consumer batch; `sendBatch` 100 messages or 256 KB | Documented |
| Max retries | 100; **default 3** | Documented |
| Delay | Up to 24 h, so delays cannot express long follow-ups | Documented |
| Exhausted retries | Moved to the DLQ if configured, **otherwise deleted** | Documented |
| Retention | Up to 14 days Paid; 24 h fixed on Free | Documented |
| Throughput | 5,000 messages/s per queue | Documented |
| Consumer concurrency | 250 invocations; 15 minutes wall time each | Documented |
| Free plan | Available | Documented |

## Workers runtime

| Fact | Value | Evidence |
|---|---|---|
| CPU | **10 ms Free**; 30 s default, up to 5 min Paid | Documented |
| Subrequests | 50 Free; 10,000 default Paid | Documented |
| Simultaneous open connections | **6 per invocation**; excess waits. This caps APNs concurrency per consumer invocation | Documented |
| Memory | 128 MB per isolate | Documented |
| Request body | 100 MB on Free and Pro zones, 200 MB Business | Documented |
| Cron | 30 s CPU for schedules under an hour apart | Documented |
| Same-zone Worker fetch | Error 1042 unless using service bindings or `global_fetch_strictly_public`. Custom Domains work | Documented |
| `connect()` | Port 25 blocked; StartTLS supported; no documented ALPN control; cannot reach Cloudflare IP ranges | Documented |
| Rate limit binding | 10 or 60 s only; approximate; per location; Wrangler 4.36+ | Documented |
| `node:crypto` | Argon2 explicitly **unsupported**; `randomUUIDv7` unsupported; scrypt not listed as an exception, so it should work | Documented. Timing in spike S3 |
| WebCrypto PBKDF2 | Reported to cap at 100,000 iterations, below OWASP's 210,000+ for SHA-512 and 600,000 for SHA-256 | Observed |
| Ed25519 in WebCrypto | Assumed available | Unverified, spike S5 |
| Static assets | SPA fallback through `not_found_handling`; route selection through `run_worker_first` | Documented |

## R2

| Fact | Value | Evidence |
|---|---|---|
| Presigned URLs | Cannot be created through the binding; need S3 credentials | Documented |
| Presigned URLs on custom domains | Not supported | Documented |
| Max expiry | 7 days | Documented |

## APNs

| Fact | Value | Evidence |
|---|---|---|
| Protocol | HTTP/2 only. Direct test: `--http2` returned `403 {"reason":"MissingProviderToken"}`; `--http1.1` failed with a non-HTTP response | **Tested** |
| Production Worker `fetch` to APNs | Works, reportedly through the proxy upgrading to HTTP/2 | **Tested** in S1 with no credentials, not yet with a real push. **Observed** only, in that there is no vendor guarantee: [workerd#4841](https://github.com/cloudflare/workerd/issues/4841) |
| Local `workerd` to APNs | Fails; "no active plans" for HTTP/2 | Stated by a Cloudflare maintainer in the same issue |
| Provider token | ES256 JWT; refresh no more than every 20 minutes, must be under 60 minutes old | From prior knowledge; Apple's page did not render in the fetch tool. Confirm in Milestone 3 |
| Error reasons | `BadDeviceToken`, `Unregistered` (410), `TooManyProviderTokenUpdates` (429), `ExpiredProviderToken` (403) | Same as above |

## Expo and App Store

| Fact | Value | Evidence |
|---|---|---|
| `getDevicePushTokenAsync` | Returns the native APNs token on iOS | Documented |
| `addPushTokenListener` | Fires on token change | Documented |
| Entitlement | Plugin adds `aps-environment` as development; release archives switch to production | Documented |
| Notification Service Extension | Not built in; needs a config plugin and native code; declare in `extra.eas.build.experimental.ios.appExtensions` | Documented |
| White labelling | Dynamic config explicitly supports it | Documented |
| Foreground notifications | Shown by default from SDK 58 | Documented |
| Guideline 2.1(a) | Live backend and demo account required for review | Documented |
| Guideline 4.2.6 | Single-binary "picker" model is allowed; template services submitting for clients are not | Documented |
| Guideline 5.1.1(v) | Apps that support account creation must offer in-app deletion | Documented |

## Phase 0 spike results

Run on 2026-11-03 on one Cloudflare account, from one client location. Code is in [`spikes/lab`](../../spikes/lab), and all resources were deleted afterwards.

**The account appears to be on the Workers Free plan.** Scrypt requests were killed with `exceededCpu` at a reported 10 ms of CPU. The plan itself was not confirmed, but any result that depends on CPU limits should be repeated on Workers Paid.

| Spike | Result | What was measured | Not covered |
|---|---|---|---|
| **S1** APNs | **Pass, within its limits** | `403 MissingProviderToken` on all 75 requests: 10 from `fetch`, 10 from a Durable Object, 10 from a queue consumer, and 45 from cron over 44 minutes. Local curl over HTTP/1.1 fails, so this implies an HTTP/2 path | The planned run over a full day. A real push, which needs Apple credentials |
| **S2** Hibernation | **Pass** | Details below | Forced resets at `max_delay`. Thousands of sockets |
| **S3** Scrypt | **Partial** | N=2^15, r=8, p=3 took 284 to 385 ms of CPU per hash in Worker logs, under the 500 ms target. No memory failure appeared in any run, including one successful run of eight hashes in one request | **Concurrency is inconclusive**, because the CPU limit killed most requests of more than one hash, and also some single ones. Repeat on Workers Paid |
| **S4** D1 | **Pass** | Details below | Latency from several regions, and real overload |
| **S5** Ed25519 | **Pass in Workers** | A deployed Worker reproduced the published signature and verified it. Node and workerd pass the full tamper suite | Hermes and browsers. Mobile only carries grants, so it does not need to sign |
| **S6** Worker to Worker | **Pass for what was tested** | Details below | Custom Domains and a different zone, because testing them meant changing zones on the account |
| **S7** Expo token | **Deferred to M2** | Needs an Apple account and an iPhone | |
| **S8** Drizzle pipeline | **Pass** | Generated SQL applied to local and real D1 (79 statements), and a second apply did nothing. Partial indexes, descending index columns, and `NOCASE` all generate correctly. The drift check catches a schema with no migration | `WITHOUT ROWID`, which Drizzle cannot express. See [data model](data-model.md) |

### S2: hibernation and deploys

- A socket with only auto-responded pings let its object hibernate. The next call woke it, with the attachment intact and the auto-response timestamp set.
- **Sockets survived a deploy under `deferred`** with a 3,600 s `max_delay`, both on a hibernating object and on one kept awake by calls every 2 seconds.
- The awake object stayed on old code for at least 70 seconds after the deploy, serving the new Worker. It then took new code when traffic stopped, keeping its socket. New code read an attachment that old code wrote.
- **A new Worker calling a method the old object lacks gets `TypeError: The RPC receiver does not implement the method`.** This confirms that RPC changes must be additive, and callers must tolerate that error during a deploy.
- **A silent socket closed with 1006 after about 59 seconds**, with no deploy involved, while sockets sending a ping every 20 seconds stayed open. The test cannot tell whether the timeout is Cloudflare's or the client network's. Either way, the 30-second heartbeat leaves little margin, so it should not be lengthened.
- One pong was missed during the deploy, and the socket stayed open. Clients must not treat one missed pong as a dead connection.

### S4: real D1

| Check | Result |
|---|---|
| `CAST(unixepoch('subsec') * 1000 AS INTEGER)` | Works, and returns milliseconds |
| `sqlite_version()` | **Rejected**: `not authorized to use function`. D1 restricts some SQLite functions, so SQLite-only tests are not sufficient |
| `batch()` failing on its second statement | Rolled back the first |
| 50 concurrent sends, 10 of them notes, on one conversation | `seq` gapless to 50, `public_seq` gapless to 40 |
| 10 racing sends with one `clientMessageId` | One message. One `created`, the rest `replayed` |
| 20 concurrent compare-and-set updates at one version | One winner, 19 conflicts, one event |
| A migration file that fails midway | Tables it had already created were gone, and it was not recorded as applied |
| 100 sends through 40 connections | All 96 that reached the Worker succeeded, gapless, with no overload error. Four failed connecting from the client, before reaching Cloudflare. **This shows moderate load only** |
| Latency of one write batch | p50 about 375 ms when sent one at a time. The database was in APAC, and a request traced through LAX, which may explain this. Repeat with a location hint on Workers Paid |

### S6: Worker to Worker

| Path | Result |
|---|---|
| Service binding | Works |
| `fetch` to another Worker's `workers.dev` URL, same account | **Fails: `error code: 1042`**, returned as an HTTP 404 |
| The same, with the `global_fetch_strictly_public` flag | Works |

### Found while deploying

| Finding | Consequence |
|---|---|
| **Analytics Engine must be enabled once per account in the dashboard**, or a deploy binding it fails | The binding is opt-in, set in deployment state. The first-run guide must cover it |
| **A Worker that consumes a queue cannot be deleted, and a queue bound to a Worker cannot be deleted** (codes 10064 and 11005) | Teardown removes consumers first. The future `oc destroy` must do the same |
| Deleting a D1 database does not need its Worker to be deleted first | Failed teardowns can leave a running Worker with no database, so teardown order matters |
| Queue creation returned `code: 10013` once with no explanation, shortly after queues of the same name were deleted | Creation retries. Cause unknown |
| Wrangler warned that `queues:write` was missing, yet creating queues worked | Trust the API result, not the warning |
| In one preview run, no job reached the consumer within 5 minutes. In another, discovery returned 404 once after a deploy. Neither recurred on the final runs, and **neither was explained** | The preview script now waits up to 10 minutes and logs each discovery attempt. Treat these as open until seen again |
| `@cloudflare/vitest-plugin` 1.5.1 shares storage between tests in a file, omits `delaySeconds` from `getQueueResult`, and bypasses asset routing through the default export | Tests reset their own data and observe `retry()` directly. Asset routing is checked with `wrangler dev` and the preview |
| The SPA fallback answers `/__scheduled` unless that path is in `run_worker_first` | Added. In production the Worker answers it with 404, and the preview checks that |

## Sources

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [migrations](https://developers.cloudflare.com/d1/reference/migrations/), [foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DO state API](https://developers.cloudflare.com/durable-objects/api/state/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/), [deferred updates changelog](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [errors](https://developers.cloudflare.com/workers/observability/errors/), [static assets](https://developers.cloudflare.com/workers/static-assets/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [Containers](https://developers.cloudflare.com/containers/), [`cf` CLI migration](https://developers.cloudflare.com/cf/wrangler/migrate/), [Email Service changelog](https://developers.cloudflare.com/changelog/product/email-service/index.md)
- [Expo notifications](https://docs.expo.dev/versions/latest/sdk/notifications/), [Expo app config](https://docs.expo.dev/workflow/configuration/), [iOS app extensions](https://docs.expo.dev/build-reference/app-extensions/), [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [workerd#4841](https://github.com/cloudflare/workerd/issues/4841), [paje](https://github.com/jonesphillip/paje), [FSF position on GPLv2 and the App Store](https://www.computerworld.com/article/1347653/gplv2-blocks-vlc-from-apple-s-app-store.html)
