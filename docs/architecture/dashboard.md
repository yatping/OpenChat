# The dashboard

The team inbox and its settings pages, in `apps/dashboard`: a React single-page app served by the API Worker. This page covers its languages. Its layout and colours are in the [design system](design-system.md), and what it does for accessibility in [accessibility](accessibility.md).

## Languages

The dashboard speaks the same languages as the [widget](widget.md#languages) and the iPhone app: English, Spanish, French, German, Italian, Portuguese, Dutch, Japanese, Korean, Simplified Chinese, and Traditional Chinese. It chooses:

1. The language picked in the dashboard, under the sign-in card or in the header. It is kept in this browser (`openchat.language` in local storage), not in the account.
2. The browser's languages, in order. Tags match as they do for the widget, so `zh-HK` is Traditional Chinese.
3. English.

Choosing a language reloads the page, so that everything changes at once. The page's `<html lang>` follows the choice, for screen readers. Dates and times use the language's format.

**Not translated:** what the server says, such as error messages and the names of audit actions it does not know; what people write, such as tag names, workspace names and messages; and email sent to visitors.

**The translations have not been reviewed by native speakers.** Corrections are welcome, in `apps/dashboard/src/i18n/`.

### How the strings work

- `en.ts` is the source. Every other language is typed as `Messages`, so a missing key fails the type check, and `i18n.test.ts` checks that each keeps the same `{placeholders}`.
- `t(key, values)` fills placeholders. A sentence with an element in it, such as a name or a time, uses `tNode`, so that each language puts the element where its grammar needs it.
- A message with a number has two keys, `…One` and `…Other`, and `tn(base, count)` chooses by `Intl.PluralRules`. Languages without a plural, such as Japanese, give the same text for both.
- Audit-log sentences are whole templates, such as `{actor} added {target}`, not pieces joined in English word order.

### Adding a language

Add it to the widget first ([how](widget.md#adding-a-language)), then to `LANGUAGES` in `apps/dashboard/src/i18n/locales.ts`, with a catalog beside `en.ts` and an entry in `CATALOGS`. The test fails until the dashboard and widget offer the same languages.
