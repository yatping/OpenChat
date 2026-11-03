# ADR-0002: Per-workspace hub for agents, per-conversation room for visitors

**Status:** Accepted, pending load measurement in Milestone 1. **Date:** 2026-11-03.

## Context

Agents need events from every conversation in their workspace. Visitors need only their own. A single object is single-threaded, with a soft limit of 1,000 requests/s.

| Option | Problem |
|---|---|
| Per-conversation object only | Agents would need a socket per conversation, or a fan-out layer anyway |
| Per-workspace object only | Visitor traffic and agent traffic share one thread; a busy site delays its agents |
| Per-message object | Forbidden by the spec |

## Decision

`WorkspaceHub` (`workspace:<id>`) holds agent sockets. `ConversationRoom` (`conversation:<id>`) holds visitor sockets. Both use the Hibernation API and hold no business state. The Worker publishes to both after commit. See [realtime](../realtime.md).

## Consequences

- Visitor load cannot starve agents. A room's publish accepts only `VisitorEvent`, which makes note isolation structural.
- Typing and presence cross objects through RPC, an extra hop accepted for infrequent events.
- Hubs can be sharded later with a name suffix and no protocol change.
