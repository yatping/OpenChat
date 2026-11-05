# Realtime: Durable Objects and WebSocket lifecycle

Frames are defined in `packages/api-contracts/src/realtime.ts`, and published in the generated OpenAPI document. Decision record: [ADR-0002](decisions/0002-durable-object-topology.md).

## Principles

1. **D1 is the record; sockets are a hint.** Any client can reach a correct state using REST alone.
2. **Durable Objects hold no business state.** They can reset at any moment without losing anything but who is connected.
3. **Clients connect only when useful.** A page view does not open a socket.

## Topology

```text
Agent clients (dashboard, foregrounded mobile)        Visitor clients (widget)
           |  one socket per client                        |  one socket per tab
           v                                               v
   WorkspaceHub  (name = workspace:<id>)  <--RPC-->  ConversationRoom (name = conversation:<id>)
           ^                                               ^
           +---------------- publish after commit ---------+
                               API Worker
```

| | `WorkspaceHub` | `ConversationRoom` |
|---|---|---|
| Instances | One per workspace | One per conversation with a connected visitor |
| Sockets | Agents | Visitor tabs |
| Carries | All inbox events, typing, presence | Public messages, agent typing, status |
| Auth checks | Workspace membership, role | Visitor token for this conversation |
| Expected load | Tens of sockets | One to a few sockets |

**Why two classes.**

- An agent inbox needs events from every conversation, so a per-conversation design would force an agent to hold many sockets.
- A single per-workspace object would put visitor traffic and agent traffic in one single-threaded object, so a busy website could delay its agents and all its visitors. The soft limit is 1,000 requests/s per object.
- Separate rooms also make authorisation simple: a room only ever holds one conversation's visitor, and its publish method accepts only the `VisitorEvent` type.

**Why not one object per website or shard.** It adds routing without solving the agent inbox problem. If a workspace ever outgrows one hub, its name can gain a shard suffix (`workspace:<id>:<n>`) with agents assigned by hash, without changing the protocol. Do not build this until measurements call for it.

**Location.** Objects start near their first caller. A hub's first caller is typically an agent, which is the right place. Rooms may be created by the API Worker near the visitor. Both talk to D1 rarely, because the Worker does the writing.

## Connection lifecycle

### Establishing

```text
Client                     Worker                         Durable Object
  | POST .../realtime/tickets|                                 |
  |  (normal auth)           | verify, check membership        |
  |<-- ticket (30 s TTL) ----|                                 |
  | GET /realtime/connect?ticket=... (Upgrade)                 |
  |------------------------->| verify signature, expiry, Origin|
  |                          |--- fetch with verified claims ->| acceptWebSocket(server, tags)
  |                          |                                 | serializeAttachment(claims)
  |<==================== hello frame ==========================|
  | REST catch-up (see below)                                  |
```

- **Why a ticket.** Browsers cannot set headers on a WebSocket, and a long-lived token in a URL would end up in logs. A ticket lasts 30 seconds and names one scope. It can be used more than once in that time, so a room also allows only ten sockets per visitor. Our logger never records it, but it is in the URL, so Cloudflare's own request logs may.
- **Which page.** A ticket records the `Origin` that asked for it, and the connection must carry the same one, or none for a client with no page. iOS always adds the server's own origin to a WebSocket and cannot remove it, so the app asks for its ticket with that same origin. Tickets are signed with the same key as access tokens, under their own audience, so neither can stand in for the other.
- **Room names** include the workspace, `conversation:<workspaceId>:<id>`, so an ID from another tenant reaches an empty room.
- **Tags:** `member:<id>`, `role:<role>` for hubs, `visitor:<id>` for rooms. Maximum 10 per socket.
- **Attachment:** `{ kind, principalId, role, expiresAt, connectedAt, protocolVersion }`. Well within the 16 KB limit. It survives hibernation.

### Heartbeat without waking

`ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))` is set in the constructor. Clients send the literal text `ping` every 30 seconds, because browsers cannot send protocol-level pings. This neither wakes the object nor bills duration. A client that misses two pongs treats the socket as dead.

A client treats the connection as dead after **two** missed pongs, not one, because S2 saw a single missed pong during a deploy on a healthy socket. Do not lengthen the interval: in S2 a silent socket closed after about 59 seconds.

### Hibernation discipline

The following are forbidden in these classes, because they block hibernation or do not survive it:

| Forbidden | Instead |
|---|---|
| `setTimeout`, `setInterval` | An alarm, only when genuinely needed |
| In-memory maps of sockets | `ctx.getWebSockets(tag)` |
| In-memory state assumed to persist | Attachments, or the object's SQLite storage |
| Heavy constructor work | The constructor re-runs on each wake |
| Outbound WebSockets | Not needed |

### Typing indicators

Clients send `typing.set` at most every 3 seconds while typing, and the object forwards it. **Receivers expire the indicator after 5 seconds without an update.** A client writing a note sets `internal`, which keeps that typing from the room. Frames carry no names, and a client finds a member by ID. There are no timers or stored state on the server, so typing never affects hibernation. Typing from a member crosses to the room, and typing from a visitor crosses to the hub, by RPC.

### Presence

Presence is advisory. It is derived from `getWebSockets()` when asked.

- **Agent:** online if a socket with their tag exists.
- **Visitor:** a room tells its hub on the first connect and last disconnect. Disconnects are debounced with a 15-second alarm so that page navigation does not flicker.
- **Stale sockets:** a dead TCP connection may not produce a prompt close. This alarm is tested in workerd only: on real Cloudflare a socket with no heartbeat was gone at about 62 s, before the alarm could act. While sockets are present, an alarm closes those whose `getWebSocketAutoResponseTimestamp` is older than 90 seconds: every 60 seconds in hubs, every 5 minutes in rooms, and none when empty.

Per spec §8.2, **disconnect is never treated as abandonment**. Follow-up decisions use message timestamps.

The widget's availability comes from `GET /widget/bootstrap`, cached for 30 seconds through the Cache API, so that page views on a busy site do not wake the hub. In `auto` mode it is online if any agent has a socket. The `availability` frame is reserved, because reaching every room from the hub would wake them all, so an open widget learns of a change on its next bootstrap.

### Publishing

```typescript
// In the Worker after the D1 batch commits, inside waitUntil.
await Promise.allSettled([
  hub.publish(event),                                  // RPC
  visitorEvent && room.publish(visitorEvent),          // only if the mapper allows it
]);
```

`toVisitorEvent(event)` is an allowlist mapper returning `VisitorEvent | null`. Anything unlisted, including internal notes, assignment, tags, and agent identity details, returns `null`. It has a test per domain event type, and a missing case is a compile error.

The hub filters by audience before sending. Agents can currently see every conversation in their workspace; if restricted roles arrive, filtering goes here.

### Token expiry and revocation

- **Expiry:** `expiresAt` in the attachment is checked on each inbound message and before each send. There is no alarm per socket. Clients send `auth.refresh` with a new ticket before expiry, timed from `authExpiresAt` in `hello`, and receive a new `hello`. The ticket must name the same person, workspace, conversation, and page, or the answer is `error: forbidden` and nothing changes. `auth.expiring` is reserved and not sent, because that would need a timer per socket. Otherwise the socket closes with 4401 at the next event. An expired socket never receives anything.
- **Revocation:** a role change or removal writes an outbox row (`member.access_changed`), and the sweep guarantees that `hub.revokeMember(memberId)` runs. It closes `member:<id>` sockets with 4403, and clients reconnect with fresh permissions.
- **Account deletion** writes the same row inside the deletion, and relies on the sweep, so its sockets close within about two minutes.
- **A password reset, recovery, or refresh token reuse** closes the member's sockets the same way, because each suggests theft. **Signing out** does not. Those sockets end at their expiry, at most 15 minutes for an agent.
- **A conversation deleted or visitor blocked** will use the same mechanism on the room. Neither exists yet.

### Read positions

Publishing a read position needs no outbox row: it is already in D1, a later one supersedes it, and `GET /api/v1/widget/conversations` returns `readSeq` and `agentReadSeq` to anyone who missed it. A visitor only ever sees public sequence numbers. The widget reports a read only when it has seen something from someone else, so a visitor's own message costs no write.

### The widget's socket

The widget opens none until a conversation exists, and then only while the conversation is open or pending, or the panel is open. A first-time visitor who never writes makes no session and no rows. It shares its client with the dashboard, in `@openchat/api-client/realtime`, which imports nothing else and so stays out of Zod's way.

### Reconnection and catch-up

Backoff is **full jitter**: `random(0, min(30s, 1s * 2^attempt))`. Server-issued close codes may add a minimum delay.

```text
On every (re)connect:
  1. Receive hello.
  2. Open conversations: GET messages?afterSeq=<highest seq seen>
  3. Inbox: GET conversations?updatedAfter=<cursor>   (cursor from the previous response, 5 s overlap)
     The dashboard currently reads its loaded list again instead, which costs a little more and converges the same way.
  4. Merge by ID. Duplicates are harmless.
During a session:
  - message.created carries conversationVersion for agents, because every message moves the version, and an
    agent's next change would otherwise be refused as stale.
  - message.created with seq > lastSeq + 1 means a gap: fetch it.
    (Visitors receive public_seq as seq, so the same logic holds for them.)
  - Events are applied by ID and version, so out-of-order delivery converges.
  - sync.required: rerun steps 2 and 3.
```

Two concurrent publishes may arrive out of order, because the Worker publishes after commit without coordination. The `seq` makes that harmless. This is why no attempt is made to serialize broadcasts in the object.

If the socket is unavailable after three attempts, the widget polls every 15 seconds and the dashboard every 30, with a visible status, satisfying "REST remains usable".

## Deploys and version skew

From 2026-10-30, Durable Objects defer code updates by default (300 seconds).

| Scenario | Effect |
|---|---|
| Object is hibernated | Takes new code at next wake. Sockets stay connected. |
| Object active past `max_delay` | Reset. Sockets drop, clients reconnect with jitter. |
| Worker on new code, object on old | Possible during the window. |

**Rules**

- Config: `code_update_strategy: { mode: "deferred", max_delay: 3600 }`, because the objects hibernate quickly and we would rather not force resets. [Spike S2](cloudflare-validation.md#s2-hibernation-and-deploys) confirmed that sockets survive a deploy under this setting. Note that the strategy applies to all classes in the Worker and does not carry over between deployments, so it stays in the config file.
- RPC methods are additive. Payloads carry `v`. An old object must ignore unknown event types, and a new one must accept old payloads, for one full release.
- WebSocket protocol changes follow the same rule, because old clients stay connected across versions. `hello` advertises `protocolVersion`.

## Rate limits

Enforced in the object for inbound frames, using a small counter in the attachment:

| Frame | Limit | Exceeded |
|---|---|---|
| `typing.set` | 1 per 2 s | Silently dropped |
| Any frame | 20 per 10 s | Close 4429, with a minimum reconnect delay |
| Max frame size | 8 KB | Close 1009. Messages go through REST, not sockets |

Messages are **always sent through REST**. That keeps one write path, one authorisation path, and one idempotency path.

## Cost

Hibernation means a connected idle visitor costs little. The widget also opens no socket until a conversation exists, so ordinary page views cost one cached bootstrap request. The main costs are alarms in active rooms, and each wake. Measure this during Milestone 1 before tuning the sweep interval.

## Observability

Written to Analytics Engine by the object: connections opened and closed by close code, publish count and fan-out size, wake count, frames dropped by rate limit. Socket contents are never logged.

## Tests

| Case | Layer |
|---|---|
| Hibernation: state restored after eviction; attachment intact | Workers runtime, with a test helper that aborts the object if available |
| Auto-response does not invoke `webSocketMessage` | Runtime |
| Internal note never reaches a room, table-driven across all events | Unit and integration |
| Ticket expired, wrong workspace, wrong Origin | Integration |
| Two agents and one visitor, message and reply | Integration, then Playwright |
| Reconnect with gap; duplicate event; out-of-order event | Client unit tests with a fake socket |
| Revoked member loses the socket | Integration |
| Connection storm: 1,000 clients reconnect with jitter | Load test before Milestone 1 sign-off |
