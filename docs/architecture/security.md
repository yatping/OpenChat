# Security architecture

The relay's protocol and threat model are in [notification-relay/protocol.md](../notification-relay/protocol.md).

## Tenant isolation

Five independent layers, on the assumption that any one can fail. See [ADR-0004](decisions/0004-tenant-isolation.md).

| Layer | Mechanism | Catches |
|---|---|---|
| 1. Types | `WorkspaceContext` is a branded type that only the authorisation middleware can create | Forgetting to authorise |
| 2. Repositories | `repositories(ctx)` applies `workspace_id` to every query. The raw handle is private to `packages/database`. System jobs use a separate `systemRepositories` whose calls are searchable and reviewed | Forgetting the filter |
| 3. Schema | Composite foreign keys on `(workspace_id, id)`. **Tested:** a cross-tenant reference fails at the database | Bugs in layers 1 and 2 on writes |
| 4. Isolation test suite | For every route in OpenAPI, a test calls it with a valid token for workspace B against resources in workspace A and expects 404. **A new route with no case fails CI** | Bugs on reads |
| 5. Other stores | R2 keys are prefixed `w/<workspaceId>/`, and access first checks the attachment row. Durable Object names derive from verified IDs only | Non-SQL leakage |

Every request verifies, in order: identity, membership, permission, resource ownership (spec §9). Cross-tenant requests return **404**, so resource existence does not leak.

## Agent authentication

| Item | Decision |
|---|---|
| Password hash | scrypt with N=2^15, r=8, p=3 (32 MiB), one of OWASP's listed configurations. N=2^17 needs 128 MiB, which is the entire isolate limit. Parameters stored per hash for later upgrades. Timing confirmed in S3. |
| Access token | JWT, EdDSA signed, 15-minute lifetime. Claims: `sub`, `sid`, `iss = installationId`. **No roles in the token**; membership is read per request so that revocation is immediate. |
| Refresh token | Opaque, 256-bit, stored as SHA-256. Rotated on each use. Reuse of a previous token revokes the session. Lifetime 30 days, sliding; 90 for mobile. |
| Dashboard transport | Same origin, so the refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie. The access token stays in memory. |
| Mobile transport | Bearer token. Stored in `expo-secure-store` per connection. |
| CSRF | `SameSite=Strict`, plus requiring `Authorization` on all data routes. Only the refresh route uses the cookie, and it also checks `Origin`. |
| Login throttling | A strict per-account limit in a Durable Object (`AuthGuard`, or a class shared with rate limiting), plus an approximate per-IP limit. The relatively costly hash makes unthrottled login a denial-of-service risk. |
| Enumeration | Login, reset, and signup give identical responses and comparable timing whether or not the account exists. |

## RBAC

| Capability | Owner | Admin | Supervisor | Agent |
|---|---|---|---|---|
| View and reply to conversations, add notes | Yes | Yes | Yes | Yes |
| Assign to self | Yes | Yes | Yes | Yes |
| Assign to others, transfer | Yes | Yes | Yes | Own only |
| Merge contacts | Yes | Yes | Yes | No |
| Export or delete a contact | Yes | Yes | No | No |
| Manage canned responses (later) | Yes | Yes | Yes | No |
| Manage websites, automation, email settings | Yes | Yes | No | No |
| Invite and remove members | Yes | Yes (not owners) | No | No |
| Security settings, workspace deletion, transfer ownership | Yes | No | No | No |

`packages/auth` holds this as pure data and functions, with a table-driven test. The last-owner rule is enforced in SQL.

## Visitor authentication

The `websiteKey` is **public by design** and grants only the ability to ask for a visitor session.

```text
POST /api/v1/widget/sessions { websiteKey, refreshToken? } + Origin header
  -> check Origin against the website's allowed list
  -> returns a visitor access token (JWT, 1 hour, aud = "visitor", claims: visitorId, websiteId, workspaceId)
     and a long-lived visitor refresh token (opaque, hashed in D1)
```

| Control | Notes |
|---|---|
| Origin allowlist | A control against *other websites embedding the widget*. **Not authentication:** any script can forge the header. Do not rely on it for anything else. |
| Token scope | Can touch only this visitor's conversations. Internal notes filtered by `visibility` in SQL. |
| Storage | `localStorage` on the host site, subject to consent settings. An XSS bug on the host site can read it, but it only exposes that visitor's own chat. |
| Abuse controls | Rate limit binding per visitor and per website for messages; session creation limits; quotas on attachments per visitor and per day; optional Turnstile on the first message. |
| Identity upgrade | Email provided by a visitor is unverified, and never merges into an existing contact automatically. Otherwise anyone could type a customer's email and read their history. Merging is an agent action. **A returning visitor only sees history tied to their own visitor token.** |
| Signed identity (later) | A host site can pass an HMAC of its user ID, signed server-side, to link identities safely. |

## Attachments

Uploads stream through the Worker to R2 ([ADR-0008](decisions/0008-attachment-transfer.md)).

| Control | Detail |
|---|---|
| Type check | Allowlist by declared type *and* magic bytes, read from the first chunk |
| Blocked types | HTML, SVG, XML, and script types, in either direction |
| Size | 25 MB by default, configurable per workspace, and below the Cloudflare request limit of 100 MB |
| Download | `GET /attachments/{id}` with normal auth, or a signed token valid for 5 minutes for `<img>` use |
| Response headers | `Content-Disposition: attachment` (inline only for an allowlist of raster images), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private` |
| Orphans | Unattached uploads deleted after 24 hours |
| Bucket | Private. No public access or custom domain on it |
| Malware scanning | Future integration through a hook in `attachment.process` |

## Secrets

| Secret | Where | Rotation |
|---|---|---|
| `AUTH_SIGNING_KEY` (Ed25519) | Worker secret | Key ID in the JWT header; two active keys during rotation |
| `TICKET_SIGNING_KEY` | Worker secret | Short TTL makes rotation simple |
| `RELAY_SIGNING_KEY` (Ed25519) | Worker secret | Key ID; relay accepts registered keys |
| `DATA_ENCRYPTION_KEY` | Worker secret | `key_version` per row |
| Workspace email credentials | D1, AES-GCM encrypted with the key above and bound to `workspace_id` as associated data | Re-encryption job |
| APNs `.p8` | Relay Worker secret only | Apple key rotation, documented |

Spec §9 calls for Workers Secrets everywhere, but per-workspace credentials are created at runtime through the dashboard, so they cannot be Worker secrets. Encryption at the application layer is the alternative.

CI runs secret scanning. `.dev.vars.example` contains placeholders only, and `.dev.vars` is ignored by Git.

## Web and API

- Strict CSP on the dashboard; no third-party scripts.
- CORS allowed only on `/api/v1/widget/*`, per website origin. The dashboard is same-origin and needs none.
- All input validated with Zod. Request bodies have explicit limits.
- Message content is plain text, rendered escaped on every client. There is no HTML message type. Links are detected on display and get `rel="noopener noreferrer"`.
- Email templates escape interpolated values.
- `security.txt` and a disclosure policy accompany the first public release.

## Logging

The shared logger takes a typed field allowlist, so sensitive data has to be deliberately added. Every line has `requestId`, `installationId`, `workspaceId`, and `route`. Never logged: passwords, tokens, tickets, keys, message content, or email addresses and names.

## Privacy

Customers are the controllers of visitor data. For GDPR and similar laws, the product needs:

- Export and erase-contact operations (Milestone 4, with the chunked job).
- Consent evidence for follow-ups.
- A widget consent mode which uses session-only storage until the host site grants consent.
- Retention settings (Milestone 6).
- A location hint for D1 and a jurisdiction for Durable Objects and R2 where needed. See [open question Q10](open-questions.md).

The operator of a **managed relay** holds device tokens and recipient IDs, which may be personal data. That operator needs a privacy policy and terms. See [Q5](open-questions.md).

## Threat summary

| Threat | Primary defence |
|---|---|
| Cross-tenant read or write | Isolation layers above |
| Internal note shown to a visitor | `CHECK` constraint, `VisitorEvent` type, SQL filter, test matrix |
| Account takeover by a guessed email in the widget | No automatic contact merging |
| Stolen refresh token | Rotation with reuse detection |
| Malicious installation harvesting tokens | Tokens never reach installations; relay allowlist fixed at build time |
| Spoofed push | Ed25519, device-submitted grants, replay protection |
| Forged widget origin | Accepted limitation; limited by rate limits and quotas |
| Stored XSS | Plain-text messages; attachment headers |
| Denial of service through login or uploads | Throttles and quotas; the Cloudflare edge in front |
