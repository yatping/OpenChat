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
| Cloudflare Email Service | Optional, driver built | Beta. Sending to any recipient needs Workers Paid and a domain on Cloudflare DNS. 3,000 emails a month included, then $0.35 per 1,000. The `send_email` binding documents no idempotency key. Checked on 2026-11-04 against the [docs](https://developers.cloudflare.com/email-service/); nothing has been sent |
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
| Close frames | Auto-reply with compatibility date 2026-04-07 or later | Documented, **but not what we measured**. With no `close()` in `webSocketClose`, a client closing its socket waited about 10 s and reported 1006, on real Cloudflare and in workerd tests. The objects now answer explicitly |
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

The first runs appeared to be on the Workers Free plan, because scrypt requests were killed with `exceededCpu` at a reported 10 ms of CPU. The owner then upgraded the account, and S3 and S4 were repeated the same day. No request hit a CPU limit afterwards, at up to 2,702 ms of CPU. The other spikes were not repeated.

| Spike | Result | What was measured | Not covered |
|---|---|---|---|
| **S1** APNs | **Pass, within its limits** | `403 MissingProviderToken` on all 75 requests: 10 from `fetch`, 10 from a Durable Object, 10 from a queue consumer, and 45 from cron over 44 minutes. Local curl over HTTP/1.1 fails, so this implies an HTTP/2 path | The planned run over a full day. A real push, which needs Apple credentials |
| **S2** Hibernation | **Pass** | Details below | Forced resets at `max_delay`. Thousands of sockets |
| **S3** Scrypt | **Pass** | N=2^15, r=8, p=3 on Workers Paid: all 77 requests succeeded, with no CPU or memory failure. One hash took a median of about 261 ms of CPU, with a range of 205 to 636 ms. Eight hashes in one request took about 2,221 ms, so CPU grows linearly. 20 parallel requests all succeeded, with a 95th percentile near 941 ms | Sustained login load. The occasional hash above 500 ms is worth watching |
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
| 100 sends through 40 connections | Repeated three times. Every send that reached the Worker succeeded, gapless, with no overload error. 3 to 5 per run failed connecting from the client, before reaching Cloudflare. **This shows moderate load only** |
| 1,100 sends in rounds of 50, with outcomes counted | 1,099 created, in 22 rounds. Message counts and sequences matched exactly each time, and 10 rounds mixed in notes, with `public_seq` gapless. The other send got the HTML 404 described below, and wrote nothing |
| Latency of one write batch, with the Worker near the database | About 90 ms (DFW to WNAM) |
| The same, with the Worker far from the database | About 380 ms (ARN to APAC, and SIN to WNAM). Stable across eight writes in one request, so this is distance rather than a slow first call |

**Write latency depends on the distance from the Worker to the D1 primary, and the Worker's location varied between runs for one client** (LAX, ARN, DFW, and SIN). Choose the D1 location deliberately. Smart Placement is worth testing before M1b, as it is not covered here.

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
| **Cloudflare occasionally answers with its own HTML 404 instead of reaching the Worker.** Seen once in 1,100 D1 sends, with nothing written, and possibly the same as a discovery 404 straight after one deploy. Cause unknown | Clients must treat a 404 as "not found" only if it is `application/problem+json`, and otherwise retry. See [conventions](../api/conventions.md) |
| In one preview run, no job reached the consumer within 5 minutes. It did not recur, and **was not explained** | The preview script now waits up to 10 minutes. Open until seen again |
| In one D1 run, 50 sends were reported as successful and the conversation's highest `seq` was 48. That client counted `not_found` as success and did not record outcomes, so it cannot show what happened. It did not recur in 1,100 counted sends, including 500 with notes. **Not explained** | M1b tests must count outcomes, and treat `not_found` on a known conversation as a failure |
| `@cloudflare/vitest-plugin` 1.5.1 shares storage between tests in a file, omits `delaySeconds` from `getQueueResult`, and bypasses asset routing through the default export | Tests reset their own data and observe `retry()` directly. Asset routing is checked with `wrangler dev` and the preview |
| The SPA fallback answers `/__scheduled` unless that path is in `run_worker_first` | Added. In production the Worker answers it with 404, and the preview checks that |

## Milestone 1a deployment results

Measured on 2026-11-04 on a throwaway deployment, which was then removed.

| Finding | Result |
|---|---|
| `_headers` on Workers static assets | Applied to files and to `single-page-application` fallback routes. The API sets its own headers |
| First login attempt on an address | About 500 ms slower than a repeat, for known and unknown accounts alike. Most likely the cost of creating its `AuthGuard` object, though this was not measured separately |
| Login with hashing, repeat attempt, from outside | Median about 500 ms, with a wide spread |
| `wrangler secret bulk` on stdin | Works, so generated secrets need no temporary file |
| Multiple statements in `wrangler d1 execute --command` | Works on remote D1 |
| Queue consumer picking up a job after a deploy | About 10 seconds in one sample |
| `oc deploy` from nothing to verified | About 80 seconds on a laptop, including the build |


### Cloudflare Email Service, 2026-11-04

Sending from a Worker through the `send_email` binding delivered a real reset email to an outside mailbox, and its link worked. The sending domain had been enabled about three minutes earlier, with `wrangler email sending enable`, on a zone in the account. That needed a login with `email_sending:write`, which an older Wrangler login lacks and `wrangler login` grants. Cloudflare set `_dmarc` to `v=DMARC1; p=reject;` on the zone, so any other service sending as that domain must pass DMARC. Whether mail lands in the inbox or in spam, and how large the daily quota is, were not measured.

### M1b REST slices on real D1, 2026-11-04

27 of 27 outside checks passed against a throwaway deployment: origins, retries reaching the same conversation, notes staying out of a visitor's history with no gap in `seq`, a note's client ID refused, compare-and-set, reopening, and tokens refused across audiences. Eight concurrent replays produced one 201 and seven 200s, with no gap in the sequence. Sending a message took a median of 186 ms and at most 317 ms from one client, n=10, which is too few to rely on. The load test replaces this.

### M1b sockets on real Cloudflare, 2026-11-04

A throwaway deployment, since removed, driven by a Node client.

| Check | Result |
|---|---|
| Bad, altered, or wrong-kind tokens at connect | 401. A real ticket without an upgrade gets 426, and a ticket is refused as an access token |
| Visitor ticket from another `Origin` | Connection refused |
| Agent sees a note and a visitor does not | Held, with `seq` unbroken and no agent name by default |
| Idle for 40 s, with pings | Sockets stayed open, and both received the next message. This run did not separately prove the object hibernated; S2 did |
| Idle with no pings | **Sockets dropped with 1006**, at about 62 s when measured later, so clients must send the heartbeat. That is before our 90 s stale check could act, and what ends them was not determined |
| Client disconnects, messages sent meanwhile | All recovered through REST by `afterSeq` |
| Redeploy during traffic, one send per second | 23 of 23 sent, all received live, no socket closed, no gaps, nothing left pending |
| Stranded outbox row | The real cron re-delivered it within 17 s of being made stale |
| Member removed | Close frame reached the client within about 1.3 s, and no later message did. **Node's WebSocket fires `close` about 10 s later**, so do not treat that event's timing as the revocation time |

A second throwaway deployment, also removed, checked the next slice from the same client. Presence, typing in both directions, note typing kept from the visitor, `auth.refresh`, bootstrap availability, and a flood closed with 4429 all held. The real alarm reported a visitor gone 15 s after closing. Agent typing reached the other sockets in about 510 ms. After the objects began answering closes, a client's own close completed with 1000 in 146 to 439 ms, n=3, instead of 1006 after about 10 s.

A third, also removed, ran the inbox in headless Chromium: sign-in, a conversation appearing without a reload, a `wss` socket allowed by the page's CSP, a reply reaching a visitor's socket and a note not reaching it, a message arriving after 40 s idle, and no script or CSP errors. Live arrival took 3,287 ms in that run, again with the Worker far from D1.

**Latency here was poor, for a known reason:** this client reached the Worker through LAX, and D1 was in Singapore, at about 170 ms per query. A send answered in a median of 1,095 ms and reached a socket in 1,813 ms, n=12. Queries repeat this distance, so placement matters more than anything in the dispatch path. Smart Placement is still untested, and is part of the M1b load test.

### Widget on real Cloudflare, 2026-11-04

The built widget in headless Chromium, on a page served as `https://shop.example` under a strict policy (`default-src 'none'`, a script nonce, `style-src 'none'`), with an agent in the real dashboard. All 13 checks passed on the final run, and the deployment was removed afterwards.

| Check | Result |
|---|---|
| Sockets and sessions before the visitor writes | None |
| Styles under `style-src 'none'` | Applied, through `adoptedStyleSheets` |
| Socket, typing, read status, note not delivered, unread count, history after a reload | Passed |
| `RETURNING` with a correlated subquery, used for read positions | Works on real D1 |
| First send to "Sent", including a new session | 2.9 to 3.5 s, with the Worker and D1 far apart as in [the earlier results](#m1b-sockets-on-real-cloudflare-2026-11-04) |
| Agent's reply to the visitor's screen | 0.8 to 1.8 s |

**Found only by this run:** Workers serves scripts as `text/javascript` with no charset, so a script takes the encoding of the page around it. On a page with no UTF-8 declaration, the widget showed `Typingâ€¦`. Bundles are now plain ASCII, enforced by `check-budget`, with a browser test on a Latin-1 page. Local browser tests had missed it because their page declared UTF-8.

Chromium also refuses a public page access to a loopback address, so the local browser tests turn off `LocalNetworkAccessChecks`. That applies only to those tests, not to a deployed widget.

Not measured: a real phone, Safari, or Firefox. Only Chromium ran.

### Attachments on real R2, 2026-11-04

Through the real API and in headless Chromium, on a throwaway deployment since removed. 16 of 17 checks passed. The other reported a 401 in the dashboard's console, which is its session refresh before anyone has signed in. Nothing failed after sign-in. That check was stricter than earlier runs, and the behaviour is not new.

| Check | Result |
|---|---|
| `FixedLengthStream` to R2 from a request body | Works. A 20 MB file came back byte for byte |
| 20 MB through the Worker, from one client | 7.1 s up, 1.9 s down. One sample, not a benchmark |
| Over 25 MB, HTML, HTML named as a picture | Refused with 413, 415, and 415 |
| Another visitor, no token, a note's file | 404, 401, and 404 |
| A `blob:` picture in the real dashboard, past its CSP | Shown |
| A visitor downloading across origins | Works |

Not tested on real Cloudflare: the hourly orphan sweep, and a body shorter than its declared length. Both pass in workerd. The cost per transfer in ADR-0008 is for the load test.

**A bucket with files in it cannot be deleted.** `wrangler r2 bucket delete` refuses, and Wrangler has no command to empty one, so removing a deployment that has received files needs a small Worker to delete them first. This matters to the uninstall story, which does not cover it yet.

### Turnstile on real Cloudflare, 2026-11-04

Run with Cloudflare's published test keys, the real `api.js` in headless Chromium, the real siteverify service, and a strict CSP on the host page. Then removed.

- The challenge renders and works inside the widget's open Shadow DOM. First message took 6.4 s including the check, with the Worker and D1 far apart.
- A page view contacts nobody. A known visitor is not checked again after a reload.
- No token: 403 `turnstile_required`. Client-side failure key and refusing secret: visitor told, nothing reaches the inbox. Wrong secret: 503 `turnstile_unavailable`.
- The forced-interactive key shows the checkbox in the panel, seen by screenshot. Nobody clicked it.
- **Not tested:** a real site key on a real hostname, and any browser but Chromium. The test secret accepts any token, so replay refusal was only tested against a stubbed service.

### M1b load test on real D1, 2026-11-04

Run with `tooling/scripts/load-test.mjs` against a throwaway deployment, since removed, from one laptop whose traffic mostly entered Cloudflare at LAX, with D1 in APAC (Singapore). Absolute latencies include that long path, so read them as this client's, not as typical.

**Sends: about 45 messages a second is the ceiling for one database.** Agent sends over REST, 25 s per level, across 20 conversations, with Smart Placement. One conversation gave the same ceiling in the earlier default-placement run.

| Concurrent senders | Messages/s | p50 ms | p95 ms | Refused with 503, then retried | Gave up, gaps, duplicates |
|---|---|---|---|---|---|
| 1 | 1.6 | 524 | 1,280 | 0 | 0 |
| 5 | 11.8 | 489 | 727 | 0 | 0 |
| 10 | 22.8 | 502 | 713 | 0 | 0 |
| 25 | 45.1 | 543 | 973 | 16 | 0 |
| 50 | 47.0 | 788 | 3,466 | 146 | 0 |
| 100 | 46.4 | 1,194 | 5,249 | 422 | 0 |

Above the ceiling D1 answers `D1 DB is overloaded. Too many resources consumed within a 10 second window`, a wording this document had not recorded. Latency here includes retries with the same `clientMessageId`, as real clients do. **Every send ended stored exactly once**, and sequences stayed gapless. Rows that were pending straight after a run had drained to none a few minutes later, checked after the earlier runs and not after the last one.

Two defects found and fixed in this slice:

- **Overload returned 500**, where the API conventions promise 503 with `Retry-After`. Some of those sends had committed, so a client seeing 500 could not tell. It is now 503, and a retry gets the original as a replay.
- **`pendingOutboxFor` read about 1,448 rows per call**, because its only index scanned the backlog, so dispatch got slower exactly when behind. There is now a partial index for it, confirmed by query plan in workerd. Its effect on real rows read was not measured, because the last insights call failed, and it did not move the ceiling. **What limits D1 at 45 a second is not known.** Query times total only a few milliseconds per message, so this looks like a limit on the database rather than the time spent in queries.

**Placement.** One write and one list, n=30, p50:

| Placement | Send | List | Notes |
|---|---|---|---|
| Default | 982 ms | 831 ms | Worker ran at the client's entry point, MRS in this run. LAX and others in other runs |
| `region: aws:ap-southeast-1` | 521 ms | 504 ms | `cf-placement: remote-SIN` |
| Smart | 500 to 630 ms | 516 to 611 ms | Six of eight rounds, `remote-SIN`. A list that entered at SIN directly took 186 ms. One later round was slower, at 609 and 1,127 ms, unexplained |

Smart Placement matched the explicit region and needs no configuration, so it is now the default. **It may not have had to work this out alone:** this deployment was on the explicit region just before, and it showed `remote-SIN` within about three minutes, sooner than the documented analysis, so a brand-new deployment is unproven. The documentation says it needs traffic from several locations, and otherwise a Worker stays where it is, which is the default row above. It applies to fetch handlers only.

**1,000 agent sockets on one `WorkspaceHub`**, the worst case, since every agent socket fans out through one object.

| Check | Result |
|---|---|
| Open 1,000, 40 at a time | 998 open after 80 s |
| One message to all | 998 of 998, p95 1.2 s from starting the send |
| After 45 s idle, to wake the hub | 718 of 718, p95 0.9 s. Fewer sockets, because this run's heartbeat started late; see below |
| **Forced reset, at most 100 at once** | **1,000 of 1,000 back in 99 s, none missing a message**, with 42 messages sent during it. Then 1,000 of 1,000 reached by the next one, p95 6.6 s |
| Forced reset, all at once | 934 finished in 150 s, none missing a message, 66 gave up after six tries |
| Redeploy under 1,000 sockets | About 50 closed with 1006 around when the deploy finished, the rest stayed open, and every open socket got every message. That one client earlier saw no close, so expect a few percent to reconnect |
| Redeploy with the widget in Chromium, one exchange every 6 s | 20 of 20 both ways, the same socket throughout, nothing marked not sent |

The reset was the clients closing their own sockets, not the server dropping them. **Reconnect times mostly measure the client machine.** Retries were all connection timeouts or socket errors on its side (279 and 135 in the paced run, 3,135 and 604 all at once). There were no 5xx answers to ticket or catch-up requests, and the server's error log showed one failed request. Requests that got through stayed quick: ticket p50 460 ms, socket 640 ms, catch-up 652 ms. A single machine cannot tell whether the connection limit was its own, its network's, or Cloudflare's per-address protection, so a true 1,000-address herd is untested. Visitor sockets are also untested at this scale, because sessions are limited to 30 an hour per address.

Also seen:

- Sockets with no heartbeat dropped again, so a run that started its heartbeat after opening lost about 235 of 1,000. With it from the start, 998 stayed. This supports the 62 s figure above.
- Node's default of 250 ms per address caused most connection failures in the first socket run on this IPv4-only network. The script turns it off.
- **One unexplained failure:** in one browser run the widget's compose box did not appear within 30 s of a click, just before a deploy. 15 fresh browser contexts afterwards all took under 3 s, and it did not recur.

**Cost estimate, not a bill.** Published Paid prices, and measured rows for a text message: about 16 written (message 6, conversation 5, outbox 3 then 2) and about 25 read, and about 1 KB of database per message. For 1 million messages a month, with 1,000 sockets always connected and 5 million other API requests:

| Item | Use | Cost |
|---|---|---|
| Workers Paid base | | $5.00 |
| Workers requests | 6 million of 10 million included | $0 |
| D1 rows written | 16 million of 50 million included | $0 |
| D1 rows read | 25 million of 25 billion included | $0 |
| D1 storage | About 1 GB of 5 GB included | $0 |
| Durable Object requests | Assumes 2 per message, plus heartbeats at 20:1 if auto-responses count, which is the worst case: 6.3 million, of which 1 million included | Up to $0.80 |
| Durable Object duration | Worst case of a separate 10 s wake per message at 128 MB: 1.25 million GB-s, of which 400,000 included | Up to $10.63 |
| **Total** | | **About $5 to $17 a month** |

Not measured: Worker CPU time ($0.02 per million ms over 30 million included), real Durable Object duration, or queues, which text messages do not use until push and email follow-ups exist. Prices were read from Cloudflare's pricing pages on this date.

### Follow-up deployment, 2026-11-04

A second throwaway deployment on the same account took about 90 seconds, then was removed. `oc preflight` passed, and with a bad API token it stopped before creating anything. `/api/*` answers carried `no-store` and `nosniff`. Account deletion answered 401 with no token, 400 with no password, 403 with a wrong password, and 409 for the last owner with the right one. A successful deletion has only run in workerd, because this deployment had one user. The check's failure cases for R2, D1, Queues, and several accounts, and the missing `workers.dev` message, have only run against a fake Wrangler.

## Abuse limits on real Cloudflare (2026-11-05)

Run on a temporary deployment, which was then removed. The [abuse limits guide](../operations/abuse-limits.md) explains the limits.

| Check | Result |
|---|---|
| 4,001 characters from a visitor, on both routes | 400 `message_too_long` |
| 4,000 characters from a visitor, 16,000 from an agent | 201 |
| 80 messages from one IPv4 address in 12 seconds, from 4 visitors, after 1 already sent | 59 accepted, 21 refused with `rate_limited`, so 60 in all |
| Redeploy with a limit of 3 messages a day and 100 characters | Both applied, and the widget text box moved to 100 |
| Fourth message that day | 429 `daily_limit_reached`, `Retry-After: 86397` |
| Agent reply, and a second website, after that | 201 |
| The widget at the daily limit, in headless Chromium | Showed "This chat cannot take more messages today. Please try again later." |
| Worker log at the daily limit, through `wrangler tail` | `website_daily_limit_reached`, with workspace and website IDs |
| A value out of range passed to `oc deploy` | Refused, with the allowed range |

**Not checked on real Cloudflare:**

- IPv6 grouping, because the network used has no IPv6. We have not confirmed the form of the address that `cf-connecting-ip` carries for a real IPv6 visitor. The code accepts every standard form, and uses anything it cannot read as it stands.
- Going back to a default by redeploying with `default`, which has an automated test only.
- A full 24 hours passing. The window uses the same `AuthGuard` code as the other limits.

The text box shows the default of 4,000 for a moment after the widget opens, until the bootstrap response arrives. The server enforces the real limit either way.

## Sources

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [migrations](https://developers.cloudflare.com/d1/reference/migrations/), [foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DO state API](https://developers.cloudflare.com/durable-objects/api/state/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/), [deferred updates changelog](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [errors](https://developers.cloudflare.com/workers/observability/errors/), [static assets](https://developers.cloudflare.com/workers/static-assets/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [Containers](https://developers.cloudflare.com/containers/), [`cf` CLI migration](https://developers.cloudflare.com/cf/wrangler/migrate/), [Email Service changelog](https://developers.cloudflare.com/changelog/product/email-service/index.md)
- [Expo notifications](https://docs.expo.dev/versions/latest/sdk/notifications/), [Expo app config](https://docs.expo.dev/workflow/configuration/), [iOS app extensions](https://docs.expo.dev/build-reference/app-extensions/), [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [workerd#4841](https://github.com/cloudflare/workerd/issues/4841), [paje](https://github.com/jonesphillip/paje), [FSF position on GPLv2 and the App Store](https://www.computerworld.com/article/1347653/gplv2-blocks-vlc-from-apple-s-app-store.html)
