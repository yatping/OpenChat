# ADR-0011: AGPL core with permissive client components

**Status:** Accepted, the owner delegated the choice in [Q2](../open-questions.md). Legal review is still advised before the first release. **Date:** 2026-11-03.

## Context

The spec recommends AGPL-3.0, which suits the server: anyone hosting a modified version must share changes. But:

1. **App Store.** The FSF has taken the position that GPL terms conflict with App Store terms. VLC was removed in 2011 after a contributor complained. Whether this applies identically to AGPL and to today's Apple terms needs a lawyer's view, but it is a real risk both to the official app and to every customer building a white-label app.
2. **Widget.** The widget ships as JavaScript inside customers' websites. An AGPL licence raises questions that will deter adoption, even where the risk is low.
3. **Client libraries and protocol.** Others should be able to implement them freely.

Relicensing later requires consent from every contributor.

## Decision

| Licence | Components |
|---|---|
| AGPL-3.0 | Installation Worker, relay, dashboard, server packages, CLI |
| Apache-2.0 | Widget, mobile app, `api-client`, `api-contracts`, `notification-protocol`, `shared` |

CI verifies licence fields and that permissive packages have no AGPL dependencies. Contributions use the **Developer Certificate of Origin**: each commit carries a `Signed-off-by` line, checked in CI. A DCO was chosen over a CLA because it asks less of contributors, and outside contributions are a requirement. With this split, the App Store conflict is handled by the licence itself and needs no relicensing right.

## Consequences

- A competitor could fork the mobile app and widget. The server remains copyleft.
- Without a CLA the project cannot later relicense the AGPL components or sell exceptions without every contributor's consent. This was accepted in favour of easier contribution.
- This is an architectural constraint, because the dependency boundaries must match.
- Not legal advice: have counsel review before the first release.
