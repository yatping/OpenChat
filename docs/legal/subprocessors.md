# Subprocessors: OpenChat managed relay

> **DRAFT for legal review.** Referenced by the [data processing agreement](data-processing-agreement.md#6-subprocessors).

Last updated: `[EFFECTIVE DATE]`

| Subprocessor | What it does | Data | Location | Transfer basis |
|---|---|---|---|---|
| Cloudflare, Inc. | Hosts the relay: Workers, D1 database, Queues, Durable Objects, and logs | Everything the relay holds. See the [privacy policy](privacy-policy.md#what-reaches-us-and-why) | Global network, including the United States | `[TRANSFER MECHANISM]` **[CHECK]** |
| Apple Inc. | Apple Push Notification service, which delivers each notification to the phone | The push token, the encrypted notification, a fixed fallback phrase key, and opaque IDs in the payload. Apple cannot decrypt the notification | United States | `[TRANSFER MECHANISM]` **[CHECK]** |

Apple is used because it is the only way to send a notification to an iPhone app.

We will update this page, and email operators of connected installations, at least 30 days before adding or replacing a subprocessor.
