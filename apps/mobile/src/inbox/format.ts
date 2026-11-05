import type { Conversation } from '@openchat/api-client';

export const conversationLabel = (conversation: Pick<Conversation, 'id' | 'contactName' | 'contactEmail'>) => conversation.contactName ?? conversation.contactEmail ?? `Visitor ${conversation.id.slice(-6)}`;

export function shortTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
