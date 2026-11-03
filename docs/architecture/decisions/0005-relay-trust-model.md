# ADR-0005: Relay trust through installation keys and device-submitted grants

**Status:** Accepted, amending spec §3.3, §4.3, §6, and §14. **Date:** 2026-11-03.

## Context

The spec allows HMAC or an asymmetric scheme and identifies senders by `workspaceId`, with device tokens stored in the installation database. But spec §1 means anyone may register on the managed relay, so a registered sender must not be able to reach arbitrary devices. Workspace IDs are chosen by independent parties, so they cannot be a global identity.

## Decision

- Each installation has an Ed25519 key pair and an `installationId`, which is the trust root. Workspaces register beneath it.
- A subscription is created only when a device submits a short-lived, audience-bound, single-use grant signed by the installation, together with its own token.
- Installations store an opaque subscription handle, never an APNs token.
- Notification schemas are closed, and the relay composes the notification text.
- The app's allowed relay URLs are fixed at build time.

## Consequences

- A relay database leak exposes no signing secret, and installations leak no tokens.
- A malicious installation can only reach people who connected to it.
- Registration involves one additional round trip, and the official app cannot use a customer's relay, by design.
- The protocol differs from the examples in the spec.
