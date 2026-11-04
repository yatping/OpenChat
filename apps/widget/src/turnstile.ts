/**
 * Cloudflare Turnstile, only for a website that requires it, and only when a new visitor first writes. The script
 * loads then and not before, so no other visitor to the site ever contacts Cloudflare's challenge service.
 */
const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** Long enough to solve one by hand. Sends wait in line behind this, so it cannot be forever. */
const GIVE_UP_MS = 2 * 60_000;

export class ChallengeFailed extends Error {}

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function loadScript(nonce: string | undefined): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = SCRIPT;
    if (nonce) tag.nonce = nonce;
    tag.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new ChallengeFailed()));
    tag.onerror = () => {
      tag.remove();
      reject(new ChallengeFailed());
    };
    document.head.appendChild(tag);
  });
}

export function createChallenge(element: HTMLElement, nonce: string | undefined) {
  let siteKey: string | null = null;
  return {
    setSiteKey(key: string | undefined) {
      siteKey = key ?? null;
    },
    /** Null when this website does not ask for one. */
    async solve(): Promise<string | null> {
      if (!siteKey) return null;
      const key = siteKey;
      const turnstile = await loadScript(nonce);
      return new Promise<string>((resolve, reject) => {
        // Not a plain variable, because Turnstile could call back before render returns.
        const rendered: { id?: string } = {};
        const finish = (settle: () => void) => {
          clearTimeout(timer);
          if (rendered.id !== undefined) turnstile.remove(rendered.id);
          settle();
        };
        const fail = () => finish(() => reject(new ChallengeFailed()));
        const timer = setTimeout(fail, GIVE_UP_MS);
        rendered.id = turnstile.render(element, {
          sitekey: key,
          // Shows nothing unless Cloudflare needs the visitor to do something.
          appearance: 'interaction-only',
          callback: (token: string) => finish(() => resolve(token)),
          'error-callback': fail,
          'timeout-callback': fail,
        });
      });
    },
  };
}

export type Challenge = ReturnType<typeof createChallenge>;
