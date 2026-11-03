# ADR-0006: Pluggable APNs transport

**Status:** Accepted. Spike S1 reached APNs from `fetch`, Durable Object, queue, and cron contexts over 44 minutes, without credentials ([results](../cloudflare-validation.md#phase-0-spike-results)). The transport stays pluggable, because this behaviour remains undocumented. **Date:** 2026-11-03.

## Context

APNs requires HTTP/2, which was confirmed by direct test. Local `workerd` has no HTTP/2 client and there are no active plans for one. In production, requests apparently go through Cloudflare's proxy, which uses HTTP/2, and this is how existing projects send. Nothing documents it as a guarantee. `connect()` documents no ALPN control, so implementing HTTP/2 over sockets is not a sound fallback.

## Decision

Define `ApnsTransport`, with three implementations:

- `WorkersFetchTransport`: the production default.
- `HttpGatewayTransport`: a small authenticated HTTP/2 gateway. Built only if needed, with Cloudflare Containers as the likely host, since they stay within the customer's account.
- `MockApnsTransport`: tests and local development.

## Consequences

- Real delivery cannot be tested in local development. Use a deployed preview relay with the APNs sandbox.
- A metric on connection-lost errors gives early warning if platform behaviour changes.
- Apple recommends reusing connections. With `fetch` we do not control pooling, so throttling is watched during Milestone 3.
