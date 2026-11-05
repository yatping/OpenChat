/** The iOS side of push. Everything else in src/push has no native imports, so it can be tested. */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { destination, parseDestination, shouldShowInForeground } from './destination';
import { createPushRegistrar, type PushConfig } from './registrar';

const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const extra = (Constants.expoConfig?.extra ?? {}) as { push?: Omit<PushConfig, 'bundleId'> };

function locale(): string {
  const tag = Intl.DateTimeFormat().resolvedOptions().locale;
  return /^[A-Za-z0-9-]{2,35}$/.test(tag) ? tag : 'en';
}

export const pushRegistrar = createPushRegistrar({
  config: {
    enabled: extra.push?.enabled === true,
    environment: extra.push?.environment === 'sandbox' ? 'sandbox' : 'production',
    allowedRelays: extra.push?.allowedRelays ?? [],
    bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? '',
  },
  native: {
    async requestPermission() {
      const current = await Notifications.getPermissionsAsync();
      return current.granted || (current.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    },
    deviceToken: async () => (await Notifications.getDevicePushTokenAsync()).data as string,
    locale,
  },
  secure: {
    get: (key) => SecureStore.getItemAsync(key, KEYCHAIN),
    set: (key, value) => SecureStore.setItemAsync(key, value, KEYCHAIN),
    remove: (key) => SecureStore.deleteItemAsync(key, KEYCHAIN),
  },
  fetch: (input, init) => globalThis.fetch(input, init),
});

/** The relay's own key is in the APNs payload, which Expo keeps on the trigger for a remote notification. */
function payloadOf(notification: Notifications.Notification): unknown {
  const trigger = notification.request.trigger as { payload?: unknown } | null;
  return trigger?.payload ?? notification.request.content.data;
}

/** Called once, at launch. */
export function startPushListeners(): void {
  if (extra.push?.enabled !== true) return;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = shouldShowInForeground(payloadOf(notification));
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  const open = (response: Notifications.NotificationResponse | null) => {
    const target = response && parseDestination(payloadOf(response.notification));
    if (target) destination.set(target);
    // So that a later launch does not open the same one again.
    if (response) Notifications.clearLastNotificationResponse();
  };
  open(Notifications.getLastNotificationResponse());
  Notifications.addNotificationResponseReceivedListener(open);
  Notifications.addPushTokenListener((token) => void pushRegistrar.tokenChanged(token.data as string));
}
