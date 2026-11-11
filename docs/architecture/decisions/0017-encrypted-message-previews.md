# ADR-0017: Encrypted message previews through the relay

**Status:** Proposed, awaiting the owner's go-ahead. When accepted, it supersedes one part of [ADR-0005](0005-relay-trust-model.md): "the relay composes the notification text". It also changes AGENTS.md rule 10, from "the relay never receives content" to "the relay never receives readable content". **Date:** 2026-11-11.

## Context

Today a notification says "New message" under the workspace name. The owner wants it to show the message itself, as other chat apps do.

The relay is the reason it does not. ADR-0005 and rule 10 keep message content away from the relay, because the managed relay is run by a third party (Orango Labs) for installations it does not control. Sending text through it in the clear would make Orango Labs a recipient of every customer's conversations. That is a large GDPR burden, and a breach of what the [privacy policy draft](../../legal/privacy-policy.md) promises.

iOS lets an app change a notification before it is shown, with a Notification Service Extension (NSE), when the payload sets `mutable-content: 1`. The relay already sets it. So the installation can encrypt a preview for each phone, the relay can carry ciphertext it cannot read, and the phone can decrypt it.

## Decision

### Keys

- When the app registers a workspace for push, it generates an **X25519 key pair for that subscription**. The private key goes in the iOS keychain, in an access group that the app and its NSE share. It never leaves the phone.
- The app sends the **public key to the installation**, with the relay subscription handle it already records (`POST .../push/subscriptions` gains an optional `previewKey`). The installation stores it on the `push_subscriptions` row. **The relay never sees the key.**
- A new registration makes a new key, so reinstalling or signing out discards the old one.

### Encryption, in the installation

- For each notification, the installation reads, for each recipient, every subscription with a preview key, up to the 20 each person may have.
- The plaintext is closed: `{ v: 1, sender: string ≤ 40, text: string ≤ 150 }`. `sender` is the contact's display name, or "Visitor". `text` is the message, cut at a character boundary. Attachments say "Photo" or "File".
- Encryption is **HPKE** (RFC 9180), base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. Workers WebCrypto has every primitive; CryptoKit has them from iOS 13. Both sides are tested against the RFC's published test vectors, so no new library is added.
- The plaintext is **padded** to 256 bytes, so the relay cannot tell long messages from short ones.
- The associated data binds `installationId`, `workspaceId`, `notificationId`, and the relay `subscriptionId`. The relay therefore cannot move a ciphertext to another notification, person, or phone.

### Through the relay

- The notification request gains `previews: [{ subscriptionId, ciphertext }]`: at most 20 entries, each ciphertext a fixed size. The schema stays closed, and anything else in it is still refused.
- The relay puts the matching ciphertext in that phone's APNs payload as `oc.preview`, and drops the rest. It never stores ciphertext in D1, and never logs it. A queued delivery holds it until it is sent, or for at most the queue's retention after failed retries.
- The relay still writes the fallback text ("New message"). A phone without the extension, without a key, or that fails to decrypt shows exactly what it shows today.
- The relay states support through its protocol version. The installation sends `previews` only to a relay that supports them, so an older relay is never sent a field it would refuse.

### On the phone

- A new NSE target, added by an Expo config plugin at prebuild ([ADR-0012](0012-native-builds-without-eas.md)). It reads `oc.preview`, finds the key by `subscriptionId`, decrypts, checks the associated data, and replaces the body with `sender: text`. On any failure, or near the NSE's time limit, it leaves the notification as it is.
- iOS's own "Show Previews" setting (Always, When Unlocked, Never) still applies on the lock screen.

### Who decides

- **The installation admin**, for the whole installation: "Show message text in notifications", **off by default**. Turning it on is a decision by the controller, who can then tell their team.
- **Each member**, in the app's notification settings, once the admin has turned it on.
- **Internal notes** are previewed only to members, who can read them anyway. Visitor-facing code is unchanged (rule 4).

## Consequences

- The relay operator, and anyone who breaches the relay, sees only fixed-size ciphertext and when it was sent. Rule 10 becomes: "The relay never receives readable content. The only content it carries is per-phone ciphertext it cannot decrypt."
- **Apple's push service carries the ciphertext**, as it carries every payload. Apple cannot read it either.
- The text exists in clear on the phone, as it already does in the app.
- A malicious installation can show arbitrary text to people who connected to it. ADR-0005 prevented that, but those people already trust that installation with their conversations. It still cannot reach anyone else.
- Each notification grows by about 350 bytes for each of the recipient's phones. The 4 KB APNs limit allows a fraction of the 20 phones a person may have. The installation sends previews for that person's newest phones only, about 8, with the exact number measured in tests.
- The privacy policy, the data processing agreement, and the relay protocol are updated before release, to say that the relay carries encrypted message text it cannot read.
- New work, in roughly this order:
  1. HPKE in `notification-protocol`, with the RFC test vectors.
  2. The relay's `previews` field.
  3. The installation's migration, setting, and encryption.
  4. The app's key handling and the NSE config plugin.
  5. A live test on a phone.
- Old apps have no key and keep generic text. An old installation never sends `previews`. Every step is additive.

## Alternatives considered

- **Plain text through the relay.** Simplest. It makes Orango Labs a recipient of every customer's message content, and contradicts the trust model. Rejected.
- **A per-installation key shared by all phones.** Simpler key management. But one phone's leak exposes every other phone's previews, and a removed member's phone could still decrypt. Rejected.
- **The phone fetches the text from the installation in the NSE**, with a short-lived token. Nothing passes through the relay. But the NSE then needs network access, and a session token stored where the extension can read it. Its timeout is short, so previews would often fail on poor networks. Kept as a fallback if HPKE proves impractical.
- **Silent notification, then a local one.** iOS throttles background pushes and gives no delivery guarantee. Rejected.
