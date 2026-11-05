import type { NotificationEvent, PushData } from '@openchat/notification-protocol';

/**
 * The relay writes the text, not the installation, so that a malicious installation cannot use an app's identity to
 * show arbitrary text. Only the workspace's name, limited and cleaned when registered, comes from outside.
 */
const TEXT: Record<string, Record<NotificationEvent, string>> = {
  en: {
    new_conversation: 'New conversation',
    new_message: 'New message',
    conversation_assigned: 'Conversation assigned to you',
    conversation_transferred: 'Conversation transferred to you',
    mention: 'You were mentioned',
    conversation_updated: 'Conversation updated',
  },
};
const DEFAULT_TITLE = 'OpenChat';

export function bodyText(event: NotificationEvent, locale: string): string {
  const language = locale.split('-')[0]?.toLowerCase() ?? 'en';
  return (TEXT[language] ?? TEXT.en!)[event];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PushInput extends Omit<PushData, 'v'> {
  title: string | null;
  locale: string;
  expiresAt: number;
}

export async function composePush(input: PushInput): Promise<{ headers: Record<string, string>; body: string }> {
  const { event, installationId, workspaceId, conversationId, notificationId } = input;
  const data: PushData = { v: 1, event, installationId, workspaceId, conversationId, notificationId };
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
      aps: { alert: { title: input.title ?? DEFAULT_TITLE, body: bodyText(event, input.locale) }, sound: 'default', 'thread-id': threadId, 'mutable-content': 1 },
      oc: data,
    }),
  };
}
