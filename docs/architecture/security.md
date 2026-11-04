# Security architecture

The relay's protocol and threat model are in [notification-relay/protocol.md](../notification-relay/protocol.md).

## Tenant isolation

Five independent layers, on the assumption that any one can fail. See [ADR-0004](decisions/0004-tenant-isolation.md).

| Layer | Mechanism | Catches |
|---|---|---|
| 1. Types | `WorkspaceContext` is a branded type that only the authorisation middleware can create | Forgetting to authorise |
| 2. Repositories | `repositories(ctx)` applies `workspace_id` to every query. The raw handle is private to `packages/database`. System jobs use a separate `systemRepositories` whose calls are searchable and reviewed | Forgetting the filter |
| 3. Schema | Composite foreign keys on `(workspace_id, id)`. **Tested:** a cross-tenant reference fails at the database | Bugs in layers 1 and 2 on writes |
| 4. Isolation test suite | For every route in OpenAPI, a test calls it with a valid token for workspace B against resources in workspace A and expects 404. **A new route with no case fails CI.** The suite also fails on a served route missing from the contract. It compares workspace A's rows before and after each refused request, and checks that the workspace's own owner succeeds, so a route that always answered 404 would not pass. See `services/api/test/isolation.test.ts` | Bugs on reads and writes |
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
| Login throttling | Strict fixed-window counters in the `AuthGuard` Durable Object, one object per hashed key: 10 attempts per account and 50 per IP address per 15 minutes. A successful login clears the account counter. The account key is derived from the submitted email, so unknown accounts behave identically. Trade-off: anyone can lock an account out of password login for 15 minutes by failing on purpose. Reset still works, and existing sessions are unaffected. |
| Enumeration | Login, reset, and signup give identical responses and comparable timing whether or not the account exists. Login hashes against a dummy for unknown, disabled, and placeholder accounts. A reset request answers 202 before looking anything up, doing that work in `waitUntil`. |
| Refresh reuse | Rotation and reuse detection are one `batch()`. Presenting the previous token revokes that session, and only that session. One generation is kept, so an older token simply fails. Two concurrent refreshes count as reuse, so the dashboard must serialise refreshes across tabs (Web Locks), and a client that loses a refresh response signs in again. Both fail safe. |
| Password reset | Limit 3 per address and 20 per IP address per hour, silently past the limit. The job holds only the user ID, and the consumer creates the token as it sends, so no token reaches a queue or `failed_jobs`. Tokens last 1 hour, are stored as SHA-256, and travel in the URL fragment so they stay out of access logs. Confirming revokes every session and every outstanding reset token for the user. Confirmations are limited to 20 per IP address per 15 minutes. |
| Signing keys | `AUTH_SIGNING_KEY` is JSON: `{ active: { kid, privateKey, publicKey }, retired?: [{ kid, publicKey }] }`. To rotate, move the old key to `retired` and remove it once its tokens have expired, after 15 minutes. |

## RBAC

| Capability | Owner | Admin | Supervisor | Agent |
|---|---|---|---|---|
| View and reply to conversations, add notes | Yes | Yes | Yes | Yes |
| Assign to self | Yes | Yes | Yes | Yes |
| Assign to others, transfer | Yes | Yes | Yes | Own only |
| Merge contacts | Yes | Yes | Yes | No |
| Export or delete a contact | Yes | Yes | No | No |
| Manage canned responses (later) | Yes | Yes | Yes | No |
| Manage websites, automation, email settings, workspace name | Yes | Yes | No | No |
| Invite and remove members | Yes | Yes (not owners) | No | No |
| Security settings, workspace deletion, transfer ownership | Yes | No | No | No |

`packages/auth` holds this as pure data and functions, with a table-driven test. It gives an early 403. Member changes are also decided in SQL at commit: the last-owner rule, and the current roles of both the actor and the target, so a role changed mid-request counts.

## Workspaces and invitations

| Item | Decision |
|---|---|
| Creating a workspace | On `invite_only`, only someone who already owns a workspace. On `open`, any signed-in user. The first owner comes from the CLI. |
| Invitation token | Created as the email is sent, so no token reaches a queue, and stored as SHA-256. A duplicate job delivery replaces the token, so the newest email holds the working link. Lasts 7 days. |
| Accepting | Holding the token proves control of the address, so the account is marked verified. An existing account joins without a password, and its name and password are never changed. |
| Invitation limit | 30 per workspace per hour, because each one sends an email to any address. |
| Deleting an account | Anonymised, not deleted, because messages keep their authors. Needs the password again, because it can't be undone and an access token can be stolen. A wrong password answers 403, so that clients do not refresh and retry, and attempts share the login limits. Refused for the last active owner of a workspace. |
| Allowed origins | Exact origins only: no wildcards or paths, and plain HTTP only on the local machine. |

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
| Token scope | Can touch only this visitor's conversations. Internal notes filtered by `visibility` in SQL, in a repository of its own that has no way to return them. The audience claim keeps visitor and agent tokens from working in each other's routes. |
| Replays | A replayed `clientMessageId` returns a message only if this visitor sent it. An ID already used by anyone else answers 409, because returning that message could reveal an internal note. |
| Agent names | Hidden from visitors unless the website sets `showAgentNames`. |
| Storage | `localStorage` on the host site. With `data-consent="pending"` on the script tag, everything stays in `sessionStorage` until the page calls `window.OpenChat.grantConsent()`. An XSS bug on the host site can read it, but it only exposes that visitor's own chat. |
| Rendering | Message content is only ever a text node, in a Shadow DOM. The colour from settings is validated, and applied through the CSSOM. |
| Host page policy | A site with a CSP allows the installation for `script-src` and `connect-src`. The loader passes its nonce on to the chat bundle, and styles do not need `style-src`. A website that requires Turnstile also allows `https://challenges.cloudflare.com` for `script-src` and `frame-src`. |
| Turnstile | Optional per website, with installation-level keys, so the Cloudflare widget's hostnames must list every website that uses them. Checked when a new visitor session starts, not per message, because the session is what the rate limits count. A known visitor resumes with no check. If Cloudflare cannot answer, or the keys are wrong or gone, new visitors get 503: it fails closed, and existing visitors carry on. The script loads only when a new visitor first writes on a website that opted in. |
| Abuse controls | Strict counters in the `AuthGuard` Durable Object: 120 requests a minute per visitor, checked before the database. 20 messages a minute per visitor, 600 per website, and 1,200 other writes per website. 30 sessions an hour per IP address, and 3,000 per website. Ten sockets per visitor in a room. **Nothing yet caps total stored data**, per [the review](security-review-m1b.md#gaps-to-close-later). The rate limit binding would be cheaper but is approximate; the load test decides whether to switch. Trade-off: a flood can use up a website's allowance and hold up its real visitors, though not other websites; quotas on attachments per visitor and per day; optional Turnstile on the first message. Also 60 messages a minute per address, 20,000 per website a day, and 4,000 characters a message, which the operator can change for the whole installation. Every limit by address counts an IPv6 /64 as one address. See [abuse limits](../operations/abuse-limits.md). |
| Identity upgrade | Email provided by a visitor is unverified, and never merges into an existing contact automatically. Otherwise anyone could type a customer's email and read their history. Merging is an agent action. **A returning visitor only sees history tied to their own visitor token.** |
| Signed identity (later) | A host site can pass an HMAC of its user ID, signed server-side, to link identities safely. |

## Attachments

Uploads stream through the Worker to R2 ([ADR-0008](decisions/0008-attachment-transfer.md)).

| Control | Detail |
|---|---|
| Name | The extension must match the declared type, because people open saved files by name. Characters that reorder or hide text are removed |
| Type check | Allowlist by declared type *and* first bytes: PNG, JPEG, GIF, WebP, PDF, ZIP, DOCX, XLSX, PPTX, plain text, and CSV. Text has no signature, so it must have no NUL byte and must not start with `<` |
| Blocked types | HTML, SVG, XML, and script types, in either direction |
| Size | 25 MB, below the Cloudflare request limit of 100 MB. Not yet configurable per workspace. The declared length is enforced by the stream |
| Claiming | A message can name only files its sender uploaded to that conversation, in the last 23 hours, not yet on a message. Checked in SQL in the insert, so a bad ID means no message. Visitors can upload only into an existing conversation, 20 files an hour, and 500 an hour per website |
| Download | Normal auth only, with the token in a header, so that no file has a URL that works on its own. Clients fetch a file and show it from a `blob:` URL. A visitor gets only files on public messages in their own conversations |
| Response headers | `Content-Disposition: attachment` (inline only for an allowlist of raster images), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: no-store` |
| Orphans | Unattached uploads deleted after 24 hours, hourly, 200 at a time. A message cannot claim one past 23 hours, so a send cannot race the sweep |
| Bucket | Private. No public access or custom domain on it |
| Malware scanning | Future integration through a hook in `attachment.process` |

## Secrets

| Secret | Where | Rotation |
|---|---|---|
| `AUTH_SIGNING_KEY` (Ed25519) | Worker secret | Key ID in the JWT header; two active keys during rotation |
| Socket tickets | Signed with the access token key | One key to rotate. Tickets carry `aud: 'realtime'`, last 30 seconds, and neither kind of token is accepted as the other |
| `RELAY_SIGNING_KEY` (Ed25519) | Worker secret | Key ID; relay accepts registered keys |
| `DATA_ENCRYPTION_KEY` | Worker secret | `key_version` per row |
| Workspace email credentials | D1, AES-GCM encrypted with the key above and bound to `workspace_id` as associated data | Re-encryption job |
| APNs `.p8` | Relay Worker secret only | Apple key rotation, documented |

Spec §9 calls for Workers Secrets everywhere, but per-workspace credentials are created at runtime through the dashboard, so they cannot be Worker secrets. Encryption at the application layer is the alternative.

CI runs secret scanning. `.dev.vars.example` contains placeholders only, and `.dev.vars` is ignored by Git.

## Web and API

- Strict CSP on the dashboard, from `apps/dashboard/public/_headers`, with no third-party scripts or inline code.
- The dashboard keeps its access token in memory. Refreshes are serialised by one promise per tab and a Web Lock across tabs, because a repeated refresh revokes the session. Tokens in emailed links are removed from the address bar on load.
- CORS allowed only on `/api/v1/widget/*`. These routes use bearer tokens and no cookies, so the response headers reflect the caller, and each route refuses an origin its website does not allow. The dashboard is same-origin and needs none.
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
- A widget consent mode which uses session-only storage until the host site grants consent. Built.
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
