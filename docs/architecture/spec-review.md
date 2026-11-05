# Specification review

Review of [REQUIREMENTS.md](../../REQUIREMENTS.md). Decisions the owner must make are in [open questions](open-questions.md); this document explains why they matter.

## Summary

The specification is sound in direction. Cloudflare can support the product, and nothing here forces a conventional server. Six findings changed the design substantially:

1. **APNs from Workers relies on undocumented behaviour** (R-01). It appears to work in production and cannot work locally.
2. **The relay protocol has no way to prove a device agreed to a workspace** (G-01), so anyone could register and try to push to any token they obtain.
3. **Workspace IDs alone cannot route a push** (G-02), because independent installations can collide or lie.
4. **A runtime-configurable relay URL would let a malicious installation harvest device tokens** (G-03).
5. **AGPL conflicts with App Store distribution and will deter widget adoption** (R-02).
6. **The Free plan cannot run this product** (R-03), primarily because of the 10 ms CPU limit.

## Technical risks

| ID | Risk | Severity | Response |
|---|---|---|---|
| R-01 | **APNs requires HTTP/2.** `workerd` has no HTTP/2 client. A Cloudflare maintainer says production requests "apparently" upgrade through the proxy stack, and that there are no active plans to add it to `workerd`. Nothing documents this as guaranteed. | High | Pluggable transport with a fallback gateway ([ADR-0006](decisions/0006-apns-transport.md)). Spike S1 in Phase 0. Mock in local development. |
| R-02 | **AGPL and the App Store.** The FSF has held that GPL terms conflict with App Store terms; VLC was removed in 2011 after a contributor complained. Customers building white-label apps inherit the problem. An AGPL widget embedded in customer sites will also deter adoption. | High, and costly to fix later | Licence split decided before the first external contribution ([ADR-0011](decisions/0011-license-boundaries.md)). Needs legal review. |
| R-03 | **Free plan unworkable.** 10 ms CPU per request rules out safe password hashing. Also 50 D1 queries per invocation, 500 MB per database, 100,000 requests per day. Cloudflare Email Sending also needs a paid plan. | High | Workers Paid is the documented baseline ([ADR-0009](decisions/0009-paid-plan-and-password-hashing.md)). |
| R-04 | **D1 database cap of 10 GB, single-threaded.** At roughly 1 KB per message with indexes, about 10 million messages. All tenants share one queue, so one busy workspace slows the rest. | Medium for MVP, high at scale | Short queries, per-workspace rate limits, a size alert at 70%, retention and archive to R2 after MVP. Multiple D1 databases remain possible behind the repository layer. |
| R-05 | **No interactive transactions.** Read-decide-write races are easy to write and pass tests. | High | Enforced write patterns, tested on SQLite. An early prototype of this design had such a bug. See [ADR-0003](decisions/0003-d1-write-patterns.md). |
| R-06 | **Reconnect storms.** A forced Durable Object reset drops all sockets, and catch-up reads then hit D1, which is single-threaded. | Medium | Full-jitter backoff, deferred code updates, no eager history fetch |
| R-07 | **Version skew in three places.** Between Worker and old Durable Object code; between Worker and schema; between the official app and installations that upgrade whenever they choose. | High | Additive RPC, expand/contract migrations, and an API compatibility contract published by each installation |
| R-08 | **Provider token churn.** APNs rejects tokens refreshed more than about once every 20 minutes. Many Worker isolates each minting their own token could trigger `TooManyProviderTokenUpdates`. | Medium | One `ApnsCredential` Durable Object per Apple identity |
| R-09 | **Rate limiting binding is approximate.** It applies per location, and only supports 10 or 60 second periods. Cloudflare recommends a Durable Object for a strict global limit. | Medium | Use the binding for abuse damping, and a Durable Object where strictness matters (relay quotas, login) |
| R-10 | **Anonymous abuse.** Anyone can read `websiteKey` from page source and create conversations or upload files to storage the customer pays for. Origin checks do not stop non-browser clients. | Medium | Layered limits, upload quotas, optional Turnstile. See [security](security.md). |
| R-11 | **Stored XSS through attachments.** The dashboard and attachments share one origin. | Medium | `Content-Disposition: attachment`, `nosniff`, and a sandbox CSP on all attachment responses |
| R-12 | **App Review.** Guideline 2.1 requires a working demo account and live backend. An app that shows nothing until a server URL is entered needs one the project keeps online. | Medium | Project-operated demo installation, or an Apple-approved demo mode |
| R-13 | **Trademark.** The working name in the brief used a third party's product name. Resolved by choosing OpenChat, though that name is itself used by unrelated projects and has not been through a trademark search. Renaming later touches the npm scope, the bundle ID (permanent for an App Store listing), domains, and docs. | Medium, cheap to fix now | Choose a name before Phase 0 publishes anything |
| R-14 | **Managed relay is a real service.** The project becomes an operator with uptime, abuse, cost, and privacy duties, including for personal data such as device tokens. | Medium | Owner decision on operator and funding. Relay remains replaceable. |
| R-15 | **Beta dependencies.** Cloudflare Email Sending is in public beta, and D1 read replication status is unclear. | Low | The email abstraction stays vendor neutral. Read replication is off, behind a seam. |

## Architectural gaps

| ID | Gap | Resolution |
|---|---|---|
| G-01 | **No device consent.** §4.3 authenticates the workspace but nothing proves a device agreed to receive its pushes. | A device submits a short-lived grant signed by the installation. Only the device can create a subscription. |
| G-02 | **`workspaceId` is not a global identifier.** The §3.3 payload and §4.3 request cannot identify which installation sent them. Independent installations choose their own IDs. | Add `installationId` everywhere. The relay trust root is the installation key, with workspaces registered beneath it. |
| G-03 | **Relay URL as runtime configuration (§14)** lets a malicious installation point the official app at its own relay and collect tokens. | The relay allowlist is fixed at build time. An installation's advertised relay must match it, or push is disabled for that connection. |
| G-04 | **`Devices.device_token` in the installation database (§6)** contradicts "the relay owns delivery" and spreads tokens across every customer. | Installations store an opaque `relay_subscription_id`. |
| G-05 | **Open relay registration is unspecified.** §1 forbids a mandatory subscription, so anyone must be able to register on the managed relay. | Proof of domain control through a well-known document, per-installation quotas, and server-defined notification text. G-01 limits the blast radius to users who connected to that installation. |
| G-06 | **Token rotation across workspaces.** One APNs token can serve several installations, some possibly offline when it changes. | A relay-level device resource authenticated with a device secret, so one call updates every subscription. |
| G-07 | **"Create an account" in the app (§3.1)** has no backend under the no-SaaS principle. | Remove it. Sign-in happens per installation ([ADR-0010](decisions/0010-no-global-mobile-account.md)). |
| G-08 | **Password reset depends on email, but email settings are per workspace.** A user is not in a workspace when logged out, and a new install has no email at all. | Installation-level system email, plus a CLI recovery command for operators. Basic email moves to Milestone 1. |
| G-09 | **Workspace credentials cannot be Workers Secrets.** §9 requires this, but per-workspace email credentials are created at runtime. | AES-GCM in D1, with the key held in a Worker secret and key versioning. |
| G-10 | **Message status is undefined.** No definition for `delivered` or `read`, and with multiple agents the meaning is ambiguous. | Defined in [conventions](../api/conventions.md#message-status). Stored as cursors. |
| G-11 | **No version compatibility policy.** The official app will talk to installations of any age. | `/.well-known/openchat.json` publishes supported API versions. The app shows an upgrade prompt when out of range. |
| G-12 | **No workspace creation policy.** Who may create a workspace, and how the first owner appears, is unspecified. | Invite-only by default; the first owner comes from the deploy CLI. |
| G-13 | **Free-form `metadata` in relay requests** could carry content and break the "no conversation data" promise. | Closed schema: unknown fields are rejected. |
| G-14 | **`/health/queues` cannot be implemented as implied.** A Worker binding cannot read queue depth. | Report the age of the last cron run and consumer heartbeats. Depth comes from Cloudflare's metrics. |
| G-15 | **Workspace-scoped ordering was unaddressed.** "Message ordering" is tested in §16 but no mechanism is specified. | Per-conversation `seq`, assigned atomically in SQL. |
| G-16 | **Spec entities missing for stated requirements:** audit logs, suppression lists, consent, tags, invitations, sessions. | Added to the [schema](../../packages/database/src/schema/index.ts). |
| G-17 | **Contact merge and multi-device visitors.** `contacts.visitor_id` allows only one browser per contact. | A separate `visitors` table. |
| G-18 | **Data lifecycle.** No retention, export, or erasure requirement, although the product stores personal data for customers subject to GDPR and similar laws. | Contact export and erasure are in the plan. Retention settings follow in Milestone 6. |
| G-19 | **Search is absent**, though an inbox without search will be an early request. | Out of MVP. D1 supports FTS5, so it can be added as a later migration. |
| G-20 | **Local multi-Worker fetch.** A Worker cannot reach another on the same zone by route or `workers.dev` with plain `fetch` (error 1042) unless a flag or service binding is used. Affects independent mode in one account. | The relay client supports a service binding as well as a URL. Tested in spike S6. |

## Conflicts inside the specification

| Conflict | Resolution |
|---|---|
| §2.2 lists canned responses and assign-to-team as inbox features; §17 Phase 6 lists "canned responses" and "multiple teams" as future. | Phase 6 wins. Schema addition is additive. **Owner to confirm.** |
| §2.1 shows "business availability"; §17 lists "business hours" as future. | MVP: availability means an agent is online, or a manual toggle. Schedules in Phase 6. |
| §17 Phase 2 includes push registration, which needs the Phase 3 relay. | Move registration to Milestone 3. |
| §13 expects a deploy wizard for the standard journey, but §17 delivers the CLI in Phase 5. | A basic scripted deploy arrives in Milestone 1, because every later milestone must "verify deployment". The polished CLI stays in Milestone 5. |
| §5.2 asks for a modular monolith; §12 lists `realtime` and `email-worker` as separate services. | The modular monolith wins. They become packages ([ADR-0001](decisions/0001-worker-topology.md)). |
| §6 places notification preferences in the installation; §4.1 also lists them in the relay. | The installation owns per-event preferences. The relay holds only a per-device mute. |
| §12 has `infrastructure/migrations` while §5.2 favours modular packages. | Migrations live beside the schema in `packages/database/migrations`. |
| §5.1 suggests Pages or Workers. | Workers static assets, deployed atomically with the API. |
| §4.3 sets the example `recipientId` to `agent_123` while §3.1 warns IDs do not span installations. | `recipientId` is the installation's `memberId`, meaningful only under that installation. |

## Amendments to the specification

These take effect on acceptance of this review. `REQUIREMENTS.md` stays unchanged as the original brief.

| # | Section | Amendment |
|---|---|---|
| A1 | §3.1 | Remove the global account step. Connecting means signing in to an installation. |
| A2 | §3.3 | Registration goes: authenticate, obtain a grant from the installation, register with the relay, store the returned handle at the installation. |
| A3 | §3.3, §4.3 | Add `installationId` to the notification payload, request, and signature. |
| A4 | §4.3 | Use Ed25519 only. Add `POST /v1/installations/register` and `POST /v1/devices/token`. Close `metadata`. |
| A5 | §6 | Replace `Devices` with `push_subscriptions`. Add the tables in [the schema](../../packages/database/src/schema/index.ts). Add `seq` and `visibility` to messages. |
| A6 | §8.1 | Extend `EmailProvider.send` with `from`, `replyTo`, `headers`, and `idempotencyKey`. |
| A7 | §12 | Repository layout per [monorepo](monorepo.md). |
| A8 | §14 | `notificationRelayUrl` becomes a build-time allowlist. `apiUrl` becomes optional, set only when a white-label app is locked to one installation. |
| A9 | §15 | Detailed health endpoints require operator authentication. A public `/health` returns status only. |
| A10 | §17 | Milestone changes per [milestones](../plan/milestones.md). |
| A11 | §1, §3.1, §17, §20 | The app connects to one installation at a time and switches between its workspaces ([ADR-0014](decisions/0014-one-installation-in-the-app.md)). |
