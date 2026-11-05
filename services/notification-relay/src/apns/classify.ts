import type { ApnsResponse } from '@openchat/notification-protocol';

/**
 * What the relay does about an answer from APNs. Credential problems never remove a device, because a
 * bad key would otherwise erase every registration. See docs/notification-relay/protocol.md.
 */
export type ApnsAction = 'delivered' | 'remove_device' | 'refresh_token' | 'credential_error' | 'stop_minting' | 'retry' | 'permanent_failure';

const INVALID_DEVICE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic']);

export function classifyApnsResponse({ status, reason }: Pick<ApnsResponse, 'status' | 'reason'>): ApnsAction {
  if (status === 200) return 'delivered';
  if (status === 410) return 'remove_device';
  if (status === 400 && reason && INVALID_DEVICE_REASONS.has(reason)) return 'remove_device';
  if (status === 403) return reason === 'ExpiredProviderToken' ? 'refresh_token' : 'credential_error';
  if (status === 429) return reason === 'TooManyProviderTokenUpdates' ? 'stop_minting' : 'retry';
  if (status >= 500) return 'retry';
  return 'permanent_failure';
}
