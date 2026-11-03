/**
 * The access token lives only in this module's memory. The refresh token is an HttpOnly cookie that scripts
 * cannot read. A refresh token presented twice revokes the session, so refreshes must never overlap: one
 * promise within this tab, and a Web Lock across tabs. See docs/architecture/security.md.
 */
export interface SessionDeps {
  fetch: typeof globalThis.fetch;
  /** Absent in browsers without Web Locks, where only this tab's refreshes are serialised. */
  locks?: Pick<LockManager, 'request'> | undefined;
}

const LOCK_NAME = 'openchat-refresh';
// Tokens are refreshed a little before they expire, so another tab's fresh token is not wasted.
const EXPIRY_MARGIN_MS = 30_000;

export function createSession(deps: SessionDeps) {
  let accessToken: string | null = null;
  let expiresAt = 0;
  let inFlight: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();

  const set = (token: string | null, expiry: number) => {
    const changed = (token === null) !== (accessToken === null);
    accessToken = token;
    expiresAt = expiry;
    if (changed) for (const listener of listeners) listener();
  };

  async function callRefresh(): Promise<boolean> {
    let response: Response;
    try {
      response = await deps.fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Offline is not signed out. The next request tries again.
      return false;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) set(null, 0);
      return false;
    }
    const body = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string };
    set(body.accessToken, Date.parse(body.accessTokenExpiresAt));
    return true;
  }

  function refresh(): Promise<boolean> {
    inFlight ??= (deps.locks ? (deps.locks.request(LOCK_NAME, callRefresh) as Promise<boolean>) : callRefresh()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    refresh,
    getAccessToken: async (): Promise<string | null> => {
      if (accessToken && Date.now() > expiresAt - EXPIRY_MARGIN_MS) await refresh();
      return accessToken;
    },
    signedIn: (token: string, expiry: string) => set(token, Date.parse(expiry)),
    signedOut: () => set(null, 0),
    isSignedIn: () => accessToken !== null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type Session = ReturnType<typeof createSession>;

/** Reads a token from the URL fragment, then removes it so it stays out of history and screenshots. */
export function takeTokenFromUrl(location: Pick<Location, 'hash' | 'pathname'>, history: Pick<History, 'replaceState'>): string | null {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  if (token) history.replaceState(null, '', location.pathname);
  return token;
}
