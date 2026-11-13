# Legal documents for the managed relay

> **DRAFT. Not legal advice. Not in force.** A lawyer must review these before anything is published. The managed relay has been open to every installation since 2026-11-12, by the owner's decision, so this review is overdue. Nothing here makes OpenChat or Orango Labs Ltd GDPR-compliant on its own.

These cover the **managed relay** (`openchat-relay.orangolabs.com`) and the **official iOS app**, both run by Orango Labs Ltd. They do not cover a self-hosted installation. Whoever runs an installation is the controller of everything in it, and needs their own privacy notice for their visitors and team.

| Document | For | Status |
|---|---|---|
| [Privacy policy](privacy-policy.md) | People using the official app, and anyone whose data reaches the managed relay | Draft |
| [Relay terms](relay-terms.md) | Operators of installations that use the managed relay | Draft |
| [Data processing agreement](data-processing-agreement.md) | The same operators, under Article 28 GDPR | Draft |
| [Records of processing](records-of-processing.md) | Orango Labs Ltd internally, under Article 30 | Draft |
| [Subprocessors](subprocessors.md) | Published, and referenced by the agreement | Draft |

## Placeholders to fill

| Placeholder | Meaning |
|---|---|
| `[COMPANY NUMBER]` | Orango Labs Ltd's registration number |
| `[REGISTERED ADDRESS]` | Registered office |
| `[PRIVACY EMAIL]` | Where privacy and erasure requests go |
| `[GOVERNING LAW]` | For example, England and Wales |
| `[EU REPRESENTATIVE]` | An Article 27 representative, if the lawyer says one is needed |
| `[ICO REGISTRATION]` | UK data protection fee registration number, if required |
| `[EFFECTIVE DATE]` | When a version takes effect |
| `[TRANSFER MECHANISM]` | The legal basis for transfers outside the UK and EEA, for each subprocessor |
| `[LIABILITY CAP]` | The relay terms' cap on liability |
| `[PERIOD]` | Retention of access and privacy correspondence |
| `[EMAIL PROVIDER]` | Where `[PRIVACY EMAIL]` is hosted |

## Points for the lawyer

Each is marked **[CHECK]** where it appears.

1. **Roles.** These drafts treat each installation's operator as the controller of its team's relay data, and Orango Labs as their processor. For access requests, abuse handling and the relay's own security logs, Orango Labs is the controller. Confirm this split.
2. **Transfers.** Cloudflare runs the relay on its global network, and Apple's push service is in the United States. Confirm the transfer mechanism: the UK–US data bridge and EU–US Data Privacy Framework certifications, or standard contractual clauses and the UK addendum.
3. **Cloudflare logs.** Workers Logs are enabled on the relay and kept for 7 days. Cloudflare documents that an invocation log holds "details such as the Request, Response, and related metadata". It does not say whether that includes the client's IP address, so assume it may.
4. **D1 Time Travel.** Cloudflare keeps 30 days of point-in-time history for the relay's database. Erased rows can be restored from it until the 30 days pass. The drafts disclose this; confirm that the wording is adequate.
5. **Encrypted notifications.** These drafts describe notifications as [ADR-0017](../architecture/decisions/0017-encrypted-notifications.md) designs them: message text encrypted for each phone, which the relay carries but cannot read, and no plain-text option. It shipped on 2026-11-11. Confirm whether ciphertext the processor cannot decrypt counts as personal data in its hands, and how to describe it.
6. **Children.** The app is a business tool and not directed at children. Confirm whether an age statement is needed.

## How the documents match the code

Each claim about data, retention or erasure comes from the [relay protocol](../notification-relay/protocol.md#relay-data), its [erasure section](../notification-relay/protocol.md#6-erasure), and [Cloudflare validation](../architecture/cloudflare-validation.md). If the code changes, update these documents in the same change.
