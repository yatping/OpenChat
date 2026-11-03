# ADR-0010: No global mobile account

**Status:** Accepted by the owner, [Q6](../open-questions.md), amending spec §3.1. **Date:** 2026-11-03.

## Context

Spec §3.1 opens with "create an account or sign in", before connecting an installation. A global account requires a project-run identity service holding user data, in tension with spec §1. It would add a dependency to every connection, and Guideline 5.1.1(v) would require in-app deletion for that account.

## Decision

The app has no account of its own. A **Connection** is one user signed in to one installation, and holds its own tokens, cache, and API client. The app does not create accounts; invitations do that on the web. It does offer in-app deletion of the user's account on an installation (`DELETE /api/v1/me`).

The connection flow, as the owner specified it:

1. The user enters the installation's Worker URL or custom domain.
2. The app reads `/.well-known/openchat.json` there to confirm that it is an OpenChat installation with a compatible API.
3. The user signs in with their account on that installation, such as a customer support agent's.

## Consequences

- No identity service and no data held by the project, apart from relay device records.
- No sync of connections across a user's devices, which is acceptable.
- Connection data isolation is structural: a separate query client and database file per connection.
