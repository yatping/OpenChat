# Phase 0: Foundation tasks

**Status: complete except where [outstanding](#outstanding) says otherwise.**

## Approach

Build the skeleton the rest of the project stands on, and spend a small, bounded effort checking the assumptions that could change the architecture. The result has no product features, but every layer works: a Worker that runs locally and on Cloudflare, reads D1 through a scoped repository, serves a generated OpenAPI document, opens a hibernating WebSocket, and passes CI.

## Security implications

- Establishes repository rules before any secret exists: ignore patterns, secret scanning, and placeholder files.
- Spikes run in a throwaway Cloudflare account or namespace, and are removed afterwards. They use no customer data, and S1 sends no real push.
- Dependencies are pinned by lockfile, with automated update PRs and no install scripts by default.

## Tasks

Run in order, except that spikes can run in parallel with P0-02 onward.

### P0-01: Repository initialisation (S)

`git init` on a `main` branch, with `.gitignore`, `.editorconfig`, `.nvmrc`, licence files per Q2, `CONTRIBUTING.md`, and commit conventions.

**Done when:** first commit contains the existing docs and no secrets.

### P0-02: Workspace and toolchain (S)

`pnpm-workspace.yaml`, `turbo.json`, root scripts, shared `tooling/tsconfig` in strict mode, `tooling/eslint-config`, and Prettier.

**Check:** TypeScript 7 was released recently. Confirm that ESLint's parser, Vitest, Drizzle, `@cloudflare/workers-types`, and the Expo toolchain work with it. If any do not, pin TypeScript to the newest working version, and record why.

**Done when:** `pnpm build`, `lint`, `typecheck`, and `test` run on an empty graph.

### P0-03: Package skeletons and boundary rules (S)

Empty packages per [monorepo](../architecture/monorepo.md), with build, type, and test scripts. Boundary lint rules, plus a deliberately failing fixture proving each rule fires. `apps/mobile` is only a placeholder here; Expo is initialised after S7.

**Done when:** an import from `notification-relay` into `core` fails lint.

### P0-04: `packages/shared` (S)

ID generation (UUIDv7, Crockford base32, prefixes), typed errors, RFC 9457 helper, logger with a field allowlist, time helpers.

**Done when:** tested, including ID sort order, and the logger rejects unlisted fields at compile time.

### P0-05: `services/api` skeleton (M)

Hono app, health and discovery routes, `wrangler.template.jsonc`, compatibility date on or after 2026-04-07, and bindings for D1, R2, three queues with DLQs, and Analytics Engine. Durable Object stubs. Queue consumer and cron stubs. Config rendering script.

**Check:** declare Durable Objects through `exports`. If `@cloudflare/vitest-plugin` or Wrangler local dev cannot support it, fall back to `migrations` with `new_sqlite_classes`, and record the reason.

**Done when:** `pnpm dev` serves `/health` locally, and queue, cron, and DO stubs can each be triggered locally.

### P0-06: `packages/database` (M)

Port the draft schema (now removed) to Drizzle. Generate the first migration. Build the scoped repository pattern with one example. Add the raw-handle import rule. Add the CI check that all tables have `workspace_id` unless allowlisted. Port the SQL tests from the review. Delete the draft schema.

**Check:** whether Drizzle can express partial indexes, `WITHOUT ROWID`, and `COLLATE NOCASE`, and if not, how custom SQL fits in without drift (S8).

**Done when:** migrations apply to a clean local D1 and the ported tests pass in workerd.

### P0-07: `packages/api-contracts` and OpenAPI generation (M)

Zod base types, problem response, pagination, and the discovery and health routes from [the draft](../api/openapi.draft.yaml). Generate `openapi.json`, lint it with Redocly, and add the drift check. Port the WebSocket frames to Zod. Add `packages/api-client` with one typed call.

The rest of the draft stays as the design input for M1, so it is not deleted until M1b completes.

**Done when:** changing a schema without regenerating fails CI, and the client call is type-checked against the route.

### P0-08: `packages/notification-protocol` (S)

Port the types. Implement `canonicalSigningString`, with sign and verify, and test vectors published in the docs. A runnable mock relay is not part of this task.

**Done when:** tampering with each signed field in turn fails verification, in Node and workerd alike.

### P0-09: Realtime skeleton (S)

`WorkspaceHub` with `acceptWebSocket`, attachment, and auto-response, plus a Vitest integration test for connect, broadcast, and close. No auth or business logic yet.

**Done when:** the test passes in workerd, and a lint rule rejects `setTimeout` in these classes.

### P0-10: CI and deployment smoke test (M)

`ci.yml`: install with frozen lockfile, lint, typecheck, test, build, contract and migration drift checks, secret scan, and dependency audit. `preview.yml`: deploy to a test account, apply migrations to real D1, and check `/health`. Dependency update automation.

**Done when:** CI is green on a PR, with a failing case verified for each check. A preview deploys and is torn down.

### P0-11: Documentation pass (S)

Mark ADRs by spike results. Replace "Unverified" entries in [Cloudflare validation](../architecture/cloudflare-validation.md). Make `local-dev.md` match reality by following it on a clean checkout.

**Done when:** a new clone reaches a running stack by following only the docs.

## Spikes

Each spike is a small timeboxed experiment in `spikes/` or a throwaway repository. Its output is a paragraph in Cloudflare validation, not production code. If a spike contradicts the design, stop and update the ADR before continuing.

| ID | Question | Method | Needs | Pass | If it fails |
|---|---|---|---|---|---|
| **S1** | Can a deployed Worker reach APNs by HTTP/2? | Deployed Worker POSTs to the sandbox host with no credentials. Run repeatedly over a day, in the fetch, queue, and Durable Object contexts | Cloudflare account. **No Apple account** | Consistent `403 MissingProviderToken`, which only an HTTP/2 path can return | Prioritise `HttpGatewayTransport` and re-plan M3 |
| **S2** | Does hibernation behave as documented? | Sockets across idle, eviction, wake, and a deploy under `deferred`. Confirm auto-response timestamps, attachment survival, and new-Worker to old-object RPC | Cloudflare account | Sockets survive hibernation-based updates; nothing lost | Revise reconnect budget and `max_delay` |
| **S3** | Is scrypt practical? | Measure N=2^15, r=8, p=3 for CPU and memory, including several concurrent calls in one isolate | Cloudflare account | Under about 500 ms; no memory failures under expected concurrency | Argon2id in WASM; reconsider parameters per ADR-0009 |
| **S4** | Does real D1 match SQLite here? | Run the message and CAS batches concurrently; measure latency from several regions; test time functions in SQL, batch rollback, what a failed migration leaves behind, and behaviour when overloaded | Cloudflare account | Same results as the SQLite tests; documented latency and error shapes | Revise write patterns before M1b |
| **S5** | Is Ed25519 available? | Sign and verify in WebCrypto, across workerd, browser, and Hermes or a polyfill plan | Local, then deployed | Works in Workers. Mobile does not need to sign, only to carry grants | Use `node:crypto` in Workers |
| **S6** | Which Worker-to-Worker paths work? | Installation-to-relay by URL, by Custom Domain, and by service binding; relay fetch of well-known on the same and a different zone | Cloudflare account | A documented working path per deployment shape | Add required config to the CLI |
| **S7** | Does Expo SDK 58 give a raw APNs token on a real device, end to end? | Development build; `getDevicePushTokenAsync`; send a push with a manual script over HTTP/2 | **Apple account, iPhone.** Not blocking until M2 | A push received on a sandbox device | Evaluate a small native module |
| **S8** | Does the Drizzle to Wrangler pipeline hold? | Generated output with `migrations_dir` and `migrations_pattern`; custom SQL; `db:generate` drift check | Local | One reproducible pipeline | Handwrite SQL migrations and use Drizzle only for types |

## Expected files

```text
.github/workflows/{ci,preview}.yml
.editorconfig  .gitignore  .nvmrc  CONTRIBUTING.md  LICENSE
package.json  pnpm-workspace.yaml  turbo.json  pnpm-lock.yaml
tooling/{tsconfig,eslint-config}/
packages/shared/src/{ids,errors,problem,logger,time}.ts
packages/database/{src/schema/,src/repositories/,migrations/,drizzle.config.ts}
packages/api-contracts/{src/,generated/openapi.json}
packages/api-client/src/
packages/notification-protocol/src/{types,signing}.ts
packages/{core,auth,realtime,email,ui}/       skeletons, with realtime holding the hub
services/api/{src/index.ts,src/routes/health.ts,wrangler.template.jsonc,.dev.vars.example}
services/notification-relay/{src/index.ts,wrangler.template.jsonc}   /health only
apps/dashboard/, apps/widget/                 build-only placeholders
```

## Phase 0 definition of done

From spec §17, plus spike outcomes:

- [x] All packages build.
- [x] Lint and tests pass, locally and in CI.
- [x] Local Cloudflare development works, including D1, Durable Objects, queues, and cron. Durable Objects are exercised through tests, because Phase 0 has no public route to them.
- [x] Migrations apply to local and real D1.
- [x] OpenAPI generation and drift check work.
- [x] Boundary rules demonstrably reject violations.
- [x] A preview deployment succeeds and passes health checks. Run by hand: `preview.yml` itself has not run, because it needs repository secrets.
- [x] S1, S2, S3, S4, S5, S6, and S8 reported, with gaps in [the results](../architecture/cloudflare-validation.md#phase-0-spike-results). S7 deferred to M2, because it needs an Apple account and an iPhone. In M2 it passed on production rather than the sandbox: a raw token, and two pushes received on an iPhone.
- [x] Documentation matches reality, verified from a clean copy of the working tree. A clone is not possible until the first commit.
- [x] Outstanding issues are written down, and nothing untested is claimed as done.

## Outstanding

| Item | Why | Needs |
|---|---|---|
| `preview.yml` | Has never run. The same script passed when run by hand | Repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| S1 over a full day | Ran for 44 minutes | A longer run, before M3 |
| S6 with Custom Domains and across zones | Not tested, to avoid changing zones on the account | A test zone, before M3 |
| S5 on Hermes and browsers | Not tested. Mobile does not need to sign | Before anything on mobile signs |
| Three unexplained one-off results: a job that did not arrive in time, an HTML 404, and 48 messages after 50 sends | See [results](../architecture/cloudflare-validation.md#found-while-deploying) | M1b tests that count outcomes, and watching CI |
| Smart Placement | Tested in the [M1b load test](../architecture/cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04) and now the default. A brand-new deployment is unproven | Watch on the next real deployment |
| Name clearance | "OpenChat" is used by unrelated projects, and no trademark search was done | Owner, before publishing |

## Not in Phase 0

Authentication, business logic, dashboard or widget UI, Expo app, relay behaviour beyond `/health`, and deployment CLI beyond the config rendering needed for CI.
