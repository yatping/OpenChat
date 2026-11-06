# Implementation milestones

Each milestone leaves the product running. Before starting one, write its approach, dependencies, security implications, and expected files. After finishing, run tests, lint, and type checks, verify a real deployment, and record outstanding issues (spec §19).

## Changes from spec §17

| Change | Reason |
|---|---|
| Phase 0 gains spikes | Key assumptions are unverified, and it is cheap to check now |
| Phase 1 is split, with a deployed release in the middle | A large milestone with no checkpoint is the riskiest part of the plan |
| System email and basic deploy move to M1 | Password reset needs email. "Verify deployment" needs a deploy |
| Push registration moves from M2 to M3 | It needs the relay |
| Independent relay check moves into M3 | Confirms early that managed and independent modes truly share code. M5 then adds packaging |
| Hardening is an explicit milestone | Definition of Done needs it, and it otherwise gets squeezed |

## Sequence

```text
M0 Foundation + spikes
 └─ M1a Accounts, workspaces, deploy
     └─ M1b Core messaging              <-- first demonstrable product
         ├─ M2 iOS app (no push)
         │    └─ M3 Relay and push      <-- needs M2, Apple account, Q5
         └─ M4 Email and automation     <-- can run alongside M2 and M3
              └─ M5 Independent deployment
                   └─ M6 Hardening and v1.0 release
                        └─ M7+ Advanced features
```

Sizes are relative and for sequencing only: S, M, L, XL. They are not commitments.

## M0: Foundation (M)

See [phase-0.md](phase-0.md).

**Exit:** all packages build; lint and tests pass; local Cloudflare environment works; migrations apply locally and to real D1; spikes reported; CI is green.

## M1a: Accounts, workspaces, deployment (L)

Auth flows (login, refresh rotation, logout, reset, verification) with scrypt. Workspaces, members, invitations, RBAC. Websites. Repository layer and the isolation test harness. System email with one HTTP provider. Discovery and health endpoints. Dashboard shell with sign-in, workspace switching, and website setup. Basic `oc deploy`. Structured logging.

**Exit**

- A fresh Cloudflare account can be deployed with one command.
- The first owner can sign in, create a website, and invite a member.
- Reset works by email, and a CLI recovery route works without email.
- Isolation test enumerates all routes, and fails when a new route has no case.
- Refresh reuse revokes the session.

**Security review:** authentication and session handling. Done: see [the review](../architecture/security-review-m1a.md).

### M1a status

Built and verified on real Cloudflare on 2026-11-04, except for the items below, which need something only the owner has.

| Exit criterion | State |
|---|---|
| Deploy with one command | **Partly.** `oc deploy` worked in about 80 seconds on an existing Workers Paid account. **Not tried on a brand new account.** `oc preflight` now checks or lists [the prerequisites](../operations/deployment.md#prerequisites), including R2 and the `workers.dev` subdomain, but its failure cases have only run against a fake Wrangler, apart from a bad login |
| First owner signs in, creates a website, invites a member | Done on a real deployment. The invitation email itself is not delivered without a provider |
| Reset by email, and CLI recovery without email | Done on real deployments. A reset email sent through Cloudflare Email Service arrived, and its link set a new password. **The Resend driver has still sent no real email**, because that test needs a Resend key |
| Isolation test enumerates all routes | Done, and shown to fail for a route with no case |
| Refresh reuse revokes the session | Done on a real deployment |

Also open: browser tests for the account flows (`pnpm test:e2e` covers only the inbox so far), since those were run by hand, and the owner decisions in [the review](../architecture/security-review-m1a.md#decisions-for-the-owner).

## M1b: Core messaging (XL)

Visitor sessions, contacts, conversations, messages with Pattern 1, and status and assignment with Pattern 2. Outbox and sweep. `WorkspaceHub` and `ConversationRoom`, with tickets, heartbeat, reconnection, and catch-up. Inbox UI with live updates. Internal notes, tags, priority, contact details. Widget loader and UI in Shadow DOM, with bootstrap caching. Attachments with safe headers. Read cursors, typing, and presence.

**Exit (spec Phase 1, plus)**

- A visitor starts a conversation; an agent receives and replies in real time; messages persist in D1.
- Several agents see the same conversation.
- Workspace isolation is enforced by test.
- **Internal notes never reach a visitor**, by both REST and socket, across a table-driven test of all event types.
- Replaying a send creates one message.
- Force-disconnecting a socket during a message exchange loses nothing.
- REST still works if WebSockets are blocked.
- Sockets survive a hibernate-and-wake cycle, and a deploy, without lost messages.
- Widget budgets met: loader under 5 KB gzipped, chat bundle under 40 KB gzipped, loaded only after idle or click.
- Load test against real D1: documented messages per second and p95 latency, 1,000 clients reconnecting after a forced reset, and a cost estimate.

**Security review:** tenant isolation, visitor tokens, attachments, and XSS. Done: see [the review](../architecture/security-review-m1b.md), which is not independent.

### M1b status

**The exit criteria are met, with the limits below.** Every slice is merged. M2 can start, but the [decisions](#m1b-decisions-for-the-owner) should come before anyone runs this for strangers.

| Slice | State |
|---|---|
| Conversations and messages for agents, over REST | Merged. Tested in workerd and on real D1. Attachments are empty and tags are not in the response yet |
| Visitor sessions and the widget API | Merged. Tested in workerd and on real D1, including notes and isolation between visitors. Turnstile and attachments are not in yet |
| Sockets, tickets, outbox dispatch, and the sweep | Merged. Verified on real Cloudflare from a Node client, [with these results](../architecture/cloudflare-validation.md#m1b-sockets-on-real-cloudflare-2026-11-04). Not yet from a browser |
| Typing, presence, availability, `auth.refresh`, frame limits, stale sockets | Merged, and verified on real Cloudflare from a Node client, except the stale socket alarm, which is tested in workerd only. Metrics from the objects are not written yet |
| Inbox UI, contact details, tags | Merged. Conversation list, thread, replies, notes, status, priority, assignment, typing, presence, reconnection, contacts, and tags, covered by browser tests against a local Worker. The inbox was verified in a browser on real Cloudflare; contacts and tags were not. There is no UI yet to rename or delete tags, or to list or merge contacts |
| Widget UI | Merged. Loader and chat bundle, within budget. Covered by browser tests on a page from another origin, and verified in Chromium on real Cloudflare, [with these results](../architecture/cloudflare-validation.md#widget-on-real-cloudflare-2026-11-04). English only, with translations in Milestone 6. It shows one conversation, the latest. A required email is enforced by the widget, not the server |
| Attachments | Merged. Files both ways between the widget and the inbox, covered by API and browser tests, and verified on real R2, [with these results](../architecture/cloudflare-validation.md#attachments-on-real-r2-2026-11-04). A visitor can attach only after a conversation exists, one file at a time. The size limit is not yet per workspace. There is no malware scanning, and the iOS app does not exist yet |
| Turnstile | Merged. Tested in workerd and browsers, and on real Cloudflare with published test keys, [with these results](../architecture/cloudflare-validation.md#turnstile-on-real-cloudflare-2026-11-04). A real site key is untested |
| Load test | Merged. About 45 messages a second per database, 1,000 sockets reconnecting with nothing missing, Smart Placement now the default, and a cost estimate, [with these results and limits](../architecture/cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04). A herd from 1,000 real addresses is untested |
| Security review | Merged. Four defects fixed, and real deployments attacked from outside, [with these results and gaps](../architecture/security-review-m1b.md). Not independent |

### M1b exit check

Checked on 2026-11-04 against what was actually run. "Real" means a throwaway deployment on Cloudflare, since removed.

| Criterion | Evidence | Limit |
|---|---|---|
| Visitor starts a conversation, agent replies live, messages persist | Browser tests, and [Chromium on real](../architecture/cloudflare-validation.md#widget-on-real-cloudflare-2026-11-04) | Chromium only |
| Several agents see the same conversation | Browser test, and one message reaching [1,000 sockets on real](../architecture/cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04) | Those sockets were one member |
| Workspace isolation by test | The isolation suite fails for a route with no case, and [attacked on real](../architecture/security-review-m1b.md#what-was-attacked-on-a-real-deployment) | |
| Notes never reach a visitor | Table-driven test of all event types, and attacked on real by REST and socket | |
| Replay creates one message | Browser test, 10 racing sends on real D1, and retries under overload | |
| Force-disconnect loses nothing | 1,000 clients on real, none missing a message, with messages sent during it | The clients closed their own sockets. A real network failure was not simulated at this scale |
| REST works if WebSockets are blocked | Browser tests for the inbox and the widget | Local Worker only |
| Sockets survive hibernation and a deploy | S2 for hibernation. A deploy under the widget in Chromium, one socket throughout, nothing lost. A deploy under 1,000 sockets | **About 5% of the 1,000 closed around the deploy**, and did not reconnect in that run. Recovery by reconnecting was tested separately |
| Widget budgets | Enforced in the build: 1.6 KB and 15.7 KB gzipped, and loaded only after idle or click | |
| Load test | About 45 messages a second, p95 under 1 s at that rate, 1,000 reconnecting, and a cost estimate | One machine, so a herd from 1,000 addresses is untested. What sets the ceiling is unknown |
| Security review | [Done](../architecture/security-review-m1b.md), with four defects fixed | Not independent |

### M1b open items

| Item | Why it matters |
|---|---|
| Latency depends on where D1 is | Smart Placement took a send from about 980 ms to 520 ms for a distant client. Choose `--location` near users |
| Smart Placement on a brand-new deployment | The test deployment had just been on an explicit region |
| Contacts and tags, the hourly orphan sweep, and the stale socket alarm have not run on real Cloudflare | Covered in workerd or a local Worker only |
| The widget shows one conversation, and a required email is enforced only by the widget | The API allows more than the widget shows |
| The inbox does not show a visitor's read position | The data exists |
| No contact list or merge | In the draft API but not in this milestone's scope, and [`security.md`](../architecture/security.md#visitor-authentication) describes merging as an agent action. It needs a milestone |
| The uninstall steps do not cover a bucket with files in it | Wrangler cannot empty one |
| One unexplained missing compose box in a browser | Did not recur in 15 tries |
| A socket with no heartbeat drops at about 60 s, for a reason not determined | Clients send one, so this does not affect them |

### M1b decisions for the owner

1. **Decided: a limit on visitor messages per website, per day.** It is 20,000 by default, the same for every website, and the operator can change it. See [abuse limits](../operations/abuse-limits.md). There is still no daily limit on files, which go to R2 and cost money rather than stopping other tenants.
2. **An independent security review** before general release, covering M1a and M1b.

## M2: iOS app without push (L)

Expo app, Connection manager, discovery and compatibility check, sign-in, workspace selector, inbox, conversation view, composer, attachments, contact details, profile, secure storage, and realtime in the foreground with catch-up.

**Exit**

- Connects to an installation by address, and signing in to another replaces it, including a test with **colliding IDs** ([ADR-0014](../architecture/decisions/0014-one-installation-in-the-app.md)).
- Switching workspace never leaks data. Logout wipes all local data for that connection.
- Agents can reply from iOS.
- Login expiry is handled mid-session.
- An out-of-range API version shows an upgrade message.
- Installed on a physical device, through a signed ad-hoc build. This was a development build until the owner accepted ad-hoc on 2026-11-05: it is closer to what ships, and needs no dev server or Apple Development certificate.

**Depends on:** Apple Developer account for device builds.

<a id="m2-status"></a>
**Status: exit criteria met**, with the limits in the [exit check](#m2-exit-check).

| Part | State |
|---|---|
| App skeleton, connections, sign-in, upgrade message | Merged, with unit tests including colliding IDs |
| Inbox and conversation | Tested by hand on an iPhone 17 simulator against a local server: live messages, reply, internal note kept from the visitor, status, assignee, restart keeps the session, sign-out clears local files |
| Attachments | Tested by hand on the same simulator: picture preview, PDF through the share sheet, photo and document upload reaching the visitor, GPS removed from photos, no copies left after upload, sign-out removes downloads. Not tried: a file near the 25 MB limit, and signing out during a download |
| Contact, tags, profile | Tested by hand on the same simulator: contact and tag edits reach the inbox. The profile is read-only, because the API has no way to change a name |
| Account deletion | Not in the app or the API. Installation admins manage people from a People page in the dashboard, and removing or deactivating someone can be undone ([ADR-0015](../architecture/decisions/0015-installation-admin-and-reversible-removal.md)). Browser tests cover the page. Tested by hand on the simulator: a removed agent's message shows "Andy Agent (Removed)" |
| Administration | Installation admins manage people, workspaces, and websites from the dashboard, and workspaces have only supervisors and agents. No invitations ([ADR-0016](../architecture/decisions/0016-installation-admin-replaces-workspace-managers.md)). Replaces the invitation flow that M1a was checked against |
| One installation, switching workspace | No way to add a second installation ([ADR-0014](../architecture/decisions/0014-one-installation-in-the-app.md)). Tested by hand on the simulator against a local server: two workspaces each show only their own conversation, switching works both ways, and sign-out returns to the address screen |
| Session ended | A session that no longer exists on the server shows the sign-in screen with the address and email kept. Tested at launch, and on real Cloudflare while the app was open: it goes to sign-in on its next request, and until then keeps showing the cached list |
| Real Cloudflare | A fresh `oc deploy` passed the [API and simulator checks](../architecture/cloudflare-validation.md#milestone-2-on-real-cloudflare-2026-11-05), including priority, typing in both directions, a file just under 25 MB, and a session ending while the app was open |
| Physical device | `fastlane ios device` makes a signed ad-hoc build, and `fastlane ios install` put it on an iPhone on iOS 27.0.1, connected by cable and unlocked. It launched and kept running. Against a fresh `oc deploy`, the owner signed in, read a visitor's message, replied, sent a photo, and returned from the background. The visitor's side was checked by script: the reply arrived, and the 3.6 MB photo downloaded intact. One device, one session |
| Push spike (S7) | A throwaway ad-hoc build got a raw 64-character APNs token on the iPhone, and two pushes sent by script through production APNs arrived, one with the app open and one after its process was killed ([result](../architecture/cloudflare-validation.md#phase-0-spike-results)). `expo-notifications` is not in the app yet, so the normal app cannot receive push until M3 |
| Not tested yet | Sign-out during a download, an installation upgraded with existing data on real D1, and email delivery of a new account link |

<a id="m2-exit-check"></a>
### M2 exit check

| Criterion | Evidence | Limit |
|---|---|---|
| Connects by address, and signing in to another replaces it, with colliding IDs | Unit tests, including identical IDs. Address and sign-in by hand on the simulator and on an iPhone | Colliding IDs have only unit tests |
| Switching workspace never leaks. Logout wipes that connection's data | By hand on the simulator against a local server | Not repeated on a phone. Sign-out during a download is untested |
| Agents can reply from iOS | A supervisor replied and sent a photo from an iPhone, and the visitor's side received both. An agent's reply passed by script on real Cloudflare | The phone test used a supervisor, not an agent |
| Login expiry mid-session | A session ended on the server sends the app to sign-in on its next request, on real Cloudflare on the simulator | Tested by ending the session on the server, not by waiting for the login to expire |
| Out-of-range API version shows an upgrade message | Unit tests, and both messages seen on the simulator against a fake server reporting `v2` and `v0` | Seen on the address screen only, not on the launch check of an existing connection |
| Installed on a physical device | Signed ad-hoc build on one iPhone on iOS 27.0.1 | One device |

Push is M3, so an agent gets no alert while the app is closed. Before anyone relies on the app:

- Not tested: an installation upgraded with existing data on real D1, and email delivery of a new account link.
- Not done: App Store submission, and confirming that Apple accepts the app without account deletion under guideline 5.1.1(v).

## M3: Relay and push (L)

`packages/notification-protocol`. Relay Worker, with D1, `RelayGuard`, `ApnsCredential`, delivery queue, and APNs transports. Registration, grants, tokens. Installation fan-out and preferences. App registration, relay allowlist, and deep links. Relay operator metrics.

**Exit (spec Phase 3, plus)**

- A visitor message yields a push on the correct devices, including several devices for one member, and devices on two different installations.
- Invalid tokens are removed, and transient failures retried, using the mock for each APNs reason and spot checks against production APNs on an ad-hoc build, because the key is production only ([S7](../architecture/cloudflare-validation.md#phase-0-spike-results)).
- Replayed, stale, tampered, and unsigned requests are rejected, with one test per signed field.
- Reused grant rejected. Non-allowlisted relay refused by the app.
- A schema test proves the relay cannot hold content.
- **Relay offline: messaging works and pushes catch up, or expire.**
- The same relay build runs in `private` mode against a test Apple identity.

**Depends on:** S1 result, Q5, Q7, Q8.

<a id="m3-status"></a>
**Status: exit criteria met, except a second Apple identity**, with the limits in the [exit check](#m3-exit-check). Q5 and Q7 are [answered](../architecture/open-questions.md), and Q8 waits for App Store submission.

| Part | State |
|---|---|
| APNs transport | Transports, `ApnsCredential`, handling of each APNs answer, and a self-check. [Tested on real APNs](../architecture/cloudflare-validation.md#apns-from-a-worker-with-a-real-key-2026-11-05) with a fake device token, so nothing has reached a phone from a Worker yet |
| Relay requests | Signed request checks, `RelayGuard`, and registering installations and workspaces, [tested on real Cloudflare](../architecture/cloudflare-validation.md#relay-requests-on-real-cloudflare-2026-11-05). Key rotation is not built |
| Devices | Single-use grants, device registration, token rotation, and unregistering, on the relay. Tokens are encrypted at rest. Tested on real Cloudflare with fake tokens. The installation does not issue grants yet |
| Relay delivery | Accepting notifications, quotas, the queue, retries, each APNs answer, and the fixed payload, on the relay. Tested on a real queue and real APNs with a fake device token, so nothing has reached a phone from a Worker yet |
| Installation side | Signing key, discovery, lazy registration, grants, subscriptions, preferences, [fan-out](../architecture/background-jobs.md#push), and removal on losing access. [Tested on real Cloudflare](../architecture/cloudflare-validation.md#push-from-an-installation-on-real-cloudflare-2026-11-05) with fake device tokens. Nothing triggers `conversation_transferred`, `mention`, or `conversation_updated` yet: mentions do not exist in the product, and a transfer is sent as `conversation_assigned`. Subscriptions are not tied to a session, so ending one session leaves that device subscribed while another session lives |
| App | Registration with a build-time relay allowlist, token changes, opening a conversation from a notification, hiding a banner for the conversation on screen, notification settings, and unregistering on sign-out. [Tested on one real iPhone](../architecture/cloudflare-validation.md#on-a-real-iphone). The official variant allows only the managed relay. Not exercised on a phone: a real token change, a sign-out while offline, and several devices. Those are covered by tests with fakes |
| Exit check | [Done](#m3-exit-check) |

**Security review:** full relay threat model, ideally external. Not done.

<a id="m3-exit-check"></a>
### M3 exit check

| Criterion | Result | Evidence |
|---|---|---|
| A visitor message yields a push on the correct devices | **Met on one iPhone.** Several devices and two installations are shown with fake tokens and tests, not real phones | [iPhone](../architecture/cloudflare-validation.md#on-a-real-iphone), [live checks](../architecture/cloudflare-validation.md#relay-offline-private-mode-and-a-second-installation), `delivery.test.ts` |
| Invalid tokens removed, transient failures retried | **Met**, with the mock for each APNs reason, and production APNs for a fake token | `delivery.test.ts`, [APNs check](../architecture/cloudflare-validation.md#apns-from-a-worker-with-a-real-key-2026-11-05) |
| Replayed, stale, tampered, and unsigned requests rejected, one test per signed field | **Met** | `requests.test.ts` |
| Reused grant rejected. Non-allowlisted relay refused by the app | **Met**. The reused grant also on real Cloudflare | `devices.test.ts`, `registrar.test.ts` |
| A schema test proves the relay cannot hold content | **Met** | `requests.test.ts`, `devices.test.ts`, `delivery.test.ts` |
| Relay offline: messaging works and pushes catch up, or expire | **Met.** Catching up on real Cloudflare, expiry in tests | [Live checks](../architecture/cloudflare-validation.md#relay-offline-private-mode-and-a-second-installation), `push.test.ts` |
| The same relay build in `private` mode, against a test Apple identity | **Partly met.** Private mode works on real Cloudflare, but with the same Apple key. A second identity needs a second Apple Developer account, or an independent reviewer's | [Live checks](../architecture/cloudflare-validation.md#relay-offline-private-mode-and-a-second-installation) |

**Limits**

- **The managed relay is in private mode**, at `openchat-relay.orangolabs.com`. Opening it needs legal review of terms and a privacy policy ([Q5](../architecture/open-questions.md)). It has been checked end to end with a fake device token, and no phone has used it yet, because the phone test used a temporary relay.
- **Not built:** rotating an installation's signing key or `RELAY_TOKEN_KEY`; `/health/notifications`; delivery metrics for the operator; an operator route to revoke an installation, which today means editing the relay's D1 by hand.
- **Triggers missing:** `mention`, because mentions do not exist; `conversation_transferred`, sent as `conversation_assigned`; `conversation_updated`.
- **Not measured:** throughput; the relay's rate limit bindings on real Cloudflare; the daily self-check firing from cron.
- **Not exercised on a phone:** a real token change, sign-out while offline, and more than one device.
- Subscriptions are not tied to a session, so ending one session leaves that device subscribed while another session lives.
- Push text is English only.

## M4: Email and automation (L)

Provider abstraction. Templates. Rule model, cron sweep, and evaluation with `automation_runs`. Consent capture, unsubscribe, and suppressions. Email is for follow-ups and account email only ([A15](../architecture/spec-review.md#amendments-to-the-specification)). The operator page for failed jobs, and contact export and erasure, moved to M6.

**Exit (spec Phase 4, plus)**

- A qualifying inactive conversation sends one follow-up, even with duplicate deliveries and overlapping sweeps.
- A browser disconnect alone triggers nothing.
- Unsubscribed contacts and those without consent are excluded, checked immediately before sending.
- Failed jobs are recorded with IDs only, in `failed_jobs`. A page to see and replay them moved to M6.
- A provider outage does not affect messaging.

**Depends on:** Q12, Q13.

**Status: exit criteria met**, with the limits in the [exit check](#m4-exit-check).


| Slice | State |
|---|---|
| Email sending | Done. Its alerts to members were removed again, by the owner's decision |
| Consent and unsubscribe | Done. [Tested on real Cloudflare](../architecture/cloudflare-validation.md#follow-up-email-on-real-cloudflare-2026-11-06) |
| Follow-up automation | Done. [Tested on real Cloudflare](../architecture/cloudflare-validation.md#follow-up-email-on-real-cloudflare-2026-11-06) |
| Transcripts, operations page, export and erasure | Dropped from M4 by the owner. Export, erasure, and the operations page are in M6 |
| Exit check | [Done](#m4-exit-check) |

<a id="m4-exit-check"></a>
### M4 exit check

Run on 2026-11-06 on a temporary installation, since removed, sending through Cloudflare Email Sending from `no-reply@holfun.com` to an outside Gmail address. Two workspaces, Acme Test and Beta Test, each had a follow-up rule of 5 minutes.

| Criterion | Result | Evidence |
|---|---|---|
| A qualifying inactive conversation sends one follow-up, even with duplicate deliveries and overlapping sweeps | **Met.** On real Cloudflare, each consenting visitor got exactly one follow-up per quiet period, sent about a minute after it was due, and a new public message started a new one. Duplicates and overlapping sweeps are shown in tests | [Live check](../architecture/cloudflare-validation.md#follow-up-email-on-real-cloudflare-2026-11-06), `follow-ups.test.ts` |
| A browser disconnect alone triggers nothing | **Met.** A visitor socket opened and closed, and nothing was queued or sent until the wait had passed. Nothing in the follow-up path reads sockets | Live check, `follow-ups.test.ts` |
| Unsubscribed contacts and those without consent are excluded, checked immediately before sending | **Met.** A visitor who did not tick the box got nothing. The owner unsubscribed from the Acme email: the page confirmed it, Acme listed the address, and Acme's next quiet period sent nothing, while Beta went on sending | Live check, `follow-ups.test.ts`, `email-consent.test.ts` |
| Failed jobs are recorded with IDs only | **Met** in tests. On real Cloudflare the one failure recovered by retry, so nothing reached `failed_jobs` | `api.test.ts` |
| A provider outage does not affect messaging | **Met.** With the sender address broken, the follow-up failed and retried, while a supervisor and the visitor kept messaging. Restoring it sent the follow-up 13 seconds later, once | Live check |

**Limits**

- **Email has two uses only**, by the owner's decision ([A15](../architecture/spec-review.md#amendments-to-the-specification)): follow-ups and account email. No alerts to members, transcripts, or weekly summary.
- **One fixed template**, with no message text. It cannot be edited per workspace yet.
- **A new rule, or a shorter wait, reaches a conversation only after its next public message.**
- **Gmail did not show its own Unsubscribe button**, which it keeps for senders it treats as bulk mail. The unsubscribe link in the body works, and the `List-Unsubscribe` headers reached Gmail, but one-click from a mail app has not been seen working.
- **Not seen on real Cloudflare:** `E_RECIPIENT_SUPPRESSED` after a bounce or complaint, and bounces or complaints reaching our own list, since subscribing to Cloudflare's events is not built.
- **A crash between sending and recording** leaves that email unsent, and an answer lost after Cloudflare accepted a send can send twice, because Cloudflare documents no idempotency key.
- **Not measured:** the daily sending limit, and delivery to mail providers other than Gmail.
- **Moved to M6:** contact export and erasure, and a page to see and replay failed jobs.

## M5: Independent deployment (L)

Polished CLI: `deploy`, `upgrade`, `relay deploy`, `relay set-apns`. White-label variant system and build profiles. Complete self-hosting and iOS guides. Upgrade test from the previous tag in CI.

**Exit (spec Phase 5)**

- **Run by someone who did not build it, following only the documentation:** deploys the backend and a relay, and builds a signed app under a separate Apple account, with push working and no managed credentials.
- The official app still connects to that installation, without push and with a clear explanation.
- Upgrade test passes, including rollback.

**Status**

| Slice | State |
|---|---|
| `oc relay deploy`, `set-apns`, `allow`, `check` | Built. Tested with a fake Wrangler, and on real Cloudflare with a real key ([validation](../architecture/cloudflare-validation.md#relay-cli-on-real-cloudflare-2026-11-06)) |
| `oc upgrade` and `oc rollback`, with a CI upgrade test from v0.1.0 | Built. The CI test runs both versions on local D1. The commands are tested with a fake Wrangler and on real Cloudflare |
| White-label variant template and `oc app variant` | Not started |
| Self-hosting guide, to be followed literally | Not started |
| Exit check, run by the owner on their own account | Not started. A separate Apple account stays a limit |

## M6: Hardening and release (M)

Contact export and erasure, which must also delete `email_unsubscribe_links`. A page to see and replay failed jobs. Retention settings. Audit log UI. Accessibility pass on widget and dashboard. Widget translations. Monitoring guides and alert recommendations. Backup and restore rehearsal. External security review. App Store submission. Licence and CLA checks. Public documentation, `security.txt`.

**Exit:** both acceptance journeys in spec §20 are demonstrated end to end on production infrastructure, with recordings or logs. Known issues published.

## M7+: Advanced features

Spec Phase 6 list, plus search (FTS5), webhooks, inbound email, signed visitor identity, and a Notification Service Extension. Prioritise from user feedback.

## Mapping to spec §20

| Journey step | Milestone |
|---|---|
| 1. Developer deploys | M1a |
| 2. Create workspace, register website | M1a |
| 3 to 7. Widget, visitor, agent, reply | M1b |
| 8. Push on iOS | M3 |
| 9. Reply from iOS | M2 |
| 10. Email follow-up | M4 |
| 11, 12. Second installation, same app | M2 |
| Independence journey | M5 |
| Messaging works without a relay | M3, by test |

## Risks to the plan

| Risk | Trigger | Response |
|---|---|---|
| APNs from Workers fails (S1) | Spike or later production failure | Build `HttpGatewayTransport` before M3 |
| Hibernation or RPC behaves differently than documented (S2) | Spike | Adjust realtime design before M1b |
| D1 too slow under realistic load | M1b load test | Reduce writes, batch cursors, and revisit single database |
| scrypt too slow or memory-bound (S3) | Spike | Argon2id in WASM |
| App Review rejection | M6 | Allow time. Submit an early TestFlight build during M3 to surface issues sooner |
| Scope growth | Any time | Advanced features stay in M7+ until both journeys pass |
