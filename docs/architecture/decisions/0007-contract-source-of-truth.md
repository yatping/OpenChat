# ADR-0007: Zod is the contract source; OpenAPI is generated

**Status:** Accepted. **Date:** 2026-11-03.

## Context

Spec §7 requires OpenAPI 3.1 and shared types "generated from or validated against" the contract. Handwritten OpenAPI plus separate validators drift apart.

## Decision

Define routes and schemas with Zod in `packages/api-contracts`, using `@hono/zod-openapi`. Generate `openapi.json`, commit it, and fail CI on any difference. Clients use inferred types. WebSocket frames live in the same package and are published under `components/schemas`.

The widget imports types only, so Zod stays out of its bundle.

## Consequences

- Validation, documentation, and types cannot diverge.
- The contract's expressiveness is limited to what the Zod-to-OpenAPI conversion supports.
- Reviewers can see API changes as a diff to the generated file.
