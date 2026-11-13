# The website widget

For whoever looks after the website. The widget is the chat button visitors use. An installation admin creates the website in OpenChat and gives you its snippet; see [administration](admin.md#websites).

## Adding it to a site

Paste the snippet just before `</body>`, on every page that should have the button:

```html
<script src="https://chat.company.com/widget/widget.js" data-website-key="wk_..." async></script>
```

The page's address must be in the website's **allowed origins** in OpenChat, exactly, such as `https://www.company.com`. A staging site needs its own entry. The website key is not secret: it only lets a visitor start a chat, and only on those origins.

The button appears in the bottom right corner. It is small, at about 2 KB, and the chat panel loads only when the browser is idle or someone clicks. Neither can be restyled by the page's CSS, and neither changes the page's styles.

### Sites with a content security policy

Allow your installation's address for `script-src` and `connect-src`. If the website requires Turnstile, also allow `https://challenges.cloudflare.com` for `script-src` and `frame-src`. A `nonce` on the script tag is passed on to the panel, and no `style-src` change is needed.

## Options

On the script tag, or in `window.OpenChatConfig` before it:

| Attribute | `OpenChatConfig` | What it does |
|---|---|---|
| `data-website-key` | `websiteKey` | Required |
| `data-locale` | `locale` | The widget's language, such as `fr` or `zh-Hant`. For a site in several languages, set it on each page |
| `data-consent="pending"` | `consent: 'pending'` | Stores nothing that outlives the browser tab until the page calls `window.OpenChat.grantConsent()`. For sites that ask for consent first |

The page can also call `window.OpenChat.open()` and `window.OpenChat.close()`, for example from a "Chat with us" link.

## Languages

The widget speaks English, Spanish, French, German, Italian, Portuguese, Dutch, Japanese, Korean, and Simplified and Traditional Chinese. It uses, in order: `data-locale`, the website's **Widget language** setting, the page's `<html lang>`, the visitor's browser languages, then English.

Your welcome message, and your team's replies, are shown as written. The translations have not yet been checked by native speakers, and right-to-left languages are not supported; see [known issues](../known-issues.md).

## What visitors see

- A button, and a panel with your welcome message.
- One conversation per visitor in that browser. They come back to it on their next visit, unless `data-consent="pending"` was never granted.
- Your team's replies, as they are written, and whether someone is typing. Names only if the website shows them. Never internal notes.
- If the website asks for an email, a field for it, and a box to allow follow-up emails, unticked.
- Files they attach, up to 25 MB, of the types the [inbox](inbox.md#answering) accepts.

A visitor's history is tied to their browser, not their email address. Someone who types a customer's address does not see that customer's conversations.

## Privacy on your site

The widget stores a visitor's chat session in the browser's local storage, or only for the tab's lifetime with `data-consent="pending"`. It sets no cookies and loads nothing from third parties, except Cloudflare Turnstile for websites that require it. Mention it in your site's privacy notice; see [privacy and data](privacy.md).
