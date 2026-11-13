# Records of processing: Orango Labs Ltd

> **DRAFT for legal review.** Kept under Article 30 of the UK GDPR and the EU GDPR. It is internal, but it may be published. Placeholders are in `[BRACKETS]`.

Organisation: Orango Labs Ltd, `[REGISTERED ADDRESS]`. Contact: `[PRIVACY EMAIL]`. `[EU REPRESENTATIVE]`. `[ICO REGISTRATION]`. No data protection officer appointed. **[CHECK]**

Last reviewed: `[EFFECTIVE DATE]`

## A. As processor (Article 30(2))

| | Managed notification relay |
|---|---|
| Controllers | Each organisation operating an OpenChat installation admitted to the relay. The list is the relay's `installations` table, and `pnpm ocp relay stats` gives the count |
| Categories of processing | Storing device registrations and subscriptions; delivering notifications through Apple's push service; recording delivery outcomes; erasing on request |
| Data | See [data processing agreement](data-processing-agreement.md#2-data-subjects-and-data) |
| Transfers | Cloudflare (global network, including the United States), Apple (United States). Mechanism: `[TRANSFER MECHANISM]` |
| Security | See [data processing agreement](data-processing-agreement.md#5-security-measures) |

## B. As controller (Article 30(1))

| Activity | Purpose and basis | Data subjects | Data | Recipients | Retention |
|---|---|---|---|---|---|
| Relay security and operations logs | Keeping the relay secure and working. Legitimate interests | Team members using the app; installation operators | Request metadata, which may include IP addresses; installation IDs; error codes. No content or tokens | Cloudflare | 7 days |
| Relay access requests | Deciding which installations may use the relay. Legitimate interests | People who ask for access | Name or handle, contact details, installation ID, anything they write | GitHub, if requested through an issue **[CHECK]** | Until access ends, plus `[PERIOD]` |
| Privacy and erasure requests | Meeting legal obligations | People making requests | Contact details, request content | `[EMAIL PROVIDER]` | `[PERIOD]` after the request is closed |

## Not processed by Orango Labs Ltd

- The contents of any OpenChat installation: conversations, contacts, visitors, accounts. Each installation's operator runs it on their own infrastructure, and is its controller.
- Any analytics or crash reports from the app. It contains neither.

## Erasure procedures

| Request | Action |
|---|---|
| An installation leaves | Its admin uses **Disconnect and erase**, or we run `pnpm ocp relay erase --env <env> --installation <id>`. Both erase at once |
| One person, through their organisation | The organisation removes them in OpenChat, and the installation deletes their subscriptions at the relay |
| One person, directly to us | We ask for their organisation's installation and identify the pseudonymous ID with that organisation, then erase their subscriptions. **[CHECK]** |
| Backups | Cloudflare D1 point-in-time history keeps erased rows for up to 30 days, then drops them. We do not restore erased data |
