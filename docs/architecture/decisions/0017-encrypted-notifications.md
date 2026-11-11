# ADR-0017: Encrypted notifications through the relay

**Status:** Proposed, awaiting the owner's go-ahead. When accepted, it supersedes the parts of [ADR-0005](0005-relay-trust-model.md) that have the relay compose notification text and hold workspace names and phone languages. It also changes AGENTS.md rule 10, from "the relay never receives content" to "the relay never receives readable content". **Date:** 2026-11-11.

## Context

Today a notification says "New message" under the workspace name, and the relay writes both. The owner wants it to show the message itself, as other chat apps do.

The relay is the reason it does not. ADR-0005 and rule 10 keep message content away from the relay, because the managed relay is run by a third party (Orango Labs) for installations it does not control. Sending text through it in the clear would make Orango Labs a recipient of every customer's conversations. That is a large GDPR burden, and a breach of what the [privacy policy draft](../../legal/privacy-policy.md) promises.

iOS lets an app change a notification before it is shown, with a Notification Service Extension (NSE), when the payload sets `mutable-content: 1`. The relay already sets it. So the installation can encrypt each notification for each phone, the relay can carry ciphertext it cannot read, and the phone can decrypt it.

OpenChat has not launched, so there are no old apps, installations or relays to support. **Encrypted notifications are the only kind.** There is no setting to turn them off and no plain-text path in the relay.

## Decision

### Keys

- When the app registers a workspace for push, it generates an **X25519 key pair for that subscription**. The private key goes in the iOS keychain, in an access group that the app and its NSE share. It never leaves the phone.
- The app sends the **public key to the installation**, with the relay subscription handle it already records. `POST .../push/subscriptions` requires `previewKey`; a subscription without one is refused. The installation stores it on the `push_subscriptions` row. **The relay never sees the key.**
- A new registration makes a new key, so reinstalling or signing out discards the old one.

### Encryption, in the installation

- For each notification, the installation encrypts one payload for each of the recipient's subscriptions, up to the 20 each person may have.
- The plaintext is closed: `{ v: 1, title: string ≤ 40, sender: string ≤ 40, text: string ≤ 150 }`. `title` is the workspace name. `sender` is the contact's display name, or "Visitor". `text` is the message, cut at a character boundary. Attachments say "Photo" or "File". Event types without a message, such as an assignment, use a short text written by the installation in the member's language.
- Encryption is **HPKE** (RFC 9180), base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. Workers WebCrypto has every primitive; CryptoKit has them from iOS 13. Both sides are tested against the RFC's published test vectors, so no new library is added.
- The plaintext is **padded** to 256 bytes, so the relay cannot tell long messages from short ones.
- The associated data binds `installationId`, `workspaceId`, `notificationId`, and the relay `subscriptionId`. The relay therefore cannot move a ciphertext to another notification, person, or phone.

### Through the relay

- The notification request carries `payloads: [{ subscriptionId, ciphertext }]`, at most 20 entries, each ciphertext a fixed size. It is required. The schema stays closed, and anything else in it is refused.
- The relay sends each phone only its own ciphertext, as `oc.c` in that phone's APNs payload. A subscription with no matching entry gets no notification. Each APNs payload is about 500 bytes, well within Apple's 4 KB limit, whatever the number of phones.
- The relay never stores ciphertext in D1, and never logs it. A queued delivery holds it until it is sent, or for at most the queue's retention after failed retries.
- **The relay no longer writes any text.** The visible alert, shown only if the extension fails, uses `loc-key`, which iOS resolves from the app's own strings in the phone's language. So the relay **drops the workspace name and the phone's language** from its data. It keeps only opaque IDs, the event type, and the push token.

### On the phone

- A new NSE target, added by an Expo config plugin at prebuild ([ADR-0012](0012-native-builds-without-eas.md)). It reads `oc.c`, finds the key by `subscriptionId`, decrypts, checks the associated data, and sets the title to `title` and the body to `sender: text`.
- On any failure, or near the NSE's time limit, iOS shows the `loc-key` fallback, such as "New message", with no workspace name.
- iOS's own "Show Previews" setting (Always, When Unlocked, Never) still applies on the lock screen. It is how each person hides message text.
- **Internal notes** are shown only to members, who can read them anyway. Visitor-facing code is unchanged (rule 4).

### Removed

- The relay's notification text templates and its per-phone language.
- The workspace name in relay registration, in the relay's `workspaces` table, and in its APNs payloads.
- Any setting to choose between plain and encrypted notifications, for admins or members.
- Protocol negotiation for this feature. Relay, installation and app ship together at launch.

Existing development data is not migrated. Relay and installation subscriptions without a key are deleted, and test phones register again.

## Consequences

- The relay operator, and anyone who breaches the relay, sees only fixed-size ciphertext, opaque IDs, the event type, and when it was sent. Rule 10 becomes: "The relay never receives readable content. The only content it carries is per-phone ciphertext it cannot decrypt."
- The relay holds less personal data than before: no workspace names and no languages.
- **Apple's push service carries the ciphertext**, as it carries every payload. Apple cannot read it either.
- The text exists in clear on the phone, as it already does in the app.
- Message text appears in notifications for everyone, by default, subject to iOS's "Show Previews" setting. The privacy policy and the operator documentation say so, so that each installation's operator, the controller, can tell their team.
- A malicious installation can show arbitrary text to people who connected to it. ADR-0005 prevented that, but those people already trust that installation with their conversations. It still cannot reach anyone else.
- If the NSE is broken in a release, every notification shows only the fallback. The live phone test covers it before each release.
- The privacy policy, the data processing agreement, and the relay protocol are updated before release, to say that the relay carries encrypted notifications it cannot read.
- New work, in roughly this order:
  1. HPKE in `notification-protocol`, with the RFC test vectors.
  2. The relay: required `payloads`, `loc-key` alerts, and dropping workspace names, languages and the text templates.
  3. The installation: required `previewKey`, and encryption.
  4. The app: key handling and the NSE config plugin.
  5. A live test on a phone.

## Alternatives considered

- **Plain text through the relay.** Simplest. It makes Orango Labs a recipient of every customer's message content, and contradicts the trust model. Rejected.
- **Encryption as an option, with fixed text as the default.** Keeps two paths in every component, and most teams would never find the setting. Not needed before launch. Rejected.
- **A per-installation key shared by all phones.** Simpler key management. But one phone's leak exposes every other phone's notifications, and a removed member's phone could still decrypt. Rejected.
- **The phone fetches the text from the installation in the NSE**, with a short-lived token. Nothing passes through the relay. But the NSE then needs network access, and a session token stored where the extension can read it. Its timeout is short, so notifications would often fall back on poor networks. Kept as a fallback if HPKE proves impractical.
- **Silent notification, then a local one.** iOS throttles background pushes and gives no delivery guarantee. Rejected.
