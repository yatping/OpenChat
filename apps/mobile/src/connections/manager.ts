/**
 * Holds the device's Connection: one user signed in to one installation (ADR-0014). Signing in to another replaces it.
 * Installations are independent and may even choose the same IDs, so a connection is known by a local ID, and
 * everything it owns hangs off that. There is no global client. See docs/ios-build/expo-and-white-label.md.
 */
import { ApiError, createClient, type DiscoveryResponse } from '@openchat/api-client';
import { checkCompatibility, fetchDiscovery, type Compatibility } from './discovery';
import { createSession, refreshTokenKey, type SecureValues, type Session } from './session';

export interface ConnectionRecord {
  id: string;
  baseUrl: string;
  installationId: string;
  installationName: string;
  userId: string;
  email: string;
  displayName: string;
  workspaceId: string | null;
}

export interface ConnectionView extends ConnectionRecord {
  expired: boolean;
  compatibility: Compatibility;
}

export interface ManagerState {
  ready: boolean;
  connections: ConnectionView[];
  activeId: string | null;
}

/** Not secret: which installations this device knows about. Credentials stay in `SecureValues`. */
export interface Registry {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

export interface ManagerDeps {
  registry: Registry;
  secure: SecureValues;
  fetch: typeof globalThis.fetch;
  newId: () => string;
  clientLabel: string;
  /** Removes anything kept on disk for a connection, such as downloaded files. */
  wipeFiles: (connectionId: string) => Promise<void>;
}

export type SignInError = 'wrong_credentials' | 'rate_limited' | 'unreachable' | 'failed';
export type SignInResult = { ok: true; connectionId: string } | { ok: false; reason: SignInError };

export function createConnectionManager(deps: ManagerDeps) {
  let records: ConnectionRecord[] = [];
  let activeId: string | null = null;
  let ready = false;
  const sessions = new Map<string, Session>();
  const expired = new Set<string>();
  const compatibility = new Map<string, Compatibility>();
  const listeners = new Set<() => void>();
  let state: ManagerState = { ready: false, connections: [], activeId: null };

  const publish = () => {
    state = {
      ready,
      activeId,
      connections: records.map((record) => ({ ...record, expired: expired.has(record.id), compatibility: compatibility.get(record.id) ?? 'compatible' })),
    };
    for (const listener of listeners) listener();
  };

  const persist = () => deps.registry.save(JSON.stringify({ connections: records, activeId }));

  const sessionFor = (id: string): Session => {
    let session = sessions.get(id);
    if (!session) {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) throw new Error('Unknown connection');
      session = createSession({
        connectionId: id,
        baseUrl: record.baseUrl,
        secure: deps.secure,
        fetch: deps.fetch,
        onExpired: () => {
          expired.add(id);
          publish();
        },
      });
      sessions.set(id, session);
    }
    return session;
  };

  /** Checked again each time a connection becomes active, because installations upgrade on their own schedule. */
  const recheck = async (id: string) => {
    const record = records.find((candidate) => candidate.id === id);
    if (!record) return;
    const result = await fetchDiscovery(record.baseUrl, deps.fetch);
    // Offline tells us nothing, so the last answer stands.
    if (!result.ok || !records.some((candidate) => candidate.id === id)) return;
    compatibility.set(id, checkCompatibility(result.discovery));
    publish();
  };

  /** Removes everything this device holds for a connection. Each step runs even if another fails. */
  const wipe = async (id: string) => {
    const session = sessionFor(id);
    await Promise.allSettled([session.wipe(), deps.wipeFiles(id)]);
    sessions.delete(id);
    expired.delete(id);
    compatibility.delete(id);
    records = records.filter((record) => record.id !== id);
    if (activeId === id) activeId = records[0]?.id ?? null;
    await persist();
    publish();
    if (activeId) void recheck(activeId);
  };

  /** Ends the session on the installation if it can be reached, and wipes this device either way. */
  const signOut = async (id: string) => {
    const session = sessionFor(id);
    if (session.status() === 'signed_in') await session.client.logout().catch(() => undefined);
    await wipe(id);
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async start() {
      const stored = await deps.registry.load();
      if (stored) {
        const parsed = JSON.parse(stored) as { connections?: ConnectionRecord[]; activeId?: string | null };
        records = parsed.connections ?? [];
        activeId = parsed.activeId && records.some((record) => record.id === parsed.activeId) ? parsed.activeId : (records[0]?.id ?? null);
      }
      // A connection with no credential left cannot sign in, and should say so straight away.
      for (const record of records) if (!(await deps.secure.get(refreshTokenKey(record.id)))) expired.add(record.id);
      ready = true;
      publish();
      if (activeId) void recheck(activeId);
    },

    /** The session for one connection. Screens get it from their own connection, never from "the current one". */
    session: sessionFor,

    discover: (baseUrl: string) => fetchDiscovery(baseUrl, deps.fetch),

    async signIn(baseUrl: string, discovery: DiscoveryResponse, credentials: { email: string; password: string }): Promise<SignInResult> {
      const anonymous = createClient({ baseUrl, fetch: deps.fetch });
      const before = records;
      let id: string | null = null;
      try {
        const tokens = await anonymous.login({ email: credentials.email, password: credentials.password, clientType: 'mobile', clientLabel: deps.clientLabel });
        const authed = createClient({ baseUrl, fetch: deps.fetch, getAccessToken: () => tokens.accessToken });
        const me = await authed.getMe();
        const existing = records.find((record) => record.baseUrl === baseUrl && record.userId === me.id);
        id = existing?.id ?? deps.newId();
        const workspaceIds = me.memberships.map((membership) => membership.workspace.id);
        const record: ConnectionRecord = {
          id,
          baseUrl,
          installationId: discovery.installationId,
          installationName: discovery.name,
          userId: me.id,
          email: me.email,
          displayName: me.name,
          workspaceId: existing?.workspaceId && workspaceIds.includes(existing.workspaceId) ? existing.workspaceId : (workspaceIds[0] ?? null),
        };
        // A session that has expired, or an older sign-in for this user, is replaced rather than reused.
        sessions.delete(id);
        records = existing ? records.map((candidate) => (candidate.id === id ? record : candidate)) : [...records, record];
        await sessionFor(id).signedIn(tokens);
        expired.delete(id);
        compatibility.set(id, checkCompatibility(discovery));
        activeId = id;
        await persist();
        publish();
        // Only reachable from the session-ended screen, signing in as someone else. Nothing of theirs stays.
        for (const other of records.filter((candidate) => candidate.id !== id)) await signOut(other.id);
        return { ok: true, connectionId: id };
      } catch (error) {
        // Nothing half-finished stays behind, such as a connection whose token could not be saved.
        records = before;
        if (id && !before.some((record) => record.id === id)) sessions.delete(id);
        if (__DEV__) console.warn('Sign-in failed', (error as Error).name, error instanceof ApiError ? error.code : (error as Error).message);
        if (!(error instanceof ApiError)) return { ok: false, reason: error instanceof TypeError ? 'unreachable' : 'failed' };
        if (error.status === 401) return { ok: false, reason: 'wrong_credentials' };
        if (error.status === 429) return { ok: false, reason: 'rate_limited' };
        return { ok: false, reason: 'failed' };
      }
    },

    async selectWorkspace(id: string, workspaceId: string) {
      records = records.map((record) => (record.id === id ? { ...record, workspaceId } : record));
      await persist();
      publish();
    },

    signOut,

    /** Removes a connection whose session has ended, or that is gone, without calling it. */
    remove: wipe,
    recheck,
  };
}

export type ConnectionManager = ReturnType<typeof createConnectionManager>;
