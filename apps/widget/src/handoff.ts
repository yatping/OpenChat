/** What the loader gives the chat bundle. Both come from one deploy, but a page may mix them for a moment, so this only grows. */
export interface Handoff {
  websiteKey: string;
  apiUrl: string;
  shadow: ShadowRoot;
  host: HTMLElement;
  button: HTMLButtonElement;
  /** The loader's own nonce, for a host page that allows scripts that way. */
  nonce?: string;
  /** Hold everything in session storage until the host page says otherwise. */
  consentPending: boolean;
  /** The language the host page asked for, with data-locale or OpenChatConfig.locale. */
  locale?: string;
  /** The visitor clicked before the bundle arrived, or the host page called open(). */
  openOnStart: boolean;
  /** Set by the chat bundle. */
  chat?: { setOpen(open: boolean): void; grantConsent(): void };
}

export type HandoffScript = HTMLScriptElement & { openchat?: Handoff };

/** Not blocked by a host page's style-src, unlike a style element, which remains the fallback. */
export function addStyles(shadow: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Applied with the CSSOM, so a host page's CSP does not stop it, and only a validated colour gets there. */
export function applyColor(host: HTMLElement, color: unknown): void {
  if (typeof color !== 'string' || !HEX.test(color)) return;
  const channel = (start: number) => {
    const value = parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  host.style.setProperty('--oc-primary', color);
  // Whichever has the higher contrast with the customer's colour.
  host.style.setProperty('--oc-on-primary', luminance > 0.179 ? '#111827' : '#ffffff');
}

export const colorKey = (websiteKey: string) => `openchat:${websiteKey}:color`;
