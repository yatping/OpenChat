# Deployment and upgrades

Managed and independent configurations stay separate (spec rule 18). Only the configuration differs, and all code comes from the same tagged release.

To set up your own from nothing, follow the [self-hosting guide](self-hosting.md). This document is the reference behind it.

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
| Email | To deliver new account links and resets | Cloudflare Email Sending (a domain on Cloudflare DNS in this account, onboarded with `wrangler email sending enable <domain>`, and a login with `email_sending:write`). Without it, use `oc recover` | The domain is listed as onboarded |
| Push | With `--relay-url`, `--relay-id`, and `--relay-bundle-ids`, all three together. The [managed relay](#push-notifications) is open to any installation that proves control of its domain | Nothing for the managed relay, or an Apple Developer account for independent mode | Not checked yet |

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
| Secrets | `AUTH_SIGNING_KEY`, `TICKET_SIGNING_KEY`, `RELAY_SIGNING_KEY`, `DATA_ENCRYPTION_KEY`, `TURNSTILE_SECRET_KEY`, with the public `TURNSTILE_SITE_KEY` set the same way |
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

This needs Workers Paid ([ADR-0009](../architecture/decisions/0009-paid-plan-and-password-hashing.md)). It prints the dashboard URL and a one-hour link for the owner to set a password, shown only once. To send email, onboard a domain, then deploy again. It needs no API key, but it's in beta and documents no idempotency key, so a retry after a lost answer can send twice. Enabling a domain sets its DMARC policy to `reject`, so check first if anything else sends from it:

```bash
pnpm oc deploy --env acme --cloudflare-email --email-from no-reply@mail.example.com
TURNSTILE_SECRET_KEY=... pnpm oc deploy --env acme --turnstile-site-key <site key>
```

To publish `/.well-known/security.txt`, give a contact for security reports: `--security-contact mailto:security@example.com`, or an `https://` form, and optionally `--security-policy https://example.com/disclosure`. Both are remembered for later deploys; `--security-contact none` removes the file. See [disclosure](../architecture/security.md#disclosure).

The dashboard and the discovery document offer users the source of the release you deployed, as the AGPL asks. If you changed the code, publish it and pass `--source-url https://...`, also remembered; `none` goes back to the release's. `oc deploy` and `oc upgrade` remind you when the checkout is not the release tag unchanged. See [licensing](licensing.md#the-source-offer).

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
| 10a | Operator token | Generated once, as the secret `OPERATOR_TOKEN`, with the only copy in `.openchat/<name>/operator-token`, readable only by you. Opens the [health checks](monitoring.md). A deployment from before it existed gets one on its next `oc deploy` | |
| 11 | Verify | Health, discovery, and a login probe that proves the signing key loads. A synthetic visitor message *(M1b)* | 9 |
| 12 | Print | Dashboard URL and the owner's link. Widget snippet and restore command *(M5)* | 10 |

The [abuse limits](abuse-limits.md) have defaults that suit most installations. To change one, pass its flag to `oc deploy`.

## Upgrades: `oc upgrade`

A migration and a deploy are not atomic. Safety relies on the [expand/contract rule](../architecture/data-model.md#migration-strategy): every migration must work with the Worker before it.

```bash
git fetch --tags && git checkout v0.2.0
pnpm install --frozen-lockfile
pnpm oc upgrade --env production
```

1. Refuse a checkout older than what is deployed, and a jump past the oldest release this one can upgrade from (`UPGRADE_FROM_AT_LEAST` in `tooling/cli/src/releases.ts`, which the release notes repeat). A deployment made before versions were recorded counts as `0.1.0`.
2. Run the same checks as `oc preflight`, and build.
3. Record the Worker version now running and the D1 Time Travel bookmark, in `.openchat/<env>/state.json`. If either cannot be read, stop with nothing changed.
4. Apply migrations. The *old* Worker keeps running against the new schema.
5. Deploy the new Worker. Durable Objects update on hibernation, or after the deferred update window.
6. Verify, as `oc deploy` does. If the new Worker is unhealthy, roll the Worker back by itself, and say so.

`oc deploy` also records the version, and refuses an older checkout. The release is the root `package.json` version.

| Failure | Response |
|---|---|
| Migration fails | Stop. The old Worker keeps running. Behaviour of a partly applied file is still to be confirmed (S4) |
| New Worker is unhealthy | Rolled back by `oc upgrade`. The schema stays, which is safe under expand/contract |
| A problem found later | `pnpm oc rollback --env <name>` puts back the Worker from before the last upgrade. The schema stays |
| Data corruption | Time Travel restore to the recorded bookmark, which `oc upgrade` prints: `pnpm oc restore --env <name> --bookmark <bookmark> --confirm <name>`. **It discards every later write**, so it is a last resort. See [backup and restore](backup-and-restore.md) |

A Worker version with a Durable Object migration that the old version lacks may not be possible to roll back to. No release has one yet.

**Tested in CI.** `pnpm test:upgrade --from v0.1.0` runs the release's Worker on local D1 and writes a conversation, a reply, and an internal note. This checkout's migrations and Worker then take over the same database, and old sessions, messages, and the note's privacy are checked. Then the release's Worker runs again on the new schema, as after `oc rollback`, and reads and writes. A migration that renamed a column the code reads made it fail, as it should. `oc upgrade` and `oc rollback` themselves are tested against a fake Wrangler, since CI has no Cloudflare account.

## CI/CD

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PR | Lint, typecheck, test, build, contract and migration drift, secret scan, bundle budget, [licence checks](licensing.md#what-ci-checks), and the DCO sign-off |
| `preview.yml` | On demand | Deploy a preview installation with a test account |
| `release.yml` | Tag | Build artifacts and release notes, with compatibility statement |

Community forks can run all of them. None depends on project-held credentials.

## Push notifications

The iPhone app's notifications go through a notification relay, which holds the APNs key. The app and the relay are not open source ([ADR-0019](../architecture/decisions/0019-app-and-relay-leave-open-source.md)). The installation's side is: it registers phones with the relay, encrypts each notification to each phone, and signs every request. The protocol between them is in [the relay protocol](../notification-relay/protocol.md).

To use the official app, point the installation to the managed relay, which Orango Labs runs at `https://openchat-relay.orangolabs.com`:

```bash
pnpm oc deploy --env production --relay-url https://openchat-relay.orangolabs.com \
  --relay-id managed --relay-bundle-ids com.orangolabs.openchat
```

The relay is in open mode: any installation that proves control of its domain can register, within the [limits](../notification-relay/protocol.md#rate-limits). Its [terms](../legal/relay-terms.md) and privacy policy are drafts awaiting legal review. `--no-relay` takes it out again; disconnect in the dashboard first, so that the relay erases its records.

## Operations

| Task | Procedure |
|---|---|
| Rotate a signing key | Add new key, deploy, wait out the token lifetime, remove the old key |
| Rotate the relay key | Register a new key with the relay, switch, revoke the old key |
| Reset an owner's password with no email configured | `oc admin reset-password`, which issues a one-time link. It must run with deploy credentials |
| Set retention | In the dashboard, **Workspaces**, choose the workspace, then **Keep closed conversations**. Deletion starts within the hour and cannot be undone, except from D1 Time Travel within 30 days |
| Inspect failed jobs | In the dashboard, **Failed jobs**, for an installation admin. Fix the cause, then **Replay**, or **Dismiss** what is no longer needed. A job past the time it had to run by cannot be replayed. Both actions are in the audit log |
| Disable push | In the dashboard, **Workspaces**, **Push notifications**, **Disconnect and erase**: push stops, and the relay erases what it holds about this installation. Then, to take the relay out of the deployment, `pnpm oc deploy --env <name> --no-relay`. Messaging is unaffected |
| Backup | Time Travel covers 30 days by itself. For longer, `pnpm oc backup --env <name>` exports the database to this computer and checks that the export loads. The database answers nothing else while it runs. See [backup and restore](backup-and-restore.md) |
| Restore | `pnpm oc restore --env <name> --confirm <name>`, with `--timestamp` or `--bookmark` for Time Travel in place, or `--from <backup.sql>` into a new database, keeping the old one. See [backup and restore](backup-and-restore.md) |

## Health checks

`/health` is public and returns status only. `/health/database`, `/health/queues`, `/health/realtime` and `/health/notifications` need the operator token that `oc deploy` generates, per [amendment A9](../architecture/spec-review.md#amendments-to-the-specification). `pnpm oc health --env <name>` reads them all. What each checks, and what to alert on, is in [monitoring](monitoring.md).

## Cost

Measure costs during Milestone 1 and publish typical figures. The main drivers will be Worker requests, Durable Object wakes, D1 rows read, and R2 storage. Vendor pricing is not repeated here because it changes.
