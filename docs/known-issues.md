# Known issues

What does not work yet, what has not been tested, and what still needs a decision, as of release 0.2.1 and the work after it. OpenChat is before 1.0. Each item links to where it is recorded in more detail.

To report a new problem, [open an issue](https://github.com/yatping/OpenChat/issues/new). For a vulnerability, follow [SECURITY.md](../SECURITY.md) instead.

## Before you rely on it

- **No independent security review yet.** Two internal reviews were done ([M1a](architecture/security-review-m1a.md), [M1b](architecture/security-review-m1b.md)). An external one is planned before general release.
- **The self-hosting guide has been followed only by its author.** Its Cloudflare steps were run from a fresh clone on real Cloudflare, but nobody else has followed it end to end ([M5 exit check](plan/milestones.md#m5-exit-check)).
- **Legal texts are drafts.** The managed relay's terms and privacy policy, and the good-faith clause in [SECURITY.md](../SECURITY.md), await legal review ([drafts](legal/README.md)).

## The iPhone app and push

- **The app and the relay are not open source** ([ADR-0019](architecture/decisions/0019-app-and-relay-leave-open-source.md)). A self-hoster uses the official app with the project's relay, and can no longer build a branded app or run their own relay from this repository.
- **The official app is not on the App Store.** Until it is, teams use the dashboard, and get no push notifications. Builds go to TestFlight for testing.
- **The project's relay is open to any installation that proves control of its domain**, within [limits](notification-relay/protocol.md#rate-limits). Its terms and privacy policy are drafts awaiting legal review ([drafts](legal/README.md)).
- **Tested on one iPhone.** Several devices, a token change, and signing out while offline were not tried on real phones ([M2](plan/milestones.md#m2-exit-check), [M3](plan/milestones.md#m3-exit-check)).
- **Push text is in English.** There are no notifications for a transfer as such (it arrives as an assignment), or for other changes to a conversation.
- **A phone stays subscribed while any of its sessions lasts**, so ending one session does not stop that phone's notifications.
- **Not built:** rotating an installation's relay signing key, and alerts on failed deliveries.
- **The app holds one installation at a time** ([ADR-0014](architecture/decisions/0014-one-installation-in-the-app.md)). To use a second installation, you sign out of the first, and notifications from the first stop. The original brief asked for both at once ([M6 exit check](plan/milestones.md#m6-exit-check)).

## The widget

- **One conversation per visitor.** The widget shows one, though the API allows more.
- **"We are online" counts open dashboards and app screens only.** An agent who answers from a notification shows as away until the app is open, and an open widget does not see the change until it loads again ([realtime](architecture/realtime.md)).
- **"Before the first message" email is enforced only by the widget**, not by the API.
- **Translations have not been reviewed by native speakers** in the widget, the dashboard or the app ([widget](architecture/widget.md#languages), [dashboard](architecture/dashboard.md#languages)). Right-to-left languages, such as Arabic and Hebrew, are not supported.
- **No screen-reader user has reviewed it.** It passes automated checks and was checked by hand ([accessibility](architecture/accessibility.md)).
- **Its focus ring uses the website's colour**, so a very light colour can make it hard to see on a light page.
- **Tested in Chromium only** on real Cloudflare.

## The inbox and dashboard

- **No contact list, and no merging of contacts.** A visitor who writes from two browsers is two contacts.
- **No search.** Planned with M7.
- **Server messages stay in English** in the dashboard, such as errors, though its own words are in eleven languages ([languages](architecture/dashboard.md#languages)).
- **A visitor's read position is not shown**, though it is recorded.
- **No canned responses.**

## Email

- **Two uses only:** follow-ups to visitors, and account emails to colleagues. No alerts to members, transcripts, or summaries ([M4](plan/milestones.md#m4-exit-check)).
- **One fixed follow-up template**, which cannot be edited per workspace.
- **A new rule, or a shorter wait, applies to a conversation only after its next public message.**
- **Gmail did not show its own Unsubscribe button.** The link in the email works.
- **Bounces and complaints are not received from the provider.** Cloudflare refuses those addresses itself, but they do not appear in **Addresses not to email**.
- **Rarely, an email can be sent twice, or not at all,** if a failure falls between sending and recording it. Cloudflare's email service documents no way to prevent this.

## Data and operations

- **Nothing caps total stored data** for a website, and there is no daily limit on files ([security review](architecture/security-review-m1b.md#gaps-to-close-later)).
- **A former colleague's name cannot be erased.** Accounts can be deactivated, and their messages keep their name.
- **A restore does not bring back files**, which are not in a backup, and **a contact erased after the restore point comes back**, so erase them again. Other limits apply ([backup and restore](operations/backup-and-restore.md#what-a-restore-does-not-put-back)).
- **Removing an installation does not empty its file bucket.** Wrangler cannot; empty it in the Cloudflare dashboard first.
- **About 5% of 1,000 open connections closed during a deploy** in the load test, and reconnected only when their clients retried. Messages were not lost ([M1b](plan/milestones.md#m1b-exit-check)).
- **The installation's release version is public**, in its discovery document, because the AGPL source offer needs it ([licensing](operations/licensing.md#the-source-offer)).
- **Whether the source offer must also appear in the widget** is for legal review.

## Throughput

Measured once, from one machine: about 45 messages a second with p95 latency under one second, and 1,000 connections reconnecting. What sets the ceiling is not known. Choose a database location near your team and visitors, because latency depends on it ([M1b](plan/milestones.md#m1b-exit-check)).
