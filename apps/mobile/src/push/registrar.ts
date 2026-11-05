/**
 * Registers this device for push. The relay address is checked against a list fixed at build time, because an
 * installation that could name any relay could collect the tokens of everyone who connects. No native imports, so
 * this can be tested. See docs/ios-build/expo-and-white-label.md.
 */
import type { ApiClient, DiscoveryResponse } from '@openchat/api-client';

export interface PushConfig {
  enabled: boolean;
  environment: 'sandbox' | 'production';
  bundleId: string;
  allowedRelays: { id: string; url: string }[];
}

export interface PushNative {
  requestPermission(): Promise<boolean>;
  deviceToken(): Promise<string>;
  locale(): string;
}

export interface SecureValues {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export type PushStatus = 'off' | 'not_allowed' | 'denied' | 'on' | 'failed';

interface DeviceRecord {
  relayUrl: string;
  id: string;
  secret: string;
  token: string;
}
type Subscriptions = Record<string, { id: string; relaySubscriptionId: string; relayUrl: string }>;
type Pending = { relayUrl: string; deviceId: string; secret: string; subscriptionId: string };

const DEVICE_KEY = 'push.device';
const PENDING_KEY = 'push.pending';
const subscriptionsKey = (connectionId: string) => `push.subscriptions.${connectionId}`;
const SIGN_OUT_TIMEOUT_MS = 5_000;

const within = <T>(ms: number, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

class RelayRefused extends Error {
  constructor(readonly status: number) {
    super(`Relay answered ${status}`);
  }
}

export function allowedRelay(config: PushConfig, relay: DiscoveryResponse['relay']): { id: string; url: string } | null {
  if (!relay || typeof relay.url !== 'string' || !Array.isArray(relay.bundleIds) || !relay.bundleIds.includes(config.bundleId)) return null;
  return config.allowedRelays.find((allowed) => allowed.url === relay.url && allowed.id === relay.id) ?? null;
}

export function createPushRegistrar(deps: { config: PushConfig; native: PushNative; secure: SecureValues; fetch: typeof globalThis.fetch }) {
  const { config, native, secure } = deps;
  const listeners = new Set<() => void>();
  let status: PushStatus = config.enabled ? 'failed' : 'off';
  let running: Promise<void> | null = null;

  const setStatus = (next: PushStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };

  const readJson = async <T>(key: string, fallback: T): Promise<T> => {
    const value = await secure.get(key);
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };
  const readDevice = async (relayUrl: string) => {
    const device = await readJson<DeviceRecord | null>(DEVICE_KEY, null);
    return device?.relayUrl === relayUrl ? device : null;
  };

  const relayPost = async (url: string, body: unknown, secret?: string): Promise<unknown> => {
    const response = await deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new RelayRefused(response.status);
    return response.status === 204 ? null : response.json();
  };

  const unregisterAtRelay = (item: Pending) => relayPost(`${item.relayUrl}/v1/devices/unregister`, { deviceId: item.deviceId, subscriptionId: item.subscriptionId }, item.secret);

  /** Anything other than a clear refusal stays queued, since the phone may just be offline. */
  const flushPending = async () => {
    const pending = await readJson<Pending[]>(PENDING_KEY, []);
    if (pending.length === 0) return;
    const left: Pending[] = [];
    for (const item of pending) {
      await unregisterAtRelay(item).catch((error: unknown) => {
        if (!(error instanceof RelayRefused && error.status < 500)) left.push(item);
      });
    }
    if (left.length > 0) await secure.set(PENDING_KEY, JSON.stringify(left));
    else await secure.remove(PENDING_KEY);
  };

  /** A token that changed updates every subscription at once. A device the relay has forgotten starts again. */
  const sendToken = async (relayUrl: string, token: string): Promise<DeviceRecord | null> => {
    const device = await readDevice(relayUrl);
    if (!device) return null;
    if (device.token === token) return device;
    try {
      await relayPost(`${relayUrl}/v1/devices/token`, { deviceId: device.id, apnsToken: token }, device.secret);
    } catch (error) {
      if (!(error instanceof RelayRefused && error.status === 401)) throw error;
      await secure.remove(DEVICE_KEY);
      return null;
    }
    const updated = { ...device, token };
    await secure.set(DEVICE_KEY, JSON.stringify(updated));
    return updated;
  };

  const registerWorkspace = async (api: ApiClient, relayUrl: string, workspaceId: string, token: string, device: DeviceRecord | null) => {
    const grant = await api.createPushGrant(workspaceId);
    // Discovery was checked, and this answer comes from the same installation, so it gets the same check.
    if (grant.relayUrl !== relayUrl) throw new Error('The grant names a different relay');
    const answer = (await relayPost(`${relayUrl}/v1/devices/register`, {
      grant: grant.grant,
      platform: 'ios',
      apnsToken: token,
      bundleId: config.bundleId,
      environment: config.environment,
      locale: native.locale(),
      ...(device ? { device: { id: device.id, secret: device.secret } } : {}),
    })) as { deviceId: string; deviceSecret?: string; subscriptionId: string };
    const registered = answer.deviceSecret ? { relayUrl, id: answer.deviceId, secret: answer.deviceSecret, token } : device;
    if (!registered) throw new Error('The relay gave no device secret');
    if (answer.deviceSecret) await secure.set(DEVICE_KEY, JSON.stringify(registered));
    const recorded = await api.recordPushSubscription(workspaceId, { relaySubscriptionId: answer.subscriptionId, deviceLabel: 'iOS app' });
    return { device: registered, subscription: { id: recorded.id, relaySubscriptionId: answer.subscriptionId, relayUrl } };
  };

  const syncNow = async (input: { connectionId: string; api: ApiClient; relay: DiscoveryResponse['relay']; workspaceIds: string[] }) => {
    if (!config.enabled) return setStatus('off');
    const relay = allowedRelay(config, input.relay);
    if (!relay) return setStatus('not_allowed');
    try {
      await flushPending();
      if (!(await native.requestPermission())) return setStatus('denied');
      const token = await native.deviceToken();
      let device = await sendToken(relay.url, token);
      const stored = await readJson<Subscriptions>(subscriptionsKey(input.connectionId), {});
      const next: Subscriptions = {};
      for (const workspaceId of input.workspaceIds) {
        const known = stored[workspaceId];
        // The installation decides what is still registered: it removes rows when sessions are revoked.
        const held = known?.relayUrl === relay.url && device ? (await input.api.listPushSubscriptions(workspaceId)).data.some((row) => row.id === known.id) : false;
        if (held && known) {
          next[workspaceId] = known;
          continue;
        }
        const result = await registerWorkspace(input.api, relay.url, workspaceId, token, device);
        device = result.device;
        next[workspaceId] = result.subscription;
        await secure.set(subscriptionsKey(input.connectionId), JSON.stringify({ ...stored, ...next }));
      }
      await secure.set(subscriptionsKey(input.connectionId), JSON.stringify(next));
      setStatus('on');
    } catch (error) {
      if (__DEV__) console.warn('Push registration failed', (error as Error).name);
      setStatus('failed');
    }
  };

  return {
    getStatus: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Safe to call whenever: on sign-in and on each start. Messaging never waits for it, and it never throws. */
    sync(input: { connectionId: string; api: ApiClient; relay: DiscoveryResponse['relay']; workspaceIds: string[] }): Promise<void> {
      running ??= syncNow(input).finally(() => {
        running = null;
      });
      return running;
    },

    /** From iOS, whenever it issues a new token. */
    async tokenChanged(token: string): Promise<void> {
      const device = await readJson<DeviceRecord | null>(DEVICE_KEY, null);
      if (device) await sendToken(device.relayUrl, token).catch(() => undefined);
    },

    /**
     * On sign-out. The relay comes first and needs no session. If it cannot be reached the call is kept for later, and
     * the installation's row is removed if it can be. Sign-out never waits long for any of this.
     */
    async forget(connectionId: string, api: ApiClient | null): Promise<void> {
      const stored = await readJson<Subscriptions>(subscriptionsKey(connectionId), {});
      await secure.remove(subscriptionsKey(connectionId));
      const device = await readJson<DeviceRecord | null>(DEVICE_KEY, null);
      const entries = Object.entries(stored);
      const missed: Pending[] = [];
      await Promise.all(
        entries.map(async ([workspaceId, subscription]) => {
          if (device?.relayUrl === subscription.relayUrl) {
            const item = { relayUrl: subscription.relayUrl, deviceId: device.id, secret: device.secret, subscriptionId: subscription.relaySubscriptionId };
            await within(SIGN_OUT_TIMEOUT_MS, unregisterAtRelay(item)).catch(() => missed.push(item));
          }
          if (api) await within(SIGN_OUT_TIMEOUT_MS, api.removePushSubscription(workspaceId, subscription.id)).catch(() => undefined);
        }),
      );
      if (missed.length > 0) await secure.set(PENDING_KEY, JSON.stringify([...(await readJson<Pending[]>(PENDING_KEY, [])), ...missed]));
    },
  };
}

export type PushRegistrar = ReturnType<typeof createPushRegistrar>;
