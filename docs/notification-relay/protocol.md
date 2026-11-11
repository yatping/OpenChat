# Notification relay protocol

Version 1, implemented. Machine-readable: [openapi.draft.yaml](openapi.draft.yaml) and [protocol.draft.ts](protocol.draft.ts). Decisions: [ADR-0005](../architecture/decisions/0005-relay-trust-model.md), [ADR-0006](../architecture/decisions/0006-apns-transport.md).

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

The document must list the key under `relay.publicKeys`. The fetch proves control of the domain and is restricted: HTTPS, port 443, no redirects, 64 KB, 5-second timeout, and a block on IP addresses, single-label names, and `.local`, `.localhost`, and `.internal` names. All its failures answer the same `422`, so it cannot be used to probe networks.

The first registration of an ID wins, and an address holds one ID. A different key answers `409` and changes nothing. Because of that, someone who learns an installation's ID before it registers could claim it from their own domain and lock it out, until the operator removes the claim. They gain no access to its devices, as these need grants signed by the real key.

Key rotation is a signed request by the current key adding a new key, which is also confirmed through the well-known document. Not built yet.

### 2. Register a workspace

`POST /v1/workspaces/register` (signed) with `workspaceId` only. The workspace's name is never sent: it travels inside each phone's ciphertext ([ADR-0017](../architecture/decisions/0017-encrypted-notifications.md)). `POST /v1/workspaces/revoke` stops delivery and deletes that workspace's subscriptions.

### 3. Register a device

```text
App                          Installation                         Relay
 | sign in                        |                                 |
 | POST /push/grants  ----------->|                                 |
 |    <-- grant (EdDSA JWS, 5 min)|                                 |
 |                                                                  |
 | POST /v1/devices/register { grant, apnsToken, bundleId, env, device } ->|
 |                                                                  | verify the grant against
 |                                                                  | the installation's key
 |    <-- { deviceId, deviceSecret (first time only), subscriptionId } -----------|
 |                                |                                 |
 | make an X25519 key for subscriptionId, private half in the keychain |
 | POST /push/subscriptions { subscriptionId, previewKey } ->|      |
```

The installation learns only the opaque `subscriptionId` and the phone's public key for it, and never the token. The relay never sees the key. The phone keeps the private key in a keychain group it shares with its notification extension, readable after the first unlock and never backed up.

If the device sends its ID and secret, the same device is kept and no new secret is returned. With neither, but a token already on file, holding the token is the proof: it is an app reinstalled, or a phone passed on. The device gets a new secret, and **every earlier subscription of that device is removed**, so nobody receives a previous user's pushes. A different member signing in on the same device replaces the subscription for that workspace with a new `subscriptionId`.

`environment` must match the relay's. A token from the other environment would look invalid to APNs, and be deleted. Device registration is limited per IP, a grant is spent only once the other checks pass, and every kind of bad grant answers the same `401 invalid_grant`.

Grant claims, in a compact JWS whose header is `{ "alg": "EdDSA", "kid": "k1", "typ": "oc-grant+jwt" }`. The relay fixes the algorithm, and never takes it from the token:

```json
{
  "iss": "inst_01JC...",
  "aud": "relay-id",
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
| Device | Device secret, with `deviceId` and `subscriptionId` | Logout, or disconnecting one workspace |
| Installation | Signed request, with `subscriptionId` or `recipientId` | Member removed, or all sessions revoked |

The app calls it on logout and the installation does too, so a device offline during logout is still handled. A device that has deleted the app is handled by APNs returning 410.

### 6. Erasure

`POST /v1/installations/unregister` (signed for the installation, with no `X-Workspace-Id`, and an empty JSON object as the body) erases everything the relay holds about that installation, in one D1 batch:

- its delivery records, subscriptions, workspaces, key, and the installation row;
- every device left with no subscription afterwards. A device another installation still uses stays, with that installation's subscriptions.

It answers 204. Afterwards the installation is a stranger: repeating the request answers 401, and it may register again later, through the same admission as any other. Other isolates forget its key within 30 seconds, and until then a signed request finds nothing to act on.

An installation admin starts this from the dashboard (**Workspaces**, **Push notifications**, **Disconnect and erase**). The installation turns push off first and remembers that it disconnected from that relay (`installation.relay_disconnected_id`), so that a phone asking for a grant cannot register it again. It then deletes its own `push_subscriptions` rows. If the relay cannot be reached, push stays off and the admin repeats the action. **Reconnect** turns push on again, and phones register the next time the app starts.

For a request that reaches the relay's operator some other way, such as by email, `POST /v1/operator/erase` does the same erasure, with the operator token, and answers what it deleted. `pnpm oc relay erase --env <name> --installation <id>` calls it, after taking the installation off the admitted list so that it cannot register again in between.

An installation erased by the operator does not know it. It keeps signing grants, which the relay refuses before storing anything, until its next request to the relay is answered 401 and it forgets the registration.

When the app next registers with a device the relay erased, the relay answers 401 `invalid_device` before spending the grant, and the app registers again as a new device with that grant.

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
3. Installation and key known and not revoked, read through a 30-second cache, so a revocation takes up to that long. An unknown key answers the same as a bad signature.
4. Signature valid.
5. Workspace registered under this installation.
6. In `RelayGuard` (one Durable Object per installation): request ID unseen for 10 minutes, and rate limit not exceeded.
7. Parse the body against a closed schema.

Registering an installation differs, because its key arrives in the body: the body is parsed first, a per-IP limit applies, and the signature is checked against that key. Bodies are limited to 16 KB. Signed requests of any kind are limited to a burst of 300 and 5 per second for each installation, and a refused request can be retried with the same ID.

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
  "payloads": [{ "subscriptionId": "sub_01JC...", "ciphertext": "<406 base64url characters>" }],
  "expiresAt": "2026-11-03T11:00:00Z",
  "metadata": { "websiteId": "site_01JC..." }
}
```

- The schema is **closed**: unknown fields return 400. `metadata` accepts only `websiteId`. The only content is `payloads`: the notification [sealed](#encrypted-notification-format) by the installation for each of the recipient's phones, which the relay cannot decrypt. This is how "the relay never receives readable content" is enforced in code.
- `payloads` is required: 1 to 20 entries, one per subscription, each ciphertext exactly 406 characters. The relay sends each phone only its own, and nothing to a phone without one.
- `event`: `new_conversation`, `new_message`, `conversation_assigned`, `conversation_transferred`, `mention`, `conversation_updated`.
- `notificationId` is unique per recipient and stable across retries. The installation derives it from `(eventId, memberId)`.
- `POST /v1/notifications/batch` takes `{ "notifications": [...] }`, up to 100 items for one workspace, and returns a per-item result. Notification requests may be up to 1 MiB; other requests, 64 KiB.
- `expiresAt` defaults to one hour, and is limited to one day.
- The response is `202`, with an `id` to check. A duplicate returns the original `id` and status.
- The ciphertext travels only in the delivery queue's message, until it is sent or the retries end. It is never written to D1 and never logged.

`GET /v1/notifications/{id}` is signed, and returns counts per outcome, but never tokens or device data.

### APNs payload

The relay writes no text. Each phone receives only its own ciphertext, which its Notification Service Extension decrypts to show the workspace, the sender and the message.

```json
{
  "aps": {
    "alert": { "loc-key": "OC_NEW_MESSAGE" },
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
    "notificationId": "ntf_01JC...",
    "subscriptionId": "sub_01JC...",
    "c": "<this phone's sealed notification>"
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

`loc-key` is `OC_` and the event in capitals. If the extension cannot decrypt in time, iOS shows the app's own phrase for it, in the phone's language, with no workspace name. The phrases are in the app's [config plugin](../../apps/mobile/plugins/notification-service/index.ts). The payload is about 1 KB, whatever the number of phones. There is no badge number, because no single server knows the total across installations. The app computes it locally.

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
| 413 `PayloadTooLarge`, or any other 4xx | Permanent failure, and alert: this is a bug |

The record commits before the queue sees it. If queueing fails, the installation's retry finds a duplicate still `queued`, and queues it again.

Delivery is at least once. A crash can resend to a device, which `apns-collapse-id` folds into one alert, and `processed_attempt` keeps a repeated attempt from being counted twice. A retry names only the devices still outstanding, waits 30 seconds, then 1, 2, 5, 10, and 15 minutes, and is queued before results are recorded, so a crash can repeat work but cannot lose it. At `expiresAt`, outstanding devices count as failed, and are kept. `muted` is honoured and counted, but nothing sets it yet. A message that keeps throwing goes to a dead-letter queue after 5 retries.

Each invocation can hold only 6 simultaneous connections, which limits throughput to roughly 6 divided by APNs latency, per invocation. Consumer concurrency multiplies this, and it is plenty for the MVP. Measure it in Milestone 3.

### Provider tokens

APNs tokens must be refreshed no more than about every 20 minutes and before 60. Workers isolates come and go, so a per-isolate cache could mint many tokens. One `ApnsCredential` Durable Object per Apple identity mints a token and hands it out, renewing at about 40 minutes. Isolates cache it for 5 minutes. A token under 20 minutes old is not replaced, even if APNs calls it expired. After `TooManyProviderTokenUpdates` it mints nothing for 20 minutes. The token is stored, so eviction does not cause a new one.

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

A self-check reveals a platform behaviour change. Once a day, or on `POST /v1/operator/apns-check`, the relay sends to a device token of 64 zeros, which no phone can have. `BadDeviceToken` is the only healthy answer. It proves the path and the key, **not the topic**: real APNs answered the same for a made-up topic. The route takes `Authorization: Bearer` with `RELAY_OPERATOR_TOKEN`, and answers 404 to anyone else, or if that secret is not set.

## Encrypted notification format

[ADR-0017](../architecture/decisions/0017-encrypted-notifications.md): the installation encrypts each notification for each phone. This section defines the format, implemented in [`notification-crypto.ts`](../../packages/notification-protocol/src/notification-crypto.ts) and, for the phone, in the extension's [`NotificationCrypto.swift`](../../apps/mobile/plugins/notification-service/ios/NotificationCrypto.swift).

- **Key.** Each subscription has an X25519 key pair made on the phone. The public key, 32 bytes as base64url (`previewKey`), goes to the installation only.
- **Cipher.** HPKE (RFC 9180), base mode, single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. `info` is `OpenChat notification v1`.
- **Associated data.** `OCN1`, `installationId`, `workspaceId`, `notificationId` and the relay `subscriptionId`, joined with line feeds. A ciphertext opens only for that notification on that phone.
- **Plaintext.** Exactly 256 bytes: a 2-byte big-endian length, the UTF-8 JSON `{"v":1,"title":…,"sender":…,"text":…}`, then zeros. A reader refuses non-zero padding.
- **Content.** At most 40, 40 and 150 characters. Line and control characters become spaces and bidi overrides are removed. If the JSON does not fit, the text is shortened first, then the sender, then the title, ending with `…`, never inside a character.
- **Sealed form.** `enc` (32 bytes) then the ciphertext and tag (272 bytes), as 406 base64url characters, the same for every notification.
- **Text.** `title` is the workspace name. For a message, `sender` is the contact's or colleague's name, or "Visitor", and `text` is the message, "Photo", "File", or for an internal note, "Note: " and the note. An assignment has no sender, and the text "Conversation assigned to you". The text is English for now.
- **Who decides.** Nobody switches this off: there is no plain-text path. Each person hides message text on the lock screen with iOS's **Show Previews** setting.

## Relay data

Own D1 database. No conversation data, and **no messages, names, languages, or email addresses**. Ciphertext is never stored.

```text
installations   id, base_url, status, quota_tier, created_at
installation_keys  installation_id, key_id, public_key, status, created_at
workspaces      installation_id, workspace_id, status
devices         id, secret_hash, platform, bundle_id, environment, apns_token, token_lookup, created_at, updated_at
                UNIQUE(bundle_id, token_lookup)
subscriptions   id, device_id, installation_id, workspace_id, recipient_id, muted, created_at
                UNIQUE(device_id, installation_id, workspace_id)
notifications   id, installation_id, workspace_id, notification_id, event, recipient_id, status, counts, created_at
                UNIQUE(installation_id, workspace_id, notification_id)
```

The relay keeps no workspace names and no languages. Migration `0004` emptied `workspaces.display_name` and `devices.locale`, and migration `0005` dropped them.

Every read filters by `installation_id`. `workspaceId` is never used alone, because it is only meaningful within an installation. `recipient_id` is the installation's opaque `memberId`.

| Data | Retention |
|---|---|
| Nonces | 10 minutes |
| Consumed grant IDs | 10 minutes |
| Notification records, including dedupe | 30 days in full; dedupe window guaranteed for 72 hours |
| Installations, keys, workspaces, subscriptions | Until the installation unregisters, or the operator erases it ([Erasure](#6-erasure)). A subscription also goes when its device or member is removed, or its workspace revoked |
| Devices | Until APNs reports the token invalid, or 7 days after the device's last subscription went. A device left with none by an erasure goes at once |
| Per-installation request and quota counters in `RelayGuard` | 10 minutes after last use. They hold request IDs, and recipient IDs in quota names |
| Inactive installations | Kept until erased. Finding ones with no traffic is not built yet |

The daily cron deletes notification records past 30 days and devices left with no subscription for 7 days.

APNs tokens are encrypted at rest with AES-256-GCM under a key derived from the `RELAY_TOKEN_KEY` Worker secret, which narrows the exposure of a database-only leak. `token_lookup` is a keyed hash of the token, so that uniqueness needs no plain token. Losing that secret loses the ability to deliver, until apps register again. Rotating it is not built yet.

## Rate limits

Enforced in `RelayGuard`. Defaults for the managed relay, tuned from real usage:

| Scope | Limit |
|---|---|
| Notifications per installation | 60 per minute, burst 300; raised on request. Takes one per item in a batch, or nothing |
| Notifications per recipient | 30 per minute |
| New installation registrations | Approximate per-IP limit through the binding |
| Device registration | Per grant and per IP |

Checking the quota comes after the replay check, so a replay costs nothing. An exceeded quota returns 429 with `Retry-After`. The installation's queue consumer then retries with delay, and messaging is unaffected.

## Modes

| | Managed | Independent |
|---|---|---|
| Code | `services/notification-relay` | Same |
| `RELAY_MODE` | `open` | `private` |
| Registration | Proof of domain control; quotas | Allowlist of installation IDs |
| APNs key | Project's, in the operator's secrets. **Never distributed.** | Customer's |
| Bundle IDs | Official app | Customer's |
| Reachability | Public URL | Public URL, on the same account or not. The relay sets `global_fetch_strictly_public`, because without it, domain proof failed between two Workers on one account |

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
| Relay database leak | Public keys only; device secrets hashed; tokens encrypted; no content, not even ciphertext |
| Malicious installation pushing to strangers | It cannot obtain tokens, and subscriptions need a device-submitted grant |
| Malicious installation phishing its own connected users | Since ADR-0017 it can write any text into its own users' notifications, as it can into their conversations. It still reaches only people who connected to it. Control, line and bidi characters are removed; per-installation quotas; operator can revoke |
| Malicious installation sending a fake relay URL to harvest tokens | Build-time relay allowlist in the app |
| Workspace ID collision or spoofing | All keys scoped by `installationId`; verified against the signature |
| Stolen grant | Short-lived, single-use, audience-bound. It needs a token to be useful, and the worst outcome is a subscription for the thief's own device under that member; the member's installation controls grant issuance |
| Stolen device secret | Changes only that device's token. Delete and re-register to rotate |
| Stolen installation key | The operator revokes it, by hand in D1 for now. Rotation is not built, so recovery means a new installation ID. Limited to pushing to that installation's own subscribers |
| Compromised relay | It could send pushes to registered devices, but only with the fallback phrases: it cannot forge or read ciphertext, which is bound to the notification and phone. It has no way to read installations. Apps always authenticate separately to fetch |
| App impersonation for registration (later) | App Attest in a future version |

## Testing requirements

From spec §16: registration, multiple devices per user, multiple workspaces, invalid tokens, temporary failures, signature verification, replay protection, and idempotency. Added: each signature field tampered individually; wrong audience; reused grant; unknown body field rejected; an official-app build refusing a non-allowlisted relay; a test asserting no schema can hold free text.

## Test vector

[`packages/notification-protocol/test/test-vector.json`](../../packages/notification-protocol/test/test-vector.json) holds a key, canonical string, and signature, so that another implementation can check compatibility. The key is public and for testing only. The tests check it in Node and workerd.

The encrypted notification format is checked against RFC 9180, Appendix A.1.1, which uses the same cipher suite, in [`notification-crypto.test.ts`](../../packages/notification-protocol/test/notification-crypto.test.ts). The iOS extension must pass the same vector.
