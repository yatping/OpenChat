# Data processing agreement: OpenChat managed relay

> **DRAFT for legal review. Not in force.** Placeholders are in `[BRACKETS]`. Points for the lawyer are marked **[CHECK]**.

This agreement forms part of the [relay terms](relay-terms.md). It is between the organisation operating an OpenChat installation (the "controller") and Orango Labs Ltd, company number `[COMPANY NUMBER]`, registered at `[REGISTERED ADDRESS]` (the "processor"). It meets Article 28 of the UK GDPR and the EU GDPR. **[CHECK]**

## 1. Subject, duration, nature and purpose

| | |
|---|---|
| Subject | Delivering push notifications from the controller's OpenChat installation to its team members' phones, through the official OpenChat app |
| Duration | While the controller's installation is registered with the relay, then until erasure under section 9 |
| Nature | Storing, using to deliver, and erasing the data below. Sending each notification to Apple's push service |
| Purpose | Only to deliver notifications, and to keep the relay secure |

## 2. Data subjects and data

| Data subjects | Data |
|---|---|
| The controller's team members who allow notifications in the app | Push token (encrypted), a device ID and hashed secret, app bundle ID, push environment, and the controller's pseudonymous ID for the member |
| The same, through their activity | Per notification: an ID, the event type, a conversation ID, and the delivery outcome |
| Team members, and the visitors and contacts they talk to | Encrypted notifications: the workspace name, sender name and up to 150 characters of message text, encrypted by the controller's installation for each phone. The processor cannot decrypt them, never stores them, and passes them only to Apple |

No special category data is intended, though the controller cannot rule it out in message text. No readable message content: the processor holds no key that can decrypt a notification. The relay's request formats are closed, and it refuses unknown fields. **[CHECK]** whether encrypted data the processor cannot decrypt is personal data in its hands.

## 3. The processor's obligations

The processor will:

1. process the data only on the controller's documented instructions. These terms, and the controller's use of the relay through OpenChat, are those instructions. If an instruction seems to break data protection law, the processor will say so;
2. ensure that anyone authorised to process the data is bound by confidentiality;
3. take the measures in section 5;
4. use subprocessors only under section 6;
5. help the controller, as far as possible, to answer data subjects' requests. Section 8 covers erasure;
6. help the controller meet its obligations on security, breach notification, impact assessments and prior consultation, considering what the processor knows;
7. at the end, delete the data under section 9;
8. make available the information needed to show compliance, and allow audits under section 10.

## 4. International transfers

The processor and its subprocessors may process the data outside the UK and EEA, including in the United States. Such transfers rely on `[TRANSFER MECHANISM]`. **[CHECK]**

## 5. Security measures

- Push tokens encrypted at rest with AES-256-GCM under a key held only as a deployment secret.
- Device secrets stored only as hashes.
- Every installation request signed with Ed25519, with replay protection and timestamps.
- Every query scoped to one installation. No installation can read another's data.
- Rate limits per installation and per recipient.
- Notifications encrypted end to end, from the installation to each phone, with HPKE (RFC 9180). Keys are made on the phone and never reach the processor. Ciphertext is padded to a fixed size and is never stored or logged.
- Access to the deployment limited to the processor's authorised operators, with multi-factor authentication. **[CHECK]**
- Notification records deleted after 30 days. Devices with no subscription deleted after 7 days.

## 6. Subprocessors

The controller authorises the subprocessors listed in [Subprocessors](subprocessors.md). The processor will give at least 30 days' notice of a new subprocessor, by updating that list and emailing the controller's contact. The controller may object on reasonable data protection grounds. If the objection cannot be resolved, the controller may disconnect. The processor imposes data protection obligations on each subprocessor equivalent to these, and remains liable for them. **[CHECK]**

## 7. Personal data breaches

The processor will notify the controller without undue delay, and in any case within 48 hours, of becoming aware of a breach affecting the controller's data. It will give the information it has about the breach, its likely effects, and the measures taken. **[CHECK]**

## 8. Data subjects' requests

| Request | How |
|---|---|
| Erasure of one person | The controller removes the member, or revokes their sessions, in OpenChat. The installation then tells the relay to delete that member's subscriptions |
| Erasure of one phone | The person signs out of the app. That removes the phone's subscriptions, and the phone's record is deleted after 7 days |
| Access | The controller holds the pseudonymous ID and can ask the processor at `[PRIVACY EMAIL]` for what the relay holds about it |

## 9. Deletion at the end

The controller ends processing with **Disconnect and erase** in its dashboard. The relay then deletes, at once, the installation, its key, workspaces, subscriptions and notification records, and every device left with no subscription. The processor can do the same on request, with its relay operator tooling. Deleted data remains in the hosting provider's point-in-time recovery history for up to 30 days, and is then gone. The processor keeps no other copy. **[CHECK]**

## 10. Audits

The processor will answer reasonable written questions about its compliance. The relay's source code is public, so the controller can inspect what it does. Any on-site audit needs 30 days' notice, takes place in business hours, and is at the controller's cost. **[CHECK]**

## 11. Precedence

If this agreement and the relay terms conflict on data protection, this agreement prevails.
