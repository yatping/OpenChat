# ADR-0018: Check accessibility in end-to-end tests with axe-core

**Status:** Accepted, 2026-11-12

## Context

Milestone 6 includes an accessibility pass on the widget and the dashboard, and REQUIREMENTS.md lists accessibility as a requirement. The target is WCAG 2.2 level AA.

A one-off manual pass does not stop the next change from breaking contrast, labels or landmarks. Writing those rules by hand in Playwright would mean reimplementing a rules engine, and doing it worse.

axe-core is the engine that browser accessibility tools and most test suites use. `@axe-core/playwright` runs it on a Playwright page, including inside the widget's shadow root. Neither is on the [agreed technology list](../overview.md#technology-baseline), so adding them needs this ADR.

## Decision

- `tooling/e2e` adds `@axe-core/playwright` as a **development dependency only**, pinned to an exact version (4.14.0). It brings in `axe-core` of the same version.
- `tooling/e2e/tests/accessibility.spec.ts` runs axe with the WCAG 2.0, 2.1 and 2.2 A and AA rule tags on every dashboard screen and on the widget, closed and open, in light and dark mode. Any violation fails the test, so it fails CI.
- The same file checks reflow (WCAG 1.4.10): every dashboard screen fits 320 CSS pixels without scrolling sideways.
- What axe cannot judge is checked by hand and recorded in [accessibility.md](../accessibility.md).

## Consequences

- Both packages are licensed MPL-2.0. They run only in tests and are never bundled into the widget, the dashboard, the app or a Worker, so nothing OpenChat ships carries them, and [ADR-0011](0011-license-boundaries.md) is unaffected.
- Automated rules find roughly a third of real accessibility problems. A green test does not mean a screen is accessible; the manual checks still matter.
- A future axe release may add rules that fail existing screens. Upgrades are deliberate, through the pinned version.
- The technology baseline gains a row for accessibility tests.
