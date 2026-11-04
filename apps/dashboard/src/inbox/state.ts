/**
 * How events combine with what is on screen. Events may repeat or arrive out of order, so everything here
 * merges by ID, sequence, and version, and converges whatever the order. See docs/architecture/realtime.md.
 */
import type { Conversation, ConversationPage, Message } from '@openchat/api-client';

export interface ConversationPages {
  pages: ConversationPage[];
  pageParams: unknown[];
}

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export const highestSeq = (messages: Message[]) => messages.at(-1)?.seq ?? 0;

/** Sequence numbers have no holes for an agent, so a jump means something was missed. */
export const hasGap = (messages: Message[], incoming: Pick<Message, 'seq'>) => messages.length > 0 && incoming.seq > highestSeq(messages) + 1;

export type ConversationPatch = Partial<Conversation> & Pick<Conversation, 'id' | 'version'>;

export const unreadCount = (conversation: Pick<Conversation, 'lastMessageSeq' | 'lastReadSeq'>) => Math.max(0, conversation.lastMessageSeq - conversation.lastReadSeq);

export interface InboxFilter {
  status: Conversation['status'];
  /** A member ID, or `none`. */
  assignee?: string | undefined;
}

export const matchesFilter = (conversation: Pick<Conversation, 'status' | 'assignedMemberId'>, filter: InboxFilter) =>
  conversation.status === filter.status &&
  (filter.assignee === undefined || (filter.assignee === 'none' ? conversation.assignedMemberId === null : conversation.assignedMemberId === filter.assignee));

const definedOnly = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/** An older version changes nothing, and a row can leave the view it no longer belongs in. */
export function applyPatch(conversation: Conversation, patch: ConversationPatch): Conversation {
  return patch.version < conversation.version ? conversation : { ...conversation, ...definedOnly(patch) };
}

const byRecent = (a: Conversation, b: Conversation) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.id.localeCompare(a.id);

/** `found` false means that this view does not hold the row and may need to read it. */
export function patchPages(data: ConversationPages, patch: ConversationPatch, filter: InboxFilter): { data: ConversationPages; found: boolean } {
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    data: page.data
      .map((row) => {
        if (row.id !== patch.id) return row;
        found = true;
        return applyPatch(row, patch);
      })
      .filter((row) => row.id !== patch.id || matchesFilter(row, filter)),
  }));
  return { data: { ...data, pages }, found };
}

export function recordNewMessage(data: ConversationPages, message: Pick<Message, 'conversationId' | 'seq' | 'createdAt'>): { data: ConversationPages; found: boolean } {
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    data: page.data.map((row) => {
      if (row.id !== message.conversationId) return row;
      found = true;
      return row.lastMessageSeq >= message.seq ? row : { ...row, lastMessageSeq: message.seq, lastMessageAt: message.createdAt };
    }),
  }));
  if (!found) return { data, found };
  // Sorted within what has been loaded. A later page keeps its place until it is read again.
  const rows = pages.flatMap((page) => page.data).sort(byRecent);
  let start = 0;
  return {
    found,
    data: {
      ...data,
      pages: pages.map((page) => {
        const slice = rows.slice(start, start + page.data.length);
        start += page.data.length;
        return { ...page, data: slice };
      }),
    },
  };
}

export function markReadInPages(data: ConversationPages, conversationId: string, seq: number): ConversationPages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      data: page.data.map((row) => (row.id === conversationId && row.lastReadSeq < seq ? { ...row, lastReadSeq: seq } : row)),
    })),
  };
}

/** Receivers expire typing, because no one says when it stops. */
export const TYPING_EXPIRES_MS = 5000;
export const TYPING_SEND_INTERVAL_MS = 3000;

export function shouldSendTyping(lastSent: number, now: number): boolean {
  return now - lastSent >= TYPING_SEND_INTERVAL_MS;
}
