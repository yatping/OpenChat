/** The iOS side of the connection manager. The rest of src/connections has no native imports, so it can be tested. */
import { randomUUID } from 'expo-crypto';
import { Directory, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
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
  fetch: (input, init) => globalThis.fetch(input, init),
  newId: randomUUID,
  clientLabel: 'iOS app',
  wipeFiles: async (connectionId) => {
    const directory = connectionFiles(connectionId);
    if (directory.exists) directory.delete();
  },
});
