# ADR-0019: The iPhone app and the notification relay leave the open-source project

**Status:** Accepted, 2026-11-13, by the owner. Supersedes the parts of [ADR-0011](0011-license-boundaries.md) that license the relay and the app, and the independent relay of [deployment](../operations/deployment.md).

## Context

The open-source repository held everything: the server, the dashboard, the widget, the CLI, the iPhone app (`apps/mobile`) and the notification relay (`services/notification-relay`). The owner decided that the app and the relay should no longer be open source.

Push is not a separate feature on the server. The installation registers phones with a relay, encrypts each notification to each phone ([ADR-0017](0017-encrypted-notifications.md)), signs its requests to the relay, and publishes the relay it uses in discovery. A self-hoster gets notifications by using the official app with the managed relay.

Every commit to the app and the relay was by the owner, so the owner could change their terms. The repository had no forks.

## Decision

- `apps/mobile`, `services/notification-relay`, `docs/ios-build`, and the CLI's `oc relay` and `oc app variant` commands move to a private repository, with their history. The relay's operating guide goes with them.
- **The server keeps push.** Its relay client, device registration, notification encryption, the `relay` field in discovery, the health check, `oc deploy --relay-url`, and the dashboard's push settings stay open source. So does `packages/notification-protocol`, and the [relay protocol](../notification-relay/protocol.md), which together define what an installation sends.
- The private repository uses the open-source packages it needs (`api-client`, `api-contracts`, `notification-protocol`, `shared`, `tsconfig`, `eslint-config`) through a Git submodule of this repository, not copies. The lint rule that keeps the relay apart from installation code stays in `@openchat/eslint-config`, which the private repository uses.
- History is not rewritten. The app and the relay stay in this repository's earlier commits, under the licences they had then.

## Consequences

- A self-hoster can still use the official app with the managed relay, as before. They can no longer build their own app, run their own relay, or white-label the app from this repository. The **independent relay** in the deployment guide is gone.
- Anyone who already has a copy of the app or the relay keeps the rights its licence gave: Apache-2.0 for the app, AGPL-3.0 for the relay. Removing the code now does not take those back.
- A change to the protocol is made here first, in `notification-protocol` and the protocol document, and the private repository picks it up by moving its submodule. Both sides must keep to rules 9 and 10 in [AGENTS.md](../../../AGENTS.md).
- This repository's CI no longer builds, tests or licence-checks the app and the relay. The private repository's CI runs their typecheck, lint and tests. Their licence checks are not yet carried over.
- `packages/notification-protocol` stays Apache-2.0. Here, only the server and the API contracts use it.
- The App Store listing and the app's notices must no longer offer the app's source as this repository. That is for the owner, in the private repository.
