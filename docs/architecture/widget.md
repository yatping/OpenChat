# Website widget

The widget is two files, both served by the installation:

- `widget.js`, the loader. It has no dependencies and must stay under 5 KB gzipped. It draws the button and makes no API call.
- `chat.js`, the panel, in Preact, under 40 KB gzipped. It loads when the browser is idle, or on the first click.

Both live in a Shadow DOM, so the host page's styles cannot reach them and theirs cannot leak out. `tooling/scripts/check-budget.mjs` enforces the size limits in CI.

## Embedding

```html
<script src="https://<installation>/widget/widget.js" data-website-key="wk_…" async></script>
```

| Attribute | `window.OpenChatConfig` | What it does |
|---|---|---|
| `data-website-key` | `websiteKey` | Which website this is. Required. The page's origin must be in the website's allowed origins |
| `data-consent="pending"` | `consent: 'pending'` | Keeps everything in `sessionStorage` until the page calls `window.OpenChat.grantConsent()`. See [security](security.md#visitor-authentication) |
| `data-locale` | `locale` | The widget's language, such as `fr` or `zh-Hant`. See [Languages](#languages) |
| | `apiUrl` | The API, if not where `widget.js` came from. For local development |

`window.OpenChat` also has `open()` and `close()`.

## Languages

The widget speaks English, Spanish, French, German, Italian, Portuguese, Dutch, Japanese, Korean, Simplified Chinese, and Traditional Chinese. It chooses the first of these that it speaks:

1. `data-locale` on the script tag, or `OpenChatConfig.locale`. A site in several languages sets it per page.
2. The website's **Widget language** setting, under Workspaces, unless it is Automatic.
3. The page's `<html lang>`.
4. The visitor's browser languages, in order.
5. English.

A tag matches by its language, so `pt-BR` is Portuguese and `de-AT` German. Chinese is Traditional for `zh-Hant`, `zh-TW`, `zh-HK`, and `zh-MO`, and Simplified otherwise. The panel and the button carry a `lang` attribute, so that screen readers pronounce them correctly. File sizes use the language's number format and units.

The button's label is chosen by the loader, before the website's setting is known, from steps 1, 3, and 4. The chat bundle corrects it once the setting arrives.

**Not translated:** the welcome message, which is shown as the site owner wrote it, and agents' replies. Follow-up emails are in English. The dashboard has [its own language choice](dashboard.md#languages).

**Right-to-left languages,** such as Arabic and Hebrew, are not supported yet. They need the panel's layout mirrored as well as its strings.

**The translations have not been reviewed by native speakers.** They were written with care and are checked for completeness by `apps/widget/src/locale.test.ts`, which also keeps the list in step with the API's `language` setting. Corrections are welcome: change `apps/widget/src/strings.ts`, where English is the source and every language must have every key.

### Adding a language

1. Add it to `LOCALES` and `OPEN_LABEL` in `apps/widget/src/locale.ts`, and its strings to `apps/widget/src/strings.ts`.
2. Add it to the `language` enum in `WidgetSettingsSchema`, run `pnpm contracts:generate`, and add it to the dashboard's `WIDGET_LANGUAGES`.
3. Check the bundle budget with `pnpm verify`.
