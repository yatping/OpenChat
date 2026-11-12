# Accessibility

The widget and the dashboard aim for **WCAG 2.2 level AA**. This page says how that is checked, what was checked by hand, and what is still open.

## Automated checks

[`tooling/e2e/tests/accessibility.spec.ts`](../../tooling/e2e/tests/accessibility.spec.ts) runs in CI with the other end-to-end tests ([ADR-0018](decisions/0018-axe-core-for-accessibility-tests.md)).

- **axe-core**, with the WCAG 2.0, 2.1 and 2.2 A and AA rules, in light and dark mode, on:
  - the sign-in and forgot-password pages;
  - the inbox with a conversation open, and the websites, members and email sections;
  - the People, Workspaces, Failed jobs and Audit log pages;
  - the widget, plain and styled with a customer colour and a pre-chat email form, with the launcher closed and the panel open. The scan waits for the panel's fade-in to finish, because contrast measured mid-animation is wrong.
- **Reflow** (WCAG 1.4.10): every dashboard screen fits 320 CSS pixels, which is 1280 at 400% zoom, without scrolling sideways.

Any violation fails the test. Automated rules find roughly a third of real problems, so a passing run is a floor, not a verdict.

## Checked by hand

Done on 2026-11-12, in Chromium, with the keyboard and by reading the markup.

| Check | Widget | Dashboard |
|---|---|---|
| Everything works from the keyboard | Tab reaches the launcher after the page's own links. Enter opens the panel and puts focus in the message box. Escape closes it and returns focus to the launcher. | Every control is a native button, link, select or field, in reading order. |
| Focus is visible | A 2-pixel outline on every control. | Every tab stop shows an outline or ring, in both themes. |
| Scrollable areas take focus | The message log does, so it scrolls with the arrow keys. | The installation snippet on the Workspaces page does. |
| New content is announced | The message log is `role="log"`. Typing is a polite live region. Errors are `role="alert"`. | The message list is a polite live region. Typing is a polite live region. Errors are `role="alert"`, and loading is `role="status"`. |
| Landmarks | The panel is a dialog named "Chat". | A header with a "Sections" and an "Administration" navigation, and one `main`. |
| Language | The panel's `lang` is the language it speaks ([languages](widget.md#languages)), not the host page's. | `lang="en"`. |
| Motion | The only animation, the panel's fade-in, runs only without `prefers-reduced-motion`. | No animation. |
| Colour | Text on the customer's colour is black or white, whichever contrasts more. | Contrast is covered by axe in both themes. |

## Fixed in the accessibility pass

- The dashboard had no `main` landmark, and its admin buttons were not in a navigation landmark.
- A select wider than the screen, the widget-language picker, made the Workspaces page scroll sideways on a phone. Every form field is now capped at the width of its container.
- The installation snippet scrolled sideways but could not be reached by keyboard.
- New messages in the dashboard were not announced to a screen reader.

## Not done yet

- **No screen-reader user has reviewed either surface.** The announcements above were checked in the markup, not listened to in VoiceOver or NVDA.
- **The widget's focus outline uses the customer's colour.** A pale colour on the white panel can fall below the 3:1 contrast that WCAG 1.4.11 asks of a focus indicator. axe does not check focus indicators.
- **Loading earlier messages** adds them to the live region, so a screen reader may read them out. That is how `role="log"` behaves, and it is the same in both surfaces.
- **The dashboard is in English only.** The widget speaks [eleven languages](widget.md#languages), not yet reviewed by native speakers.
- **The iOS app** was not part of this pass. It has had no VoiceOver review.
