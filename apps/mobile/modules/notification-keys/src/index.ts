import { requireNativeModule } from 'expo';

/** See ios/NotificationKeysModule.swift and ADR-0017. */
interface NotificationKeysModule {
  createPreviewKey(subscriptionId: string): Promise<string>;
  hasPreviewKey(subscriptionId: string): Promise<boolean>;
  deletePreviewKey(subscriptionId: string): Promise<void>;
}

export default requireNativeModule<NotificationKeysModule>('NotificationKeys');
