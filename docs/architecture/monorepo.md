# Monorepo structure and module boundaries

pnpm workspaces and Turborepo, per the spec. Differences from spec §12 are explained below the tree.

The iOS app and the notification relay were in this repository until [ADR-0019](decisions/0019-app-and-relay-leave-open-source.md). They are now in a private repository, which uses the packages they share with the server through a Git submodule of this one.

```text
openchat/
├── apps/
│   ├── dashboard/                React + Vite SPA. Built output served by the Installation Worker.
│   └── widget/                   Loader (vanilla) + chat UI (Preact). Same.
│
├── services/
│   ├── api/                      Installation Worker: composition root only.
│   │   ├── src/index.ts          fetch, queue, scheduled handlers; exports Durable Object classes
│   │   ├── src/routes/           Hono routes: parse, authorise, call a module, serialise
│   │   ├── src/consumers/        Queue consumers: dispatch to modules
│   │   ├── src/cron/             Sweeps
│   │   └── wrangler.template.jsonc
│
├── packages/
│   ├── core/                     Installation domain modules. One directory per module, see below.
│   ├── realtime/                 WorkspaceHub, ConversationRoom. Replaces services/realtime.
│   ├── email/                    EmailProvider interface, drivers, templates. Replaces services/email-worker.
│   ├── database/                 Drizzle schema, migrations, scoped repositories
│   ├── auth/                     Password hashing, tokens, RBAC policy. Pure functions.
│   ├── api-contracts/            Zod schemas, route definitions, WebSocket frames, generated OpenAPI
│   ├── api-client/               Typed client for the dashboard, and for the app in the private repository
│   ├── notification-protocol/    Relay schemas, signature and grant functions. No dependencies on the installation.
│   ├── shared/                   IDs, errors, logger, time. Runtime-agnostic, small.
│   └── ui/                       Dashboard design system
│
├── tooling/
│   ├── cli/                      Deploy and operator CLI
│   ├── eslint-config/
│   └── tsconfig/
│
├── docs/                         Architecture, decisions, contracts, guides
├── .github/workflows/
├── AGENTS.md, CLAUDE.md, README.md, REQUIREMENTS.md
├── pnpm-workspace.yaml, turbo.json, package.json, .nvmrc
```

## Differences from spec §12

| Spec | Here | Why |
|---|---|---|
| `services/realtime`, `services/email-worker` | `packages/realtime`, `packages/email` | Modular monolith ([ADR-0001](decisions/0001-worker-topology.md)) |
| `infrastructure/migrations` | `packages/database/migrations` | Migrations sit beside the schema they belong to. The relay's are in the private repository, with the relay |
| `infrastructure/cloudflare` | `wrangler.template.jsonc` in each service | Config stays with its Worker. The CLI renders it per deployment |
| `infrastructure/scripts` | `tooling/cli` | A tested TypeScript CLI, not loose scripts |
| (none) | `packages/core` | A home for domain logic that routes and consumers share |

## Modules inside `packages/core`

`auth-flows`, `workspaces`, `users`, `websites`, `visitors`, `contacts`, `conversations`, `messages`, `attachments`, `notifications`, `automation`, `settings`, `audit`.

Each module has this shape:

```text
packages/core/src/conversations/
├── index.ts          Public API: the only file other modules may import
├── service.ts        Use cases, taking a RequestContext
├── policy.ts         Permission rules
├── events.ts         Domain events it emits
└── service.test.ts
```

## Dependency rules

```text
services/api ──> packages/core ──> database, auth, realtime(types), email(interface), api-contracts(types), shared
     │                             │
     └──> packages/realtime ───────┤
     └──> packages/email ──────────┤
     └──> notification-protocol    │
                                   v
                                 shared

apps/dashboard ──> api-client, ui, api-contracts, shared
apps/widget    ──> api-contracts (types only), shared (selected functions)
```

Enforced with `eslint-plugin-boundaries` or an equivalent rule in CI:

| Rule | Reason |
|---|---|
| `services/notification-relay`, in the private repository, imports only `notification-protocol` and `shared` | The relay must stay independent. It cannot gain access to conversation types by accident. The rule stays in `@openchat/eslint-config`, which that repository uses |
| Nothing imports `packages/database/internal` except `packages/database` | Tenant isolation |
| `apps/*` never import `packages/core`, `database`, `realtime`, or `email` | Server code must not reach clients |
| Modules import each other only through `index.ts` | Keeps boundaries real |
| `routes/` does not import `packages/database` | Handlers call modules |
| `packages/shared` and `notification-protocol` use only Web-standard APIs | They run in Workers, browsers, and React Native, including in the private repository's app |
| `apps/widget` imports contract types only, with `import type` | Zod must not enter the widget bundle. Enforced by a bundle size budget |
| `packages/core` does not import `hono` or Cloudflare queue or Durable Object classes directly | Domain code talks to ports and stays testable |

## Ports between the domain and the platform

`packages/core` defines interfaces. `services/api` provides the Cloudflare implementations.

```typescript
interface RealtimePublisher { publish(event: DomainEvent): Promise<void>; revokeMember(w: WorkspaceId, m: MemberId): Promise<void>; }
interface JobQueue          { send(job: JobEnvelope): Promise<void>; sendBatch(jobs: JobEnvelope[]): Promise<void>; }
interface BlobStore         { put(key: string, body: ReadableStream, meta: BlobMeta): Promise<void>; get(key: string): Promise<BlobResult | null>; delete(key: string): Promise<void>; }
interface RelayClient       { send(n: NotificationRequest[]): Promise<RelayResult[]>; /* signing inside */ }
```

## Licensing boundaries

The proposed split in [ADR-0011](decisions/0011-license-boundaries.md) follows package boundaries. Each package declares its licence in `package.json`, and CI checks that permissive packages do not depend on AGPL ones.

| Licence | Packages |
|---|---|
| AGPL-3.0 | `services/api`, `apps/dashboard`, `packages/core`, `realtime`, `email`, `database`, `auth`, `ui`, `tooling/cli` |
| Permissive (proposed Apache-2.0) | `apps/widget`, `api-client`, `api-contracts`, `notification-protocol`, `shared` |

## Task graph

| Task | Depends on | Notes |
|---|---|---|
| `build` | `^build` | Dashboard and widget build before the API, which serves them |
| `typecheck` | `^build` | |
| `lint` | | |
| `test` | `^build` | Workers tests run in the real runtime |
| `contracts:generate` | `api-contracts#build` | Regenerates OpenAPI; CI fails on any diff |
| `db:generate` | | Drizzle; CI fails if the schema and migrations disagree |
