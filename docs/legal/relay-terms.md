# Terms of use: OpenChat managed relay

> **DRAFT for legal review. Not in force.** Placeholders are in `[BRACKETS]`. Points for the lawyer are marked **[CHECK]**.

Effective: `[EFFECTIVE DATE]`

These terms are between Orango Labs Ltd, company number `[COMPANY NUMBER]`, registered at `[REGISTERED ADDRESS]` ("we"), and the organisation that operates an OpenChat installation and connects it to the relay at `openchat-relay.orangolabs.com` ("you").

## 1. The service

The relay sends push notifications from your OpenChat installation to the official OpenChat iOS app. It works only with that app. For your own app, run your own relay. The open-source code includes one.

The relay is offered free of charge, as is, with no service level. Notifications are a convenience: messages always reach the app when it is open, whether or not the relay is working.

## 2. Access

For now, we admit installations one at a time, on request. We may refuse a request, or end access, at our discretion. Where we can, we will give notice and a reason. **[CHECK]**

## 3. Your responsibilities

You will:
- use the relay only to notify your own team members about your own OpenChat conversations;
- keep your installation's signing key secret, and tell us promptly if it is exposed;
- give your team the privacy information the law requires, including that notifications pass through the relay;
- not try to send content, personal data or anything other than what the [relay protocol](../notification-relay/protocol.md) defines. The relay refuses unknown fields;
- not overload, probe or disrupt the relay, or try to reach another installation's data.

## 4. Data protection

You are the controller of the personal data your installation and your team's phones send to the relay. We process it as your processor under the [data processing agreement](data-processing-agreement.md), which forms part of these terms. The [privacy policy](privacy-policy.md) describes what the relay holds and for how long.

## 5. Limits and suspension

The relay applies rate limits per installation and per recipient. We may change them to protect the service. We may suspend an installation immediately if it threatens the relay's security, its availability for others, or Apple's terms for push notifications.

## 6. Leaving

You may stop at any time. As an installation admin, in your dashboard choose **Workspaces**, **Push notifications**, **Disconnect and erase**. The relay then erases everything it holds about your installation straight away. If you cannot do that, email `[PRIVACY EMAIL]` and we will erase it for you. If we end your access, we erase your data within 30 days. **[CHECK]**

## 7. Liability

To the extent the law allows, we are not liable for indirect or consequential loss, or for notifications that are lost or delayed. Our total liability under these terms is limited to `[LIABILITY CAP]`. Nothing here limits liability that cannot be limited by law. **[CHECK]**

## 8. Changes

We may change these terms, with at least 30 days' notice of a material change, by email to the contact you gave when requesting access. If you do not agree, you may disconnect before the change takes effect.

## 9. Law

These terms are governed by the law of `[GOVERNING LAW]`, and its courts have exclusive jurisdiction.
