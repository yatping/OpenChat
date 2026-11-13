/**
 * The embeddable loader. Deliberately has no dependencies: the budget is 5 KB gzipped. It draws the button,
 * then loads the chat bundle when the browser is idle or on the first click. It makes no API call, so a page
 * view costs the installation nothing until then. Contracts may be imported as types only.
 */
import { addStyles, applyColor, colorKey, type Handoff, type HandoffScript } from './handoff';
import { OPEN_LABEL, pageLanguages, pickLocale } from './locale';

declare global {
  interface Window {
    OpenChatConfig?: { websiteKey?: string; apiUrl?: string; consent?: 'pending'; locale?: string };
    OpenChat?: { open(): void; close(): void; grantConsent(): void };
  }
}

// The default colour is OpenChat's blue, from its icon. A website's own colour replaces it.
const CSS = `:host{all:initial;--oc-primary:#0a57f5;--oc-on-primary:#fff}
.oc-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;padding:0;border:0;border-radius:50%;background:var(--oc-primary);background-image:linear-gradient(135deg,rgba(255,255,255,.16),rgba(0,0,0,.1));color:var(--oc-on-primary);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(14,26,79,.3);font:600 12px/1 system-ui,sans-serif;transition:transform .2s ease}
.oc-launcher:hover{transform:scale(1.06)}
.oc-launcher:focus-visible{outline:3px solid var(--oc-primary);outline-offset:3px}
.oc-launcher svg{position:absolute;width:28px;height:28px;fill:currentColor;transition:transform .2s ease,opacity .2s ease}
.oc-launcher .oc-shut,.oc-launcher[aria-expanded=true] .oc-chat{opacity:0;transform:rotate(-45deg) scale(.6)}
.oc-launcher[aria-expanded=true] .oc-shut{opacity:1;transform:none}
.oc-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;border:2px solid #fff;background:#d92d20;color:#fff;display:flex;align-items:center;justify-content:center}
.oc-badge[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.oc-launcher,.oc-launcher svg{transition:none}.oc-launcher:hover{transform:none}}`;

const ICON =
  '<svg class="oc-chat" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.9 3 3 6.5 3 10.9c0 2.3 1.1 4.4 2.9 5.9L5 21l4.6-2.3c.8.2 1.6.3 2.4.3 5.1 0 9-3.5 9-8.1S17.1 3 12 3zm-4 9.3a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6zm4 0a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z"/></svg>' +
  '<svg class="oc-shut" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.7 9.3a1 1 0 0 1 1.4 0L12 13.2l3.9-3.9a1 1 0 1 1 1.4 1.4l-4.6 4.6a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4z"/></svg>';
const IDLE_FALLBACK_MS = 2500;

function start(script: HTMLScriptElement | null, websiteKey: string, apiUrl: string, chatUrl: string, consentPending: boolean, locale: string | undefined): void {
  const host = document.createElement('div');
  host.id = 'openchat-widget';
  // Beats any rule on the page, including one that hides every div. It has no box of its own, and custom properties are not reset.
  host.style.setProperty('all', 'initial', 'important');
  // Shadow DOM isolates styles in both directions.
  const shadow = host.attachShadow({ mode: 'open' });
  addStyles(shadow, CSS);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'oc-launcher';
  // The chat bundle may change the language once it knows the website's setting.
  const language = pickLocale([locale, ...pageLanguages()]);
  button.setAttribute('aria-label', OPEN_LABEL[language]);
  button.lang = language;
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = `${ICON}<span class="oc-badge" hidden></span>`;
  shadow.appendChild(button);

  const handoff: Handoff = { websiteKey, apiUrl, shadow, host, button, consentPending, openOnStart: false, ...(locale ? { locale } : {}), ...(script?.nonce ? { nonce: script.nonce } : {}) };
  if (!consentPending) {
    try {
      applyColor(host, localStorage.getItem(colorKey(websiteKey)));
    } catch {
      // Storage can be refused. The default colour is fine until the chat bundle knows better.
    }
  }

  let loading = false;
  const load = () => {
    if (loading || handoff.chat) return;
    loading = true;
    const tag = document.createElement('script') as HandoffScript;
    tag.src = chatUrl;
    tag.async = true;
    // A host page with a nonce-based CSP allowed the loader that way, and it may only allow this the same way.
    if (script?.nonce) tag.nonce = script.nonce;
    tag.openchat = handoff;
    tag.onerror = () => {
      // The next click tries again.
      loading = false;
      tag.remove();
    };
    document.head.appendChild(tag);
  };
  const setOpen = (open: boolean) => {
    if (handoff.chat) handoff.chat.setOpen(open);
    else {
      handoff.openOnStart = open;
      if (open) load();
    }
  };

  button.addEventListener('click', () => {
    if (!handoff.chat) setOpen(true);
  });
  window.OpenChat = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    grantConsent() {
      handoff.consentPending = false;
      handoff.chat?.grantConsent();
    },
  };

  document.body.appendChild(host);
  const idle = window.requestIdleCallback;
  if (idle) idle(load, { timeout: IDLE_FALLBACK_MS });
  else setTimeout(load, IDLE_FALLBACK_MS);
}

(() => {
  // Read while this script is still the one running.
  const script = document.currentScript as HTMLScriptElement | null;
  const config = window.OpenChatConfig ?? {};
  const websiteKey = script?.dataset.websiteKey ?? config.websiteKey;
  // Published next to its API. A page can also name both, for local development.
  const source = script?.src || undefined;
  if (!websiteKey || !source || document.getElementById('openchat-widget')) return;
  const apiUrl = config.apiUrl ?? new URL(source).origin;
  const chatUrl = new URL('chat.js', source).href;
  const consentPending = (script?.dataset.consent ?? config.consent) === 'pending';
  // For a page that knows its visitor's language better than the browser does.
  const locale = script?.dataset.locale ?? config.locale;
  const begin = () => start(script, websiteKey, apiUrl, chatUrl, consentPending, locale);
  if (document.body) begin();
  else document.addEventListener('DOMContentLoaded', begin, { once: true });
})();
