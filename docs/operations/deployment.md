# Deployment and upgrades

Managed and independent configurations stay separate (spec rule 18). Only the configuration differs, and all code comes from the same tagged release.

## Requirements

- Cloudflare account on **Workers Paid** ([ADR-0009](../architecture/decisions/0009-paid-plan-and-password-hashing.md)).
- A domain on Cloudflare is recommended. `workers.dev` also works.
- For email: an email provider or Cloudflare Email Sending.
- For push, either nothing (managed relay), or an Apple Developer account (independent).

## Resources per installation

| Resource | Name |
|---|---|
| Worker | `oc-<name>` |
| D1 | `oc-<name>` |
| R2 | `oc-<name>-attachments`, private |
| Queues | `oc-<name>-notifications`, `-email`, `-jobs`, each with a `-dlq` |
| Durable Objects | `WorkspaceHub`, `ConversationRoom`, plus an auth guard |
| Analytics Engine dataset | `oc_<name>`. Opt-in with `analyticsEngine: true` in deployment state, because it must first be enabled once per account in the Cloudflare dashboard, or the deploy fails |
| Secrets | `AUTH_SIGNING_KEY`, `TICKET_SIGNING_KEY`, `RELAY_SIGNING_KEY`, `DATA_ENCRYPTION_KEY`, email provider credentials |

## Configuration model

Wrangler can write generated IDs back into its config file, which would dirty a checked-out repository and make upgrades awkward. So:

```text
services/api/wrangler.template.jsonc     committed, no IDs
         +
.openchat/<env>/state.json             local, no secrets; resource IDs and domain
         |  rendered by the CLI
         v
.openchat/<env>/wrangler.jsonc         generated, ignored by Git
```

Bindings in Wrangler environments are mostly non-inheritable, so one rendered file per deployment is simpler and less error-prone than a growing `env` block.

Wrangler remains the deployment engine, as the spec requires. The `cf` CLI is in beta and is not adopted. The CLI wrapper keeps that choice replaceable.

Durable Object classes are declared using `exports`, which Cloudflare prefers for new Workers. This works with the Vitest plugin, `wrangler dev`, and a real deploy.

**Preview and teardown.** `node tooling/scripts/preview.mjs preview-<name>` creates a throwaway installation, verifies it, and removes it. Order matters when removing one: queue consumers first, then the Worker, then queues, R2, and D1, because Cloudflare refuses to delete a Worker that consumes a queue or a queue that is bound to a Worker.

**D1 location.** The primary is placed near whoever creates the database unless `--location` is given. Choose it deliberately, because it fixes write latency for every user.

## Fresh install: `oc deploy`

Delivered in basic form in Milestone 1, and polished in Milestone 5. Every step is idempotent, so a failed run can be resumed.

| # | Step | How | Spec §13 |
|---|---|---|---|
| 1 | Authenticate | `wrangler login` or `CLOUDFLARE_API_TOKEN` | 1 |
| 2 | Select account | `wrangler whoami`, prompt | 2 |
| 3 | Pre-flight | Plan check, name collisions, version check | |
| 4 | Create resources | Wrangler, recording IDs in `state.json` | 3 |
| 5 | Generate secrets | Generated locally, set through `wrangler secret`, **never written to disk** | 6 |
| 6 | Apply migrations | `wrangler d1 migrations apply --remote` | 4 |
| 7 | Build and deploy | Dashboard and widget, then Worker | 5 |
| 8 | Domain | Custom Domain if given | 7 |
| 9 | Initialise | One-time signed bootstrap: creates installation identity, first owner, and workspace | 8 |
| 10 | Register with relay | If push is enabled | |
| 11 | Verify | Health checks, plus a synthetic visitor message end to end | 9 |
| 12 | Print | Dashboard URL, widget snippet, and the restore command | 10 |

## Upgrades: `oc upgrade`

A migration and a deploy are not atomic. Safety relies on the [expand/contract rule](../architecture/data-model.md#migration-strategy).

1. Check out the release tag, install with a frozen lockfile, and compare versions.
2. Refuse the upgrade if the release notes declare a required intermediate version.
3. Record the D1 Time Travel bookmark.
4. Apply migrations. The *old* Worker keeps running against the new schema.
5. Deploy the new Worker.
6. Durable Objects update on hibernation, or at `max_delay`.
7. Verify, and print the result.

| Failure | Response |
|---|---|
| Migration fails | Stop. The old Worker keeps running. Behaviour of a partly applied file is still to be confirmed (S4) |
| New Worker is unhealthy | `wrangler rollback`. The schema stays, which is safe under expand/contract |
| Data corruption | Time Travel restore. **Destructive, and it discards later writes.** Last resort |

## CI/CD

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR | Lint, typecheck, test, build, contract and migration drift, secret scan, bundle budget, licence check |
| `preview.yml` | On demand | Deploy a preview installation with a test account |
| `release.yml` | Tag | Build artifacts and release notes, with compatibility statement |
| `managed-relay.yml` (managed only) | Tag, manual approval | Deploy the managed relay. Uses protected environment secrets |

Community forks can run all but the last. Nothing else depends on project-held credentials.

## Managed relay (project operators)

- Separate Cloudflare account, restricted access, and `deployment/managed/` for non-secret configuration.
- `RELAY_MODE=open`, with the APNs key set by `wrangler secret`. **It is never in the repository or any customer-facing artifact.**
- Runs both APNs environments, because development builds use sandbox while TestFlight and App Store builds use production.
- Monitoring: delivery rate, APNs error reasons, connection-lost errors, queue age, and quota breaches.
- Needs an owner decision on operator, terms, and privacy ([Q5](../architecture/open-questions.md)).

## Independent relay (customers)

```bash
pnpm oc relay deploy --env production
pnpm oc relay set-apns \
  --team-id ABCDE12345 --key-id KEY1234567 \
  --key-file ./AuthKey_KEY1234567.p8 \
  --bundle-id com.company.support
pnpm oc relay allow --installation inst_01JC...
```

`set-apns` sets secrets through Wrangler and does not copy the key elsewhere. The customer then builds their app per [the iOS guide](../ios-build/expo-and-white-label.md), and points the installation to the relay:

```bash
pnpm oc config set relay --url https://relay.company.com --bundle-id com.company.support
```

If both Workers are on one zone, use a service binding or Custom Domain, since plain `fetch` to a `workers.dev` or route target on that zone can fail with error 1042.

The second acceptance journey in spec §20 is then tested in CI as far as is practical, using the mock transport, and manually against APNs for each release.

## Operations

| Task | Procedure |
|---|---|
| Rotate a signing key | Add new key, deploy, wait out the token lifetime, remove the old key |
| Rotate the relay key | Register a new key with the relay, switch, revoke the old key |
| Reset an owner's password with no email configured | `oc admin reset-password`, which issues a one-time link. It must run with deploy credentials |
| Inspect failed jobs | Dashboard operator page, or `oc jobs failed` |
| Disable push | Remove relay configuration. Messaging is unaffected |
| Backup | Time Travel covers 30 days. For longer, `oc backup` uses `wrangler d1 export` to R2 or local disk. An export may block other queries, so schedule it off-peak, and read the current documentation first |
| Restore | See Upgrades. Practise this before relying on it |

## Health checks

`/health` is public and returns status only. The following need an operator token, per [amendment A9](../architecture/spec-review.md#amendments-to-the-specification):

| Endpoint | Checks |
|---|---|
| `/health/database` | `SELECT 1` latency, migration version, size against the 10 GB limit |
| `/health/queues` | Cron heartbeat age, oldest undispatched outbox row, unreviewed failed jobs |
| `/health/realtime` | RPC round trip to a probe object |
| `/health/notifications` | Relay reachable, and signature accepted. **Failure here is a warning, not an outage** |

## Cost

Measure costs during Milestone 1 and publish typical figures. The main drivers will be Worker requests, Durable Object wakes, D1 rows read, and R2 storage. Vendor pricing is not repeated here because it changes.
