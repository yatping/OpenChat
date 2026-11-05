# Project context for developers and AI agents

OpenChat is an open-source,
Cloudflare-native customer messaging platform: a website widget, a team inbox, an iOS app,
a replaceable notification relay, and email follow-ups.

**Current state:** Milestone 1a is built and verified on real Cloudflare, with [items only the owner can close](docs/plan/milestones.md#m1a-status). Milestone 1b's exit criteria are met, with [limits and owner decisions listed](docs/plan/milestones.md#m1b-exit-check). Milestone 2's exit criteria, for the iOS app, are met, with [limits listed](docs/plan/milestones.md#m2-exit-check). Milestone 3's exit criteria, for relay and push, are met except for a second Apple identity, with [limits listed](docs/plan/milestones.md#m3-exit-check).

## Read before you change anything

| If you are working on | Read |
|---|---|
| Anything | [docs/README.md](docs/README.md), then [architecture overview](docs/architecture/overview.md) |
| Product requirements | [REQUIREMENTS.md](REQUIREMENTS.md), plus its [amendments](docs/architecture/spec-review.md#amendments-to-the-specification) |
| D1, queries, migrations | [data model](docs/architecture/data-model.md) |
| WebSockets, Durable Objects | [realtime](docs/architecture/realtime.md) |
| Queues, cron, retries | [background jobs](docs/architecture/background-jobs.md) |
| Auth, tenancy, secrets | [security](docs/architecture/security.md) |
| HTTP or WebSocket API | [API conventions](docs/api/conventions.md) |
| Push | [relay protocol](docs/notification-relay/protocol.md) |
| Expo, white labelling | [iOS build](docs/ios-build/expo-and-white-label.md) |

## Precedence when documents disagree

1. Accepted ADRs in `docs/architecture/decisions/`, newest first.
2. Other documents in `docs/`, including the amendments in `spec-review.md`.
3. `REQUIREMENTS.md`, which is kept unchanged as the original brief.

If a change contradicts an accepted ADR, write a new ADR that supersedes it. Do not edit the old decision.

## Rules that are easy to break

These are the mistakes this architecture is designed to prevent. Each one is enforced by a test or lint rule where possible.

1. **Tenancy.** Query workspace data only through scoped repositories. Importing the raw database handle is a lint error outside `packages/database`. Cross-tenant access returns 404, not 403.
2. **D1 has no interactive transactions.** Never read, decide in JavaScript, then write if the decision must hold at commit. Use `batch()` with conditions in SQL. A version check alone does not guard later statements in a batch; use `last_mutation_id`. See [data model](docs/architecture/data-model.md#write-patterns).
3. **Commit before broadcast.** A message reaches D1 before any socket or queue sees it. Sockets are a hint; clients recover from D1 through REST.
4. **Internal notes never reach visitors.** Visitor-facing code takes the `VisitorEvent` type and `visibility = 'public'` rows only.
5. **Nothing blocks Durable Object hibernation.** No `setTimeout`, `setInterval`, or outbound WebSockets in `WorkspaceHub` or `ConversationRoom`.
6. **Durable Object code must tolerate version skew.** Old objects can stay alive for the deferred update window after a deploy, so RPC changes are additive.
7. **Queue consumers are idempotent.** Delivery is at least once. Every job has an idempotency key and is acknowledged or retried explicitly.
8. **Migrations are expand/contract.** A migration and a Worker deploy are not atomic. Every migration must work with the previous Worker version.
9. **APNs tokens never enter an installation.** Installations hold opaque relay subscription handles.
10. **The relay never receives content.** Notification schemas are closed. Do not add free-form fields.
11. **Never log** passwords, tokens, keys, full message content, or personal data. Use the shared logger.
12. **Do not assume a platform limit.** Check [Cloudflare validation](docs/architecture/cloudflare-validation.md) and update it when you learn something new.

## Working agreement

- Work one milestone at a time. Before each one, state the approach, dependencies, security implications, and expected files.
- After each one, run tests, lint, type checks, and verify a deployment. Do not call something complete if it has not been tested.
- A stack addition outside the [agreed technology list](docs/architecture/overview.md#technology-baseline) needs an ADR.
- Update the relevant document in the same change as the code. Contract changes also update generated OpenAPI.
- Never commit secrets. Only placeholder values belong in `.dev.vars.example` files.

## Local tooling

Always run the project-pinned Wrangler through `pnpm exec wrangler`. A global install may be far out of date.
