# Open questions

Decisions for the project owner. Each has a recommended default so work is not blocked unnecessarily. Update this file when one is answered, and record significant answers in an ADR.

## Needed before Milestone 3 (managed relay)

**Owner's answers, 2026-11-05:** Q5: Orango Labs Ltd runs the managed relay, free with quotas, and terms and a privacy policy need legal review before public launch. Q7: generic text, as recommended. Q8: decide at App Store submission, which does not block Milestone 3.

| # | Question | Why it matters | Recommendation |
|---|---|---|---|
| Q5 | **Who operates the managed relay, who pays, and what are the terms?** | The operator holds the Apple signing identity, device tokens, and abuse duties, and may be a data processor under GDPR. Spec §1 forbids a mandatory subscription. | A named legal entity runs it free with quotas, under published terms and a privacy policy. Cost should be small, since a Workers Paid account covers it at low volume, but measure it. |
| Q7 | **Default push text: generic, or with some content?** | The spec prefers no content. A Notification Service Extension could fetch and show real text on the device, but needs native code and shared credentials. | Generic text with the workspace name for the MVP. The extension is post-MVP and needs a security review. |
| Q8 | **Who keeps the App Review demo installation running?** | Guideline 2.1 requires a live backend and demo account. | The relay's operator hosts a small demo installation with seeded data that resets nightly. |

## Needed before the relevant milestone

| # | Question | Needed by | Recommendation |
|---|---|---|---|
| Q9 | **MVP scope:** are teams, canned responses, and business-hour schedules in or out? §2.2 and §17 disagree. | M1 | Out, as in Phase 6. The inbox's "assigned to team" view is omitted until then. **M1a proceeds on this default.** |
| Q10 | **Are EU data residency guarantees required?** A D1 location hint is not a compliance guarantee. | M1, because jurisdiction choices are hard to change after data exists | Document as not guaranteed for the MVP. Investigate D1, R2, and Durable Object jurisdiction options before making any claim. |
| Q11 | **Who may create workspaces in an installation?** | M1 | Invite-only by default, with the first owner created by the CLI. Open signup is a setting. Implemented in M1a with this default. **Replaced by [ADR-0016](decisions/0016-installation-admin-replaces-workspace-managers.md): only an installation admin creates workspaces, and there is no signup.** |
| Q12 | **Which consent model for follow-up emails?** The spec requires consent but not its wording, default, or jurisdiction. | M4 | An explicit, unticked checkbox in the widget, stored with timestamp and source. Customers remain responsible for their legal basis. Legal review advised. |
| Q13 | **Which email drivers ship first?** **Cloudflare Email Sending only, decided by the owner on 2026-11-05.** | M1 (system email) | Everything stays on Cloudflare. It is in beta, needs Workers Paid and a domain on Cloudflare DNS, and documents no idempotency key, so a retry after a lost answer could send twice. The email provider interface stays, and so does the Resend code, which is unused, not offered as a choice, and not supported. |
| Q14 | **How long must the official app support old installations?** | M2 | Support API versions from the last 12 months. Installations outside this see an upgrade prompt. |
| Q15 | **Android?** The spec is iOS-only. | No schedule impact | Out of scope. The protocol reserves `platform`, and Expo keeps the option open. |

## Answered

| # | Question | Answer (2026-11-03) |
|---|---|---|
| Q1 | Product name | **OpenChat.** Package scope `@openchat/*`. Several unrelated projects use this name, the `openchat` GitHub account is taken, and no trademark search has been done, so one should happen before a public launch or App Store listing. |
| Q2 | Licence and contributions | The owner delegated this, with outside contributions required. **AGPL-3.0-or-later for server components, Apache-2.0 for clients, DCO for contributions.** See [ADR-0011](decisions/0011-license-boundaries.md). |
| Q3 | Workers Paid as the minimum | **Yes.** See [ADR-0009](decisions/0009-paid-plan-and-password-hashing.md). |
| Q4 | Accounts for spikes | Cloudflare: the owner's logged-in Wrangler session. Apple: not yet, so S7 waits for Milestone 2. |
| Q6 | No global app account | **Confirmed.** On mobile, a user enters the Worker URL or domain, then signs in with their account on that installation, such as a support agent's. See [ADR-0010](decisions/0010-no-global-mobile-account.md). |
