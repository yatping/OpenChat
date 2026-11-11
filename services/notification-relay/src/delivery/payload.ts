import type { NotificationEvent, PushData } from '@openchat/notification-protocol';

/**
 * The relay writes no text (ADR-0017). The phone's extension decrypts `oc.c` and shows the workspace, sender and
 * message. If it cannot, iOS shows the app's own phrase for `loc-key`, in the phone's language. The keys are listed in
 * the app's config plugin, apps/mobile/plugins/notification-service.
 */
export function locKey(event: NotificationEvent): string {
  return `OC_${event.toUpperCase()}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PushInput extends Omit<PushData, 'v'> {
  expiresAt: number;
}

export async function composePush(input: PushInput): Promise<{ headers: Record<string, string>; body: string }> {
  const { event, installationId, workspaceId, conversationId, notificationId, subscriptionId, c } = input;
  const data: PushData = { v: 1, event, installationId, workspaceId, conversationId, notificationId, subscriptionId, c };
  const threadId = (await sha256Hex(`${installationId}\n${conversationId}`)).slice(0, 32);
  const collapseId = (await sha256Hex(`${installationId}\n${conversationId}\n${event}`)).slice(0, 64);
  const idHash = await sha256Hex(`${installationId}\n${workspaceId}\n${notificationId}`);
  const apnsId = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-${idHash.slice(12, 16)}-${idHash.slice(16, 20)}-${idHash.slice(20, 32)}`;
  return {
    headers: {
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(input.expiresAt / 1000)),
      'apns-collapse-id': collapseId,
      'apns-id': apnsId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: { alert: { 'loc-key': locKey(event) }, sound: 'default', 'thread-id': threadId, 'mutable-content': 1 },
      oc: data,
    }),
  };
}
