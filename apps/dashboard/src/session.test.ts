import { describe, expect, it, vi } from 'vitest';
import { createSession, takeTokenFromUrl } from './session';

const ok = (minutes = 15) => new Response(JSON.stringify({ accessToken: 'new', accessTokenExpiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }));

describe('session', () => {
  it('starts signed out, and a refresh with a valid cookie signs in', async () => {
    const session = createSession({ fetch: vi.fn<typeof fetch>(() => Promise.resolve(ok())) });
    expect(session.isSignedIn()).toBe(false);
    expect(await session.refresh()).toBe(true);
    expect(await session.getAccessToken()).toBe('new');
  });

  it('sends one refresh when several requests need one, because a repeat would revoke the session', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    const session = createSession({ fetch: fetcher });
    await Promise.all([session.refresh(), session.refresh(), session.refresh()]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('holds a lock across tabs while refreshing', async () => {
    const order: string[] = [];
    const locks = {
      request: vi.fn(async (name: string, callback: () => Promise<boolean>) => {
        order.push(`lock:${name}`);
        const result = await callback();
        order.push('unlock');
        return result;
      }),
    };
    const fetcher = vi.fn<typeof fetch>(() => {
      order.push('fetch');
      return Promise.resolve(ok());
    });
    await createSession({ fetch: fetcher, locks: locks as never }).refresh();
    expect(order).toEqual(['lock:openchat-refresh', 'fetch', 'unlock']);
  });

  it('signs out on 401, and tells listeners', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    const session = createSession({ fetch: fetcher });
    await session.refresh();
    const listener = vi.fn();
    session.subscribe(listener);
    fetcher.mockImplementation(() => Promise.resolve(new Response('{}', { status: 401 })));
    expect(await session.refresh()).toBe(false);
    expect(session.isSignedIn()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('stays signed in through a network failure or a server error', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    const session = createSession({ fetch: fetcher });
    await session.refresh();
    fetcher.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(await session.refresh()).toBe(false);
    expect(session.isSignedIn()).toBe(true);
    fetcher.mockImplementation(() => Promise.resolve(new Response('{}', { status: 503 })));
    expect(await session.refresh()).toBe(false);
    expect(session.isSignedIn()).toBe(true);
  });

  it('refreshes before a nearly expired token is used', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    const session = createSession({ fetch: fetcher });
    session.signedIn('old', new Date(Date.now() + 1_000).toISOString());
    expect(await session.getAccessToken()).toBe('new');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('takeTokenFromUrl', () => {
  it('reads the token and removes it from the address bar', () => {
    const history = { replaceState: vi.fn() };
    expect(takeTokenFromUrl({ hash: '#token=abc', pathname: '/reset-password' }, history)).toBe('abc');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/reset-password');
  });

  it('touches nothing when there is no token', () => {
    const history = { replaceState: vi.fn() };
    expect(takeTokenFromUrl({ hash: '', pathname: '/x' }, history)).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
