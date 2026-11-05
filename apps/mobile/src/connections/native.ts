/** The iOS side of the connection manager. The rest of src/connections has no native imports, so it can be tested. */
import { randomUUID } from 'expo-crypto';
import { fetch as binaryFetch } from 'expo/fetch';
import { Directory, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
import { pushRegistrar } from '../push/native';
import { createConnectionManager } from './manager';

const REGISTRY_KEY = 'connections';
// Not in backups, and not moved to another device.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const connectionFiles = (connectionId: string) => new Directory(Paths.cache, 'connections', connectionId);

export const connections = createConnectionManager({
  registry: {
    load: () => Storage.getItem(REGISTRY_KEY),
    save: (value) => Storage.setItem(REGISTRY_KEY, value),
  },
  secure: {
    get: (key) => SecureStore.getItemAsync(key, KEYCHAIN),
    set: (key, value) => SecureStore.setItemAsync(key, value, KEYCHAIN),
    remove: (key) => SecureStore.deleteItemAsync(key, KEYCHAIN),
  },
  fetch: (input, init) => {
    const url = String(input);
    // React Native's own fetch cannot return bytes or send them reliably, and files are the one thing that needs to.
    if (/\/attachments(\/|\?|$)/.test(url)) return binaryFetch(url, init as Parameters<typeof binaryFetch>[1]) as unknown as Promise<Response>;
    if (!url.endsWith('/realtime/tickets')) return globalThis.fetch(input, init);
    // iOS always puts the server's own origin on a WebSocket, and a ticket must name the origin that will use it.
    const headers = new Headers(init?.headers);
    headers.set('origin', /^https?:\/\/[^/]+/.exec(url)![0]);
    return globalThis.fetch(input, { ...init, headers });
  },
  newId: randomUUID,
  clientLabel: 'iOS app',
  forgetPush: (connectionId, client) => pushRegistrar.forget(connectionId, client),
  wipeFiles: async (connectionId) => {
    const directory = connectionFiles(connectionId);
    if (directory.exists) directory.delete();
  },
});
