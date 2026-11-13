# Architecture overview

## System in one picture

```text
 Visitor browser              Agent browser              OpenChat iOS app (not open source)
 widget.js (Shadow DOM)       React dashboard            Expo, one Connection per installation
      |  HTTPS + WSS               |  HTTPS + WSS              |  HTTPS + WSS         | APNs token
      v                            v                           v                      |
+---------------------------- Customer Cloudflare account ----------------------+    |
|  Installation Worker (one deployable, one origin)                             |    |
|    static assets: dashboard SPA, widget bundle                                |    |
|    Hono API  ->  modules  ->  scoped repositories                             |    |
|        |              |                     |                                 |    |
|        v              v                     v                                 |    |
|   Durable Objects    D1 (source of truth)   R2 (attachments)                  |    |
|   WorkspaceHub       one database           private bucket                    |    |
|   ConversationRoom        ^                                                   |    |
|        ^                  | outbox sweep (cron)                               |    |
|        |                  v                                                   |    |
|        +--- publish   Queues: notifications, email, jobs (each with a DLQ)    |    |
+---------------------------------|---------------------|-----------------------+    |
                                  | signed event        | provider API               |
                                  | (IDs only)          v                            |
                                  |                Email provider                    |
                                  v                                                  v
                       +------------------------------------------------------------------+
                       | Notification relay, run by the project (not open source)         |
                       | Worker + D1 + RelayGuard DO + Queue. Only per-phone ciphertext.  |
                       +------------------------------------------------------------------+
                                  |
                                  v
                                APNs  ->  device  ->  app fetches content from the installation
```

## Deployables

There are exactly two Workers. See [ADR-0001](decisions/0001-worker-topology.md). Only the Installation Worker is in this repository: the relay and the iOS app are not open source ([ADR-0019](decisions/0019-app-and-relay-leave-open-source.md)).

| Deployable | Contains | Owner |
|---|---|---|
| **Installation Worker** (`services/api`) | HTTP API, `WorkspaceHub` and `ConversationRoom` Durable Objects, queue consumers, cron, dashboard and widget assets | Customer |
| **Notification relay** (private repository) | Relay API, `RelayGuard` and `ApnsCredential` Durable Objects, delivery consumer | Project, as the managed relay |

The two share only `packages/notification-protocol`. Neither imports the other, and the relay has no credential that can read an installation.

## Core concepts

| Term | Meaning |
|---|---|
| **Installation** | One deployment of the Installation Worker, identified by `installationId` and an Ed25519 key pair. One company, which may have several isolated workspaces ([ADR-0016](decisions/0016-installation-admin-replaces-workspace-managers.md)). |
| **Workspace** | An isolated team or brand inside an installation. Workspace IDs are unique only within an installation as far as other parties are concerned. |
| **Member** | A user's membership in a workspace. `memberId` is the recipient identity shared with the relay, so no email or user ID leaves the installation. |
| **Connection** | Mobile-side record of one authenticated user on one installation. The unit of isolation in the iOS app. |
| **Device / Subscription** | Relay-side. A device holds an APNs token. A subscription links a device to an (installation, workspace, member). |

## The main flow: a visitor sends a message

1. The widget calls `POST /api/v1/widget/conversations/{id}/messages` with a `clientMessageId`.
2. The Worker verifies the visitor token and applies rate limits.
3. One D1 `batch()` inserts the message, advances the conversation, and writes an outbox row. **This is the commit point.** A retry with the same `clientMessageId` writes nothing and returns the original message.
4. The Worker returns 201 and, in `waitUntil`, publishes to `WorkspaceHub` and `ConversationRoom`, sends the queue message, and marks the outbox row dispatched.
5. Connected agents receive `message.created`. Clients order by `seq` and fetch any gap through REST.
6. The notification consumer resolves recipients, applies preferences, and sends signed events to the relay.
7. The relay resolves devices and calls APNs. The app opens, fetches from the installation, and navigates.

If step 4 is lost to a crash, a cron sweep re-dispatches from the outbox. If the relay is down, messaging is unaffected: only step 6 retries.

## Key design decisions

| Decision | Choice | Record |
|---|---|---|
| Worker topology | One Installation Worker plus one relay Worker | [0001](decisions/0001-worker-topology.md) |
| Realtime partitioning | Per-workspace hub for agents, per-conversation room for visitors | [0002](decisions/0002-durable-object-topology.md) |
| D1 consistency | `batch()`, conditions in SQL, transactional outbox | [0003](decisions/0003-d1-write-patterns.md) |
| Tenant isolation | Five independent layers, including composite foreign keys | [0004](decisions/0004-tenant-isolation.md) |
| Relay trust | Ed25519 installation keys, device-submitted grants, no tokens in installations | [0005](decisions/0005-relay-trust-model.md) |
| APNs transport | Pluggable, because Worker HTTP/2 is observed but not documented | [0006](decisions/0006-apns-transport.md) |
| Contracts | Zod is the source; OpenAPI and types are generated, with a CI drift check | [0007](decisions/0007-contract-source-of-truth.md) |
| Attachments | Streamed through the Worker, no presigned URLs | [0008](decisions/0008-attachment-transfer.md) |
| Baseline plan and passwords | Workers Paid, scrypt | [0009](decisions/0009-paid-plan-and-password-hashing.md) |
| Mobile identity | No global account | [0010](decisions/0010-no-global-mobile-account.md) |
| Licensing | AGPL core with permissive client components | [0011](decisions/0011-license-boundaries.md) |
| iOS builds | Local, with `expo prebuild` and fastlane. EAS is optional | [0012](decisions/0012-native-builds-without-eas.md) |
| iOS navigation | React Navigation, one navigator per connection and workspace. No Expo Router | [0013](decisions/0013-react-navigation-not-expo-router.md) |
| iOS connections | One installation at a time, switching between its workspaces | [0014](decisions/0014-one-installation-in-the-app.md) |
| Managing people | Installation admins. Removing and deactivating can be undone, and nobody deletes an account | [0015](decisions/0015-installation-admin-and-reversible-removal.md) |
| Administration | One company per installation. Its admins manage everything, and workspaces have only supervisors and agents. Managing does not include reading conversations | [0016](decisions/0016-installation-admin-replaces-workspace-managers.md) |

## Technology baseline

Versions were the latest published on 2026-11-03. The lockfile pins exact versions. **TypeScript is held at 6.0**, because `typescript-eslint` 8.72 requires a version below 6.1. Move to 7 when it supports that.

| Area | Choice | Latest at review |
|---|---|---|
| Runtime | Node 24 (dev only), workerd (production) | |
| Package management | pnpm workspaces, Turborepo | turbo 2.11 |
| Language | TypeScript, strict | 6.0 in use, 7.0 available |
| HTTP framework | Hono with `@hono/zod-openapi` | hono 4.13, zod-openapi 1.6 |
| Validation | Zod | 4.6 |
| ORM and migrations | Drizzle, applied by `wrangler d1 migrations` | orm 0.45, kit 0.31 |
| Cloudflare CLI | Wrangler | 4.157 |
| Backend tests | Vitest with `@cloudflare/vitest-plugin` | vitest 5.1, plugin 1.5 |
| Dashboard | React, Vite, Tailwind, TanStack Query | react-query 5.105 |
| Widget | Preact, with a small vanilla loader | preact 11.1 |
| Mobile | Expo, with React Navigation ([ADR-0013](decisions/0013-react-navigation-not-expo-router.md)), TanStack Query, and `expo-notifications`, built with `expo prebuild` and fastlane ([ADR-0012](decisions/0012-native-builds-without-eas.md)) | SDK 58 |
| E2E | Playwright | |
| Accessibility tests | axe-core through `@axe-core/playwright`, in end-to-end tests only ([ADR-0018](decisions/0018-axe-core-for-accessibility-tests.md)) | 4.14 |
| Metrics | Workers Analytics Engine, an addition to the spec's list | |

Spec constraints still hold: no PostgreSQL, Redis, Kubernetes, or conventional application servers. The only external dependencies are APNs and email providers.

## Failure behaviour

| Failure | What users see | Recovery |
|---|---|---|
| Relay or APNs down | No push. Messaging, dashboard, and sockets work normally. | Queue retries until expiry, then DLQ |
| Email provider down | Follow-ups delayed | Queue retries, then DLQ with replay |
| Durable Object reset or deploy | Socket drops and reconnects with jitter | Client resyncs from REST by `seq` |
| Queue send fails after commit | Slight push delay | Outbox sweep within about 2 minutes |
| D1 overloaded | REST returns 503 with `Retry-After`; client retries with the same `clientMessageId` | Idempotent retry |
| D1 data loss or bad migration | Outage | Time Travel restore, up to 30 days on Workers Paid |

D1 is the single dependency whose failure stops messaging. That is inherent in a one-database design and is accepted for the MVP.
