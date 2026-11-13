# Documentation index

Suggested reading order for a new contributor is top to bottom.

## Start here

| Document | Purpose |
|---|---|
| [guide/](guide/README.md) | **For people who use OpenChat:** the inbox, administration, the website widget, and privacy |
| [known-issues.md](known-issues.md) | What does not work yet, what is untested, and what awaits a decision |
| [architecture/overview.md](architecture/overview.md) | The system, its deployables, and the main flows |
| [architecture/open-questions.md](architecture/open-questions.md) | Decisions the project owner still has to make |
| [plan/milestones.md](plan/milestones.md) | Milestone-by-milestone plan |
| [plan/phase-0.md](plan/phase-0.md) | The foundation's tasks, now done, kept for reference |

## Review of the brief

| Document | Purpose |
|---|---|
| [architecture/spec-review.md](architecture/spec-review.md) | Gaps, risks, conflicts, and amendments to the specification |
| [architecture/cloudflare-validation.md](architecture/cloudflare-validation.md) | Each platform assumption checked against current documentation |

## Architecture

| Document | Purpose |
|---|---|
| [architecture/monorepo.md](architecture/monorepo.md) | Repository layout, module boundaries, dependency rules |
| [architecture/data-model.md](architecture/data-model.md) | D1 design, write patterns, migration strategy |
| [`packages/database/src/schema`](../packages/database/src/schema/index.ts) | The schema, in Drizzle. Migrations are generated beside it |
| [architecture/realtime.md](architecture/realtime.md) | Durable Objects and the WebSocket lifecycle |
| [architecture/widget.md](architecture/widget.md) | Embedding the website widget, and its languages |
| [architecture/accessibility.md](architecture/accessibility.md) | What the widget and dashboard do for accessibility, and how it is checked |
| [architecture/background-jobs.md](architecture/background-jobs.md) | Queues, the outbox, and cron |
| [architecture/security.md](architecture/security.md) | Authentication, tenant isolation, threat model |
| [architecture/security-review-m1a.md](architecture/security-review-m1a.md) | Review of authentication and sessions, with accepted trade-offs and open decisions |
| [architecture/security-review-m1b.md](architecture/security-review-m1b.md) | Review of tenant isolation, visitor tokens, attachments, and XSS |
| [architecture/decisions/](architecture/decisions/) | Architecture decision records |

## Contracts

| Document | Purpose |
|---|---|
| [api/conventions.md](api/conventions.md) | REST and WebSocket conventions, how contracts are generated |
| [api/openapi.draft.yaml](api/openapi.draft.yaml) | MVP REST contract (OpenAPI 3.1) |
| [api/realtime-protocol.draft.ts](api/realtime-protocol.draft.ts) | WebSocket frames as shared TypeScript types |
| [notification-relay/protocol.md](notification-relay/protocol.md) | Relay protocol, authentication, and delivery rules |
| [notification-relay/openapi.draft.yaml](notification-relay/openapi.draft.yaml) | Relay REST contract |
| [notification-relay/protocol.draft.ts](notification-relay/protocol.draft.ts) | Relay shared TypeScript types |
| [legal/](legal/README.md) | **Drafts for a lawyer, not in force:** privacy policy, relay terms, data processing agreement, records of processing, and subprocessors for the managed relay |

Files named `*.draft.*` are design artifacts. Phase 0 moves them into `packages/`, after which the package is the source of truth and the draft is deleted.

## Build and operate

| Document | Purpose |
|---|---|
| [development/local-dev.md](development/local-dev.md) | Local development workflow, including what cannot run locally |
| [operations/self-hosting.md](operations/self-hosting.md) | **Step by step:** your own backend, with the official app or your own |
| [operations/deployment.md](operations/deployment.md) | Production deployment and upgrades, managed and independent |
| [operations/monitoring.md](operations/monitoring.md) | Health checks, what to alert on, and what to do when one fails |
| [operations/backup-and-restore.md](operations/backup-and-restore.md) | Backups, Time Travel, restoring, and what a restore does not put back |
| [operations/licensing.md](operations/licensing.md) | Licences, the DCO, what CI checks, the notices, and the source offer for an installation you changed |
| [operations/abuse-limits.md](operations/abuse-limits.md) | Every abuse limit, what people see, and how to change the four that are settings |
| [ios-build/expo-and-white-label.md](ios-build/expo-and-white-label.md) | Expo configuration, build profiles, and white-label builds |

## How facts in these documents were checked

Platform limits were read from vendor documentation on 2026-11-03 and can change. [Cloudflare validation](architecture/cloudflare-validation.md) records each source and marks what is documented, what is only observed, and what still needs a spike.
