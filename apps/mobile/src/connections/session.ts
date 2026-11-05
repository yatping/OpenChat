/**
 * One signed-in user on one installation. The access token stays in memory, and the refresh token in the iOS
 * keychain under a key that belongs to this connection only. A refresh token presented twice revokes the session,
 * so refreshes never overlap.
 */
import { createClient, type ApiClient, type TokenPair } from '@openchat/api-client';

export interface SecureValues {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type SessionStatus = 'signed_in' | 'expired';

export const refreshTokenKey = (connectionId: string) => `conn.${connectionId}.refresh`;

/** Refresh a little early, so that a request does not set out with a token about to end. */
const EXPIRY_MARGIN_MS = 30_000;

export interface SessionDeps {
  connectionId: string;
  baseUrl: string;
  secure: SecureValues;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  /** A refresh was refused, so the user has to sign in again. */
  onExpired: () => void;
}

export interface Session {
  readonly client: ApiClient;
  status(): SessionStatus;
  signedIn(tokens: TokenPair): Promise<void>;
  refresh(): Promise<boolean>;
  getAccessToken(): Promise<string | null>;
  /** Forgets every credential. Nothing here is usable afterwards. */
  wipe(): Promise<void>;
}

export function createSession(deps: SessionDeps): Session {
  const now = deps.now ?? Date.now;
  const key = refreshTokenKey(deps.connectionId);
  let accessToken: string | null = null;
  let expiresAt = 0;
  let status: SessionStatus = 'signed_in';
  let wiped = false;
  let inFlight: Promise<boolean> | null = null;

  const expire = async () => {
    accessToken = null;
    status = 'expired';
    await deps.secure.remove(key);
    deps.onExpired();
  };

  async function callRefresh(): Promise<boolean> {
    const refreshToken = await deps.secure.get(key);
    if (!refreshToken) {
      await expire();
      return false;
    }
    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ refreshToken }) });
    } catch {
      // Being offline is not being signed out. The next request tries again.
      return false;
    }
    if (wiped) return false;
    if (response.status === 401 || response.status === 403) {
      await expire();
      return false;
    }
    if (!response.ok) return false;
    const tokens = (await response.json()) as TokenPair;
    // The old token has been used, so the new one must be saved before anything can interrupt this.
    if (tokens.refreshToken) await deps.secure.set(key, tokens.refreshToken);
    accessToken = tokens.accessToken;
    expiresAt = Date.parse(tokens.accessTokenExpiresAt);
    return true;
  }

  const refresh = (): Promise<boolean> => {
    if (wiped || status === 'expired') return Promise.resolve(false);
    inFlight ??= callRefresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const getAccessToken = async () => {
    if (!wiped && status === 'signed_in' && (!accessToken || now() > expiresAt - EXPIRY_MARGIN_MS)) await refresh();
    return accessToken;
  };

  return {
    client: createClient({ baseUrl: deps.baseUrl, fetch: deps.fetch, getAccessToken, onUnauthorized: refresh }),
    status: () => status,
    refresh,
    getAccessToken,
    signedIn: async (tokens) => {
      if (!tokens.refreshToken) throw new Error('The installation did not return a refresh token');
      await deps.secure.set(key, tokens.refreshToken);
      accessToken = tokens.accessToken;
      expiresAt = Date.parse(tokens.accessTokenExpiresAt);
      status = 'signed_in';
    },
    wipe: async () => {
      wiped = true;
      accessToken = null;
      await deps.secure.remove(key);
    },
  };
}
