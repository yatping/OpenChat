# Notification relay protocol

Version 1, design draft. Machine-readable: [openapi.draft.yaml](openapi.draft.yaml) and [protocol.draft.ts](protocol.draft.ts). Decisions: [ADR-0005](../architecture/decisions/0005-relay-trust-model.md), [ADR-0006](../architecture/decisions/0006-apns-transport.md).

## Goals

- The same code and protocol serve managed and independent modes. Only configuration differs.
- The relay can never read conversation content, and receives none.
- Installations never hold APNs tokens.
- Anyone may register a new installation on an open relay without an account, since spec §1 rules out a mandatory subscription, and doing so grants them no access to other people's devices.
- Messaging keeps working when the relay is down.

## Trust model

```text
         Installation key pair (Ed25519)
                     |
      signs requests |  signs grants
                     v
   Relay  <----------+---------- Device (carries the grant, and supplies its own token)
```

| Party | Trusted for | Not trusted for |
|---|---|---|
| Installation | Deciding who its own members are | Anything about other installations, or any device that has not opted in |
| Device | Its own token | Claiming membership: it needs a grant |
| Relay | Delivering pushes, keeping tokens | Reading content. It has no credential for an installation |

**Key idea:** a push requires two independent consents. An installation vouches for a member through a signed grant, and only the device that owns the token can submit that grant to the relay. A malicious installation therefore cannot target arbitrary devices, because it never sees a token. It can only reach people who deliberately connected their app to it.

## Why Ed25519, not HMAC

The spec allows either. HMAC would put a copy of each installation's secret in the relay's database, so a breach of the relay would allow impersonation of every installation. With Ed25519, the relay stores only public keys. Grants can also be verified with the same key. Only one algorithm is supported, which avoids downgrade paths and dual code. WebCrypto support on Workers is confirmed in spike S5.

## Lifecycle

### 1. Register an installation

```text
Installation                                        Relay
  generate Ed25519 key pair (Worker secret)
  publish public key in /.well-known/openchat.json
  POST /v1/installations/register  (signed) ------->
                                                    verify signature
                                                    GET https://<baseUrl>/.well-known/openchat.json
                                                    confirm it lists this installation ID and public key
                                                    open mode: apply new-installation quota
                                                    private mode: installation must be on the allowlist
                                     <--- 201 ------
```

The document fetch proves control of the domain. The fetch is restricted: HTTPS, port 443, no redirects, 64 KB, 5-second timeout, and a block on IP-literal hosts.

Key rotation is a signed request by the current key adding a new key, which is also confirmed through the well-known document.

### 2. Register a workspace

`POST /v1/workspaces/register` (signed) with `workspaceId` and an optional `displayName` of up to 40 characters, used as the notification title. `POST /v1/workspaces/revoke` stops delivery and deletes that workspace's subscriptions.

### 3. Register a device

```text
App                          Installation                         Relay
 | sign in                        |                                 |
 | POST /push/grants  ----------->|                                 |
 |    <-- grant (EdDSA JWS, 5 min)|                                 |
 |                                                                  |
 | POST /v1/devices/register { grant, apnsToken, bundleId, env, locale, device } ->|
 |                                                                  | verify the grant against
 |                                                                  | the installation's key
 |    <-- { deviceId, deviceSecret (first time only), subscriptionId } -----------|
 |                                |                                 |
 | POST /push/subscriptions { subscriptionId } ->|                  |
```

The installation learns only the opaque `subscriptionId`, and never the token.

Grant claims:

```json
{
  "iss": "inst_01JC...",
  "aud": "relay-id",
  "kid": "k1",
  "wid": "work_01JC...",
  "sub": "mem_01JC...",
  "jti": "grant_01JC...",
  "iat": 1793700000,
  "exp": 1793700300
}
```

Rules: `aud` must match the relay, `exp` is at most 5 minutes after `iat`, and `jti` is single-use, stored in `RelayGuard`. The relay checks that `bundleId` is one it holds credentials for. The app obtains the relay URL from a build-time allowlist, never only from the installation.

### 4. Token rotation

`POST /v1/devices/token`, authenticated with `deviceId` and `deviceSecret` (`Authorization: Bearer`). It updates every subscription at once, so installations need not be online, and they never see the token.

### 5. Unregister

`POST /v1/devices/unregister`, in either form:

| Caller | Auth | Use |
|---|---|---|
| Device | Device secret, with `subscriptionId` | Logout, or disconnecting one workspace |
| Installation | Signed request, with `subscriptionId` or `recipientId` | Member removed, or all sessions revoked |

The app calls it on logout and the installation does too, so a device offline during logout is still handled. A device that has deleted the app is handled by APNs returning 410.

## Signed request format

| Header | Value |
|---|---|
| `X-Installation-ID` | `inst_...`. **Added to the spec's list.** |
| `X-Workspace-ID` | `work_...`, or absent on installation-level calls |
| `X-Key-ID` | Which registered key |
| `X-Request-ID` | Unique per request; used as the replay nonce |
| `X-Timestamp` | Unix seconds |
| `X-Signature` | `v1=<base64url Ed25519 signature>` |

The signature covers these fields, joined by `\n`:

```text
OCRELAY-V1
<HTTP method, uppercase>
<path, without query>
<X-Installation-ID>
<X-Workspace-ID or empty>
<X-Key-ID>
<X-Request-ID>
<X-Timestamp>
<lowercase hex SHA-256 of the exact body bytes>
```

**Verification order, cheapest first:**

1. All headers present and well-formed, body size within the limit.
2. Timestamp within ±300 seconds.
3. Installation and key known and not revoked, read through a short-lived cache.
4. Signature valid.
5. Workspace registered under this installation.
6. In `RelayGuard` (one Durable Object per installation): request ID unseen for 10 minutes, and rate limit not exceeded.
7. Parse the body against a closed schema.

Replay protection uses a Durable Object because it requires strong consistency, which neither KV nor the rate limit binding provides. Nonces outlive the timestamp window, so an old request cannot be replayed once forgotten. Each installation has its own object, so one cannot exhaust another's capacity.

## Notifications

```json
POST /v1/notifications/send
{
  "workspaceId": "work_01JC...",
  "event": "new_message",
  "recipientId": "mem_01JC...",
  "conversationId": "conv_01JC...",
  "notificationId": "ntf_01JC...",
  "expiresAt": "2026-11-03T11:00:00Z",
  "metadata": { "websiteId": "site_01JC..." }
}
```

- The schema is **closed**: unknown fields return 400. `metadata` accepts only `websiteId`. This is how the "no conversation data" promise is enforced in code.
- `event`: `new_conversation`, `new_message`, `conversation_assigned`, `conversation_transferred`, `mention`, `conversation_updated`.
- `notificationId` is unique per recipient and stable across retries. The installation derives it from `(eventId, memberId)`.
- `POST /v1/notifications/batch` takes up to 100 items and returns a per-item result.
- The response is `202`, with an `id` to check. A duplicate returns the original `id` and status.

`GET /v1/notifications/{id}` is signed, and returns counts per outcome, but never tokens or device data.

### APNs payload

The relay, not the installation, composes the notification text. So a malicious installation cannot use the official app's identity to display arbitrary phishing text, apart from its own `displayName`, shown as a label.

```json
{
  "aps": {
    "alert": { "title": "Company A", "body": "New message" },
    "sound": "default",
    "thread-id": "<first 32 hex of SHA-256(installationId + conversationId)>",
    "mutable-content": 1
  },
  "oc": {
    "v": 1,
    "event": "new_message",
    "installationId": "inst_01JC...",
    "workspaceId": "work_01JC...",
    "conversationId": "conv_01JC...",
    "notificationId": "ntf_01JC..."
  }
}
```

| Header | Value |
|---|---|
| `apns-topic` | The device's `bundleId` |
| `apns-push-type` | `alert` |
| `apns-priority` | `10` |
| `apns-expiration` | Unix time of `expiresAt`, defaulting to one hour |
| `apns-collapse-id` | Hash of installation, conversation, and event, at most 64 bytes, so a burst collapses to one |
| `apns-id` | Derived from `notificationId` |

The body text uses the device's stored `locale`, from a table in the relay. There is no badge number, because no single server knows the total across installations. The app computes it locally.

### Delivery pipeline

```text
Signed POST -> RelayGuard (nonce, rate, dedupe) -> D1 record -> Queue -> consumer
                                                                         | resolve devices
                                                                         | ApnsCredential DO: current JWT
                                                                         | ApnsTransport.send (concurrency 6)
                                                                         v
                                                                  record per-device outcome
```

| APNs result | Action |
|---|---|
| 200 | `delivered` (to APNs, not necessarily to the device) |
| 410 `Unregistered`; 400 `BadDeviceToken`; 400 `DeviceTokenNotForTopic` | Delete the device and report the outcome. The metric separates these, since a surge of `BadDeviceToken` often means a sandbox and production mix-up, not dead tokens. |
| 403 `ExpiredProviderToken` | Refresh the JWT, retry once |
| 403 `InvalidProviderToken` and other credential errors | **Do not delete devices.** Retry with backoff, and alert the operator |
| 429 `TooManyRequests`, 500, 503, network error | Retry with backoff until `expiresAt` |
| 429 `TooManyProviderTokenUpdates` | Stop minting tokens, and alert. See below |
| 400 `PayloadTooLarge` or other bad request | Permanent failure, and alert: this is a bug |

Each invocation can hold only 6 simultaneous connections, which limits throughput to roughly 6 divided by APNs latency, per invocation. Consumer concurrency multiplies this, and it is plenty for the MVP. Measure it in Milestone 3.

### Provider tokens

APNs tokens must be refreshed no more than about every 20 minutes and before 60. Workers isolates come and go, so a per-isolate cache could mint many tokens. One `ApnsCredential` Durable Object per Apple identity mints a token and hands it out, renewing at about 40 minutes. Isolates cache it briefly in memory.

### APNs transport

```typescript
interface ApnsTransport {
  send(request: ApnsRequest): Promise<ApnsResponse>;
}
```

| Implementation | When |
|---|---|
| `WorkersFetchTransport` | Default in production. Relies on Cloudflare's proxy using HTTP/2, which is observed but not documented |
| `HttpGatewayTransport` | Contingency. Forwards to an authenticated HTTP/2 gateway, such as a Cloudflare Container |
| `MockApnsTransport` | Tests and local development. Simulates each error above |

A startup self-check and a metric on `Network connection lost` errors would reveal a platform behaviour change.

## Relay data

Own D1 database. No conversation data, and **no messages, names, or email addresses**.

```text
installations   id, base_url, status, quota_tier, created_at
installation_keys  installation_id, key_id, public_key, status, created_at
workspaces      installation_id, workspace_id, display_name, status
devices         id, secret_hash, platform, bundle_id, environment, apns_token, locale, created_at, updated_at
                UNIQUE(bundle_id, apns_token)
subscriptions   id, device_id, installation_id, workspace_id, recipient_id, muted, created_at
                UNIQUE(device_id, installation_id, workspace_id)
notifications   id, installation_id, workspace_id, notification_id, event, recipient_id, status, counts, created_at
                UNIQUE(installation_id, workspace_id, notification_id)
```

Every read filters by `installation_id`. `workspaceId` is never used alone, because it is only meaningful within an installation. `recipient_id` is the installation's opaque `memberId`.

| Data | Retention |
|---|---|
| Nonces | 10 minutes |
| Consumed grant IDs | 10 minutes |
| Notification records, including dedupe | 30 days in full; dedupe window guaranteed for 72 hours |
| Devices | Until removed, or APNs reports them invalid |
| Inactive installations | Reported after 180 days of no traffic; removal per the operator's policy |

APNs tokens may be encrypted at rest with a Worker secret. Doing so narrows the exposure of a database-only leak at a small CPU cost, so it is the default.

## Rate limits

Enforced in `RelayGuard`. Defaults for the managed relay, tuned from real usage:

| Scope | Limit |
|---|---|
| Notifications per installation | 60 per minute, burst 300; raised on request |
| Notifications per recipient | 30 per minute |
| New installation registrations | Approximate per-IP limit through the binding |
| Device registration | Per grant and per IP |

An exceeded quota returns 429 with `Retry-After`. The installation's queue consumer then retries with delay, and messaging is unaffected.

## Modes

| | Managed | Independent |
|---|---|---|
| Code | `services/notification-relay` | Same |
| `RELAY_MODE` | `open` | `private` |
| Registration | Proof of domain control; quotas | Allowlist of installation IDs |
| APNs key | Project's, in the operator's secrets. **Never distributed.** | Customer's |
| Bundle IDs | Official app | Customer's |
| Reachability | Public URL | URL, or a **service binding** if on the same account. Plain `fetch` between Workers on one zone can return error 1042 |

**Which app works with which relay:**

| App | Relay | Works | Notes |
|---|---|---|---|
| Official | Managed | Yes | Standard |
| Custom | Customer's | Yes | Independent |
| Official | Customer's | **No push** | The customer's relay has no key for the official bundle, and the official app's allowlist refuses it. Messaging still works; the app says push is unavailable for this connection |
| Custom | Managed | **No push** | Same, reversed |

An installation may support both one day. `push_subscriptions.relay_id` and `relay.bundleIds` leave room for that, but the MVP has one relay per installation.

## Threat model

| Threat | Defence |
|---|---|
| Unauthenticated push | Signed requests only, with no exceptions |
| Replay | Timestamp window, nonce store, `notificationId` dedupe |
| Relay database leak | Public keys only; device secrets hashed; tokens encrypted; no content |
| Malicious installation pushing to strangers | It cannot obtain tokens, and subscriptions need a device-submitted grant |
| Malicious installation phishing its own connected users | Fixed body text; `displayName` limited to 40 characters and sanitised; per-installation quotas; operator can revoke |
| Malicious installation sending a fake relay URL to harvest tokens | Build-time relay allowlist in the app |
| Workspace ID collision or spoofing | All keys scoped by `installationId`; verified against the signature |
| Stolen grant | Short-lived, single-use, audience-bound. It needs a token to be useful, and the worst outcome is a subscription for the thief's own device under that member; the member's installation controls grant issuance |
| Stolen device secret | Changes only that device's token. Delete and re-register to rotate |
| Stolen installation key | Revoke through the operator, then re-register after rotating. Limited to pushing to that installation's own subscribers |
| Compromised relay | It could send pushes to registered devices, but has no content and no way to read installations. Apps always authenticate separately to fetch |
| App impersonation for registration (later) | App Attest in a future version |

## Testing requirements

From spec §16: registration, multiple devices per user, multiple workspaces, invalid tokens, temporary failures, signature verification, replay protection, and idempotency. Added: each signature field tampered individually; wrong audience; reused grant; unknown body field rejected; an official-app build refusing a non-allowlisted relay; a test asserting no schema can hold free text.

## Test vector

[`packages/notification-protocol/test/test-vector.json`](../../packages/notification-protocol/test/test-vector.json) holds a key, canonical string, and signature, so that another implementation can check compatibility. The key is public and for testing only. The tests check it in Node and workerd.
