# Deployment and upgrades

Managed and independent configurations stay separate (spec rule 18). Only the configuration differs, and all code comes from the same tagged release.

## Prerequisites

Run `pnpm oc preflight` to check them. It only reads, and `oc deploy` runs the same check before creating anything. It marks what Wrangler can't read as `confirm`, so check those yourself.

| Needed | When | How to set it up | How it is checked |
|---|---|---|---|
| Node 24 or newer, pnpm, and `pnpm install` | Always | See [local development](../development/local-dev.md#prerequisites) | Node version |
| Cloudflare login | Always | `pnpm --filter @openchat/api exec wrangler login`, or `CLOUDFLARE_API_TOKEN` | `wrangler whoami` |
| One chosen account | If the login reaches several | Set `CLOUDFLARE_ACCOUNT_ID` | Account count |
| **Workers Paid** ([ADR-0009](../architecture/decisions/0009-paid-plan-and-password-hashing.md)) | Always | Workers & Pages > Plans | **Confirm yourself.** Wrangler can't read the plan. If the login probe errors after a deploy, the CLI points here |
| **R2** added to the account | Always | Storage & databases > R2 > Overview, then complete the checkout. It's a one-time step | Lists buckets |
| D1 and Queues access | Always | Included in Workers Paid. An API token needs the edit permissions | Lists each |
| **`workers.dev` subdomain** | Unless every route is on your own domain, which `oc deploy` does not set up yet | Workers & Pages in the dashboard | **Confirm yourself.** The deploy stops with these instructions if it is missing, and running it again resumes |
| Analytics Engine | With `--analytics` | Enable once in the dashboard | Confirm yourself |
| Custom domain | With `--public-url` | A zone on Cloudflare, attached to the Worker. A domain is recommended, but `workers.dev` also works | Confirm yourself |
| Email | To deliver new account links and resets | Cloudflare Email Sending (a domain on Cloudflare DNS in this account, onboarded with `wrangler email sending enable <domain>`, and a login with `email_sending:write`), or a Resend API key and verified domain. Without either, use `oc recover` | Cloudflare: the domain is listed as onboarded. Resend: `--email-from` is present, and Resend is not contacted |
| Push | With `--relay-url`, `--relay-id`, and `--relay-bundle-ids`, all three together. The [managed relay](#managed-relay-project-operators) admits installations one at a time for now | Nothing for the managed relay, or an Apple Developer account for independent mode | Not checked yet |

A brand-new account has not been tried yet, so this list comes from Cloudflare's documentation and Wrangler's source, and may be incomplete.

## Resources per installation

| Resource | Name |
|---|---|
| Worker | `oc-<name>` |
| D1 | `oc-<name>` |
| R2 | `oc-<name>-attachments`, private |
| Queues | `oc-<name>-notifications`, `-email`, `-jobs`, each with a `-dlq` |
| Durable Objects | `WorkspaceHub`, `ConversationRoom`, plus an auth guard |
| Analytics Engine dataset | `oc_<name>`. Opt-in with `analyticsEngine: true` in deployment state, because it must first be enabled once per account in the Cloudflare dashboard, or the deploy fails |
| Secrets | `AUTH_SIGNING_KEY`, `TICKET_SIGNING_KEY`, `RELAY_SIGNING_KEY`, `DATA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, with the public `TURNSTILE_SITE_KEY` set the same way |
| Email binding | `EMAIL`, only with `--cloudflare-email`, and able to send only from `--email-from` |

The API Worker uses Smart Placement, which moves it near D1 when that is clearly faster. It needs traffic from several locations to decide, and it can take 15 minutes after a deploy. Create the database near your users with `--location`, because a Worker can move and the D1 primary cannot.

To load test a throwaway deployment, see the header of `tooling/scripts/load-test.mjs`. It writes junk data, so never point it at real data. One database takes [about 45 messages a second](../architecture/cloudflare-validation.md#m1b-load-test-on-real-d1-2026-11-04).

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

**Preview and teardown.** `node tooling/scripts/preview.mjs preview-<name>` creates a throwaway installation, verifies it, and removes it. Order matters when removing one: queue consumers first, then the Worker, then queues, R2, and D1, because Cloudflare refuses to delete a Worker that consumes a queue or a queue that is bound to a Worker. Deleting the Worker has failed once straight after removing consumers and worked on retry, so check each step.

**D1 location.** The primary is placed near whoever creates the database unless `--location` is given. Choose it deliberately: S4 measured about 90 ms per write with the Worker nearby and about 380 ms with it far away.

## Fresh install: `oc deploy`

```bash
pnpm exec wrangler login      # once
pnpm oc deploy --env acme --owner-email you@example.com --workspace "Support team"
```

This needs Workers Paid ([ADR-0009](../architecture/decisions/0009-paid-plan-and-password-hashing.md)). It prints the dashboard URL and a one-hour link for the owner to set a password, shown only once. To send email, onboard a domain, then deploy again with either provider. Cloudflare needs no API key, but it's in beta and documents no idempotency key, so a retry after a lost answer can send twice. Enabling a domain sets its DMARC policy to `reject`, so check first if anything else sends from it:

```bash
pnpm oc deploy --env acme --cloudflare-email --email-from no-reply@mail.example.com
RESEND_API_KEY=... pnpm oc deploy --env acme --email-from no-reply@mail.example.com
TURNSTILE_SECRET_KEY=... pnpm oc deploy --env acme --turnstile-site-key <site key>
```

Metrics are optional: enable Analytics Engine once in the Cloudflare dashboard, then add `--analytics`. To use your own domain, attach it to the Worker, then pass `--public-url https://chat.example.com`, because links in emails are built from that URL.

**The first installation admin** is the owner set up here. They manage people from then on ([ADR-0015](../architecture/decisions/0015-installation-admin-and-reversible-removal.md)). Upgrading an existing installation makes its first active owner the admin. Upgrading to migration `0004` makes every workspace owner and admin a supervisor, so only installation admins can then change settings and people ([ADR-0016](../architecture/decisions/0016-installation-admin-replaces-workspace-managers.md)).

**Without email, or locked out:** `pnpm oc recover --env acme --email you@example.com` prints a one-hour reset link. Using it signs the account out everywhere. It works because holding Cloudflare access already means holding the database.

Delivered in basic form in Milestone 1, and polished in Milestone 5. Each step is recorded in `.openchat/<env>/state.json` as it finishes, so a failed run can be resumed by running it again. Keep that directory, because a deployment refuses to adopt a resource name it has no record of creating. Steps marked *(M5)* below do not exist yet.

| # | Step | How | Spec §13 |
|---|---|---|---|
| 1 | Authenticate | `wrangler login` or `CLOUDFLARE_API_TOKEN` | 1 |
| 2 | Select account | `wrangler whoami`. With several accounts, set `CLOUDFLARE_ACCOUNT_ID`. An interactive choice *(M5)* | 2 |
| 3 | Pre-flight | [The checks above](#prerequisites), before anything is created. Name collisions stop the run when that resource is created | |
| 4 | Create resources | Wrangler, recording IDs in `state.json` | 3 |
| 5 | Generate secrets | Generated locally, sent to `wrangler secret bulk` on stdin, **never written to disk**. Only once, because a new signing key signs everyone out. Set after the first deploy, so auth routes answer 503 for a few seconds on a new install. Others arrive with the features that use them | 6 |
| 6 | Apply migrations | `wrangler d1 migrations apply --remote` | 4 |
| 7 | Build and deploy | Dashboard and widget, then Worker | 5 |
| 8 | Domain | `--public-url` for a domain you attached. Attaching it *(M5)* | 7 |
| 9 | Initialise | `wrangler d1 execute`: creates the installation, first owner, and workspace, guarded so a repeat adds nothing. The owner has no password until they use the printed link | 8 |
| 10 | Relay signing key | If a relay was given: generated once, as the secret `RELAY_SIGNING_KEY`. The Worker registers itself when the first device asks for a grant, not during the deploy | |
| 11 | Verify | Health, discovery, and a login probe that proves the signing key loads. A synthetic visitor message *(M1b)* | 9 |
| 12 | Print | Dashboard URL and the owner's link. Widget snippet and restore command *(M5)* | 10 |

The [abuse limits](abuse-limits.md) have defaults that suit most installations. To change one, pass its flag to `oc deploy`.

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

Orango Labs runs it at `https://openchat-relay.orangolabs.com`, with the relay ID `managed`, on the same Cloudflare account as its other projects. That was the owner's choice on 2026-11-05, in place of a separate account, so everyone with access to that account can reach the APNs key.

- **Private mode for now.** Only installations in `RELAY_ALLOWED_INSTALLATIONS` can register. It moves to `open` after legal review of the terms and privacy policy ([Q5](../architecture/open-questions.md)).
- **Production APNs only**, because the key is production only. A relay serves one environment.
- **Configuration** is in the operator's `.openchat/managed-relay/`, which Git ignores. Worker secrets cannot be read back, so `RELAY_TOKEN_KEY` and the operator token are kept with the signing keys. Losing `RELAY_TOKEN_KEY` means every device has to register again.
- **To admit an installation:** add its ID, from its `/.well-known/openchat.json`, to `RELAY_ALLOWED_INSTALLATIONS`, and deploy the relay. Then deploy the installation with `--relay-url https://openchat-relay.orangolabs.com --relay-id managed --relay-bundle-ids com.orangolabs.openchat`.
- **Not built:** monitoring of delivery rate, APNs error reasons, and queue age. See the [M3 limits](../plan/milestones.md#m3-exit-check).

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
