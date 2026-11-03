# ADR-0001: One Installation Worker plus one relay Worker

**Status:** Accepted. **Date:** 2026-11-03.

## Context

Spec §5.2 asks for a modular monolith, yet §12 lists `api`, `realtime`, `notification-relay`, and `email-worker` as separate services. Self-hosters deploy this themselves, and every extra Worker adds a deploy step and a version-skew surface.

## Decision

Two deployables:

- **Installation Worker** (`services/api`): HTTP API, Durable Object classes, queue consumers, cron, and dashboard and widget assets, on one origin.
- **Notification relay** (`services/notification-relay`).

`realtime` and `email` are packages, with module boundaries enforced by lint.

## Consequences

- An installation deploys atomically, apart from Durable Object update deferral.
- One origin removes CORS for the dashboard and allows `SameSite=Strict` cookies.
- Attachments share an origin with the dashboard, so response headers must prevent stored XSS.
- A single Worker shares its bundle and compatibility date across all these roles. Splitting one out later needs only a new composition root, since the logic is already in packages.
