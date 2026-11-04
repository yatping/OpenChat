# Local development

Verified from a clean copy of the repository on 2026-11-03. Commands marked *(M1)* or later arrive with those milestones.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | 24, from `.nvmrc` | |
| pnpm | Pinned through `packageManager` in `package.json` | |
| Wrangler | Project dev dependency | **Always `pnpm exec wrangler`.** A global install can be years out of date, and old versions lack features this project relies on |
| Xcode, EAS CLI | Mobile only | |

No Cloudflare account is needed for ordinary local development.

## First run

```bash
pnpm install
pnpm dev:setup     # creates .dev.vars, applies D1 migrations locally, seeds demo data
pnpm dev           # runs everything below
```

| Process | URL | Notes |
|---|---|---|
| Installation Worker | `http://localhost:8787` | API, Durable Objects, queues, cron, all simulated by Miniflare |
| Dashboard | `http://localhost:5173` | Vite with HMR, proxying `/api` and WebSockets to 8787. Keeps the production same-origin behaviour |
| Widget test page | `http://localhost:5174` | A plain host page on a *different origin*, so that CORS and Origin checks run for real |
| Relay *(M3)* | Same Wrangler session | Started with the installation by `wrangler dev -c ... -c ...`, so that the service binding works |

## Browser tests

`pnpm test:e2e` builds the dashboard and drives it in Chromium against a local Worker on port 8799, with its own state in `services/api/.wrangler/e2e` and a throwaway key, so it does not touch `pnpm dev`. Install the browser once with `pnpm --filter @openchat/e2e exec playwright install chromium`. Until the widget exists, tests play the visitor through its API.

## What runs locally

| Capability | Local | Fidelity |
|---|---|---|
| Workers, routing | workerd | High, the same runtime |
| D1 | Local SQLite through Miniflare | Good for SQL. **Does not reproduce latency, load, or overload** |
| Durable Objects, hibernation | workerd | Good. Eviction timing differs |
| Queues | Miniflare | Good for flow. Verify retry timing and DLQs in a deployed preview |
| Cron | `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"` | Manually triggered. `pnpm dev` passes `--test-scheduled` |
| R2 | Local files | Good |
| Rate limit binding | Simulated | Do not rely on exact numbers |
| Email | A `ConsoleEmailProvider` that prints each email, with its link, in the Worker's terminal | Not real delivery |
| **APNs** | **`MockApnsTransport` only** | **`workerd` has no HTTP/2 client, so real APNs cannot be reached locally** |

Local state lives in `.wrangler/state`. `pnpm dev:reset` removes and reseeds it.

## Things you must test on a deployed preview

Local development cannot prove these: APNs delivery, D1 performance and concurrency, real queue retries, Durable Object behaviour across deploys, and real email. Each developer or PR can deploy a preview installation with `pnpm oc deploy --env preview-<name>` *(M1)*.

## Testing

| Command | Runs | Environment |
|---|---|---|
| `pnpm test` | Unit and integration | Vitest. Worker code runs inside workerd through `@cloudflare/vitest-plugin`, with storage isolated per test file but **shared between tests in a file**, so tests reset their own data |
| `pnpm test:isolation` | Route-by-route tenant isolation | Same |
| `pnpm test:e2e` *(M1)* | Playwright against the local stack | |
| `pnpm lint`, `pnpm typecheck` | | |
| `pnpm verify` | Everything CI runs, apart from the audit and gitleaks | |
| `pnpm db:generate` | Generate a migration from schema changes | |
| `pnpm db:migrate:local` | Apply to local D1 | |
| `pnpm contracts:generate` | Regenerate OpenAPI | CI fails if it was forgotten |

## Secrets

`.dev.vars` is used by Wrangler locally and ignored by Git. `.dev.vars.example` has placeholders only. No secrets are read yet; from M1a, `pnpm dev:setup` generates development keys. Never reuse production keys locally.

## Mobile *(M2)*

Push does not work in a simulator without care, and Expo Go is unsuitable, so use a **development build**:

```bash
pnpm --filter mobile eas build --profile development
pnpm --filter mobile start --dev-client
```

iOS requires HTTPS for ordinary connections. To reach a local Worker, use a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`) rather than weakening App Transport Security. This also matches production. Push testing uses a physical device, a development build (sandbox environment), and a deployed preview relay.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Wrangler rejects config keys | Running a global Wrangler rather than `pnpm exec wrangler` |
| `Network connection lost` calling APNs | Running real APNs transport locally. Use the mock |
| Error 1042 between Workers | Fetching a Worker on the same zone. Use a service binding |
| WebSocket closes immediately with 4401 | Ticket older than 30 seconds, usually when paused in a debugger |
| `FOREIGN KEY constraint failed` in a fixture | Parent row belongs to a different workspace, which is the schema doing its job |
