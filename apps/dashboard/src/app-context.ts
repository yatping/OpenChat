import { ApiError, createClient } from '@openchat/api-client';
import { QueryClient } from '@tanstack/react-query';
import { t } from './i18n';
import { createSession } from './session';

export const session = createSession({
  fetch: (...args) => fetch(...args),
  locks: typeof navigator !== 'undefined' ? navigator.locks : undefined,
});

export const api = createClient({
  baseUrl: window.location.origin,
  getAccessToken: session.getAccessToken,
  onUnauthorized: session.refresh,
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 has already tried a refresh, and 403 and 404 will not change by retrying.
      retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
    },
  },
});

export const errorMessage = (error: unknown) => (error instanceof ApiError ? error.message : t('somethingWrong'));

/** Local preference only. Storage can be unavailable, and the app works without it. */
export const preference = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Remembering this is only a convenience.
    }
  },
};
