# API conventions

Applies to the installation's REST and WebSocket APIs. The relay has [its own contract](../notification-relay/protocol.md).

## Source of truth

Per [ADR-0007](../architecture/decisions/0007-contract-source-of-truth.md):

```text
packages/api-contracts  (Zod schemas and route definitions, plus WebSocket frame schemas)
        |
        +--> server: @hono/zod-openapi validates requests and responses
        +--> clients: types through z.infer, used by packages/api-client
        +--> generated/openapi.json: committed. CI fails if it differs from a fresh generation.
```

[`openapi.draft.yaml`](openapi.draft.yaml) and [`realtime-protocol.draft.ts`](realtime-protocol.draft.ts) were the agreed design for the MVP. **The generated document is now the source of truth for everything it contains.** The draft stays only as the design for what is not built: push grants and subscriptions, notification preferences, and unsubscribe, for later milestones, and a contact list and merge, which no milestone has yet. Its `/api/v1/realtime/tickets` was replaced by one route for agents and one for visitors. Delete the draft when these are built.

**WebSockets and OpenAPI.** OpenAPI has no first-class way to describe WebSocket frames. So the upgrade route is an ordinary path, and frame schemas are published under `components/schemas` from the same Zod source, which gives third parties one document and one set of types. AsyncAPI can be generated later if demand appears.

## URLs and versioning

| Surface | Prefix | Auth |
|---|---|---|
| Agent API | `/api/v1/...`, workspace resources under `/api/v1/workspaces/{workspaceId}/...` | Bearer token |
| Widget API | `/api/v1/widget/...` | Visitor token |
| Realtime | `/api/v1/realtime/connect` takes a ticket. Tickets come from `/api/v1/workspaces/{workspaceId}/realtime/tickets` or `/api/v1/widget/conversations/{conversationId}/realtime/tickets`, so that each audience keeps its own authentication and CORS | Ticket |
| Discovery | `/.well-known/openchat.json` | None |
| Health | `/health` (public, status only), `/health/*` (operator token) | |

The major version goes in the path. Additive changes require no version change, so **clients must ignore unknown fields and unknown enum values**, since an old app can talk to a new installation and vice versa.

### Discovery and compatibility

Installations upgrade on their own schedule, and the official app must cope with all of them.

```json
{
  "installationId": "inst_01JC...",
  "name": "Company A Support",
  "api": { "versions": ["v1"], "minor": 4 },
  "realtime": { "protocolVersions": [1] },
  "relay": { "id": "managed", "url": "https://relay.example.org", "bundleIds": ["org.example.app"], "publicKeys": [{ "id": "k1", "alg": "Ed25519", "key": "..." }] },
  "auth": { "signup": "invite_only" }
}
```

The app reads this before showing a login form, and uses it to decide compatibility. It also gates features using `api.minor`.

## Requests and responses

- JSON with `camelCase` fields. Timestamps are RFC 3339 UTC. IDs are opaque strings.
- `X-Request-ID` is accepted, or generated, and is always returned.
- Bodies are validated strictly at the boundary. Size limits are per route.

### Errors

RFC 9457 problem details with a stable machine-readable `code`:

```json
{
  "type": "urn:openchat:error:version_conflict",
  "title": "Conversation was changed by someone else",
  "status": 409,
  "code": "version_conflict",
  "requestId": "req_01JC...",
  "details": { "currentVersion": 7 }
}
```

| Status | Used for |
|---|---|
| 400 | Malformed or failed validation, with `details.fields` |
| 401 | Missing or invalid token |
| 403 | Authenticated workspace member lacking permission |
| 404 | Not found, **including resources in another workspace** |
| 409 | Version conflict, or state conflict |
| 411, 413, 415 | Attachment with no declared length, too large, or a disallowed type |
| 429 | Rate limited, with `Retry-After` |
| 503 | D1 overloaded or dependency unavailable, with `Retry-After` |

A 404 means "not found" only when it is `application/problem+json`. Cloudflare occasionally answers with its own HTML 404 before a request reaches the Worker ([S4](../architecture/cloudflare-validation.md#found-while-deploying)), so clients retry any other 404.

### Pagination

Keyset only. Requests take `limit` (default 25, max 100) and `cursor`. Responses return `{ "data": [...], "nextCursor": "..." | null }`. Cursors are opaque, include a version, and are bound to the filters used.

An inbox listing takes one `status`, defaulting to `open`, because the inbox indexes start with it. Listing every status at once would need a sort over the whole workspace.

### Idempotency and concurrency

| Operation | Mechanism |
|---|---|
| Send a message | Required `clientMessageId`. A replay returns the original with 200 rather than 201. |
| Updating a conversation | Required `expectedVersion`; 409 on mismatch. Clients refetch, and retry if the action still makes sense. |
| Other creates | Natural unique keys where possible, otherwise an optional `Idempotency-Key` added when a client needs it. |

Optimistic UI is used only for sending messages, which are reconciled by `clientMessageId`. Assignment and status changes wait for the server (spec §10).

## Message status

| Status | Definition | Source |
|---|---|---|
| `accepted` | Committed to D1 | The 201 response |
| `delivered` | The other party's client acknowledged at least this `seq` | `delivered_seq` cursors |
| `read` | The other party displayed at least this `seq` while in focus | `read_seq` cursors |
| `failed` | **Client-side only**: the send never committed, and retries are exhausted | Local state |

For multi-agent conversations, "the other party" for a visitor's message means any member. Status is derived, and never stored per message.

Cursors are in the reader's own sequence space: `seq` for members and `publicSeq` for visitors. A member's read position is converted to `publicSeq` on the server before a visitor sees it, because the raw value would reveal how many internal notes exist.

## Message shape

Extends spec §7 with `seq`, `publicSeq`, `clientMessageId`, and `visibility`.

```json
{
  "id": "msg_01JC...",
  "conversationId": "conv_01JC...",
  "seq": 42,
  "publicSeq": 40,
  "clientMessageId": "c1f6c9a8",
  "sender": { "type": "visitor", "id": "vis_01JC..." },
  "type": "text",
  "visibility": "public",
  "content": "Hello, I need some help",
  "attachments": [],
  "createdAt": "2026-11-03T10:00:00.000Z",
  "metadata": {}
}
```

Internal notes (`type: internal_note`) are `visibility: internal`, and the database rejects any other combination. Widget schemas omit the `visibility` field entirely, expose `publicSeq` as `seq` so that gaps cannot reveal notes, and the widget's sender object omits member identifiers unless the workspace chooses to show agent names.

## WebSocket conventions

- Frames are JSON text, except for the literal `ping` and `pong` heartbeat strings.
- Envelope: `{ "v": 1, "type": "...", ... }`. Clients ignore unknown types.
- **Sockets never carry message sends.** REST is the only write path for messages.
- The server may send any event more than once. Clients merge by ID and by `seq` or `version`.

| Close code | Meaning | Client action |
|---|---|---|
| 1000 | Normal | Reconnect only if still needed |
| 1009 | Frame too large | Client bug; log it |
| 1011, 1012 | Server error or restart | Reconnect with jitter |
| 4400 | Invalid frame | Log; reconnect with jitter |
| 4401 | Auth expired | Get a new ticket, reconnect |
| 4403 | Access revoked | Do not reconnect until access is re-verified through REST |
| 4409 | Protocol version unsupported | Prompt to update |
| 4429 | Rate limited | Reconnect after at least 30 seconds |

## Documentation

The generated OpenAPI document is served at `/api/v1/openapi.json`, with a reference UI at `/api/v1/docs` that an operator can disable. Spec rule 11, that all public APIs have OpenAPI documentation, is enforced because routes are defined with the schema.
