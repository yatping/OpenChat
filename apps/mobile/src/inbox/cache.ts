/**
 * How server events reach the query cache. Events are only a hint: they may repeat, arrive out of order, or not
 * arrive, so everything merges by ID, sequence, and version, and a gap is filled from REST.
 * See docs/architecture/realtime.md.
 */
import type { ApiClient, Conversation, Message } from '@openchat/api-client';
import { applyPatch, hasGap, highestSeq, markReadInPages, matchesFilter, mergeMessages, patchPages, recordNewMessage, type ConversationPages, type ConversationPatch, type InboxFilter } from '@openchat/api-client/inbox-state';
import type { QueryClient } from '@tanstack/react-query';

export const listKey = (workspaceId: string) => ['conversations', workspaceId] as const;
export const detailKey = (workspaceId: string, id: string) => ['conversation', workspaceId, id] as const;
export const threadKey = (workspaceId: string, id: string) => ['messages', workspaceId, id] as const;

export function createInboxCache(client: QueryClient, api: ApiClient, workspaceId: string) {
  const eachList = (change: (data: ConversationPages, filter: InboxFilter) => ConversationPages) => {
    for (const query of client.getQueryCache().findAll({ queryKey: listKey(workspaceId) })) {
      const data = query.state.data as ConversationPages | undefined;
      if (data) client.setQueryData(query.queryKey, change(data, query.queryKey[2] as InboxFilter));
    }
  };
  const refreshLists = () => void client.invalidateQueries({ queryKey: listKey(workspaceId) });

  const catchUp = async (conversationId: string) => {
    const key = threadKey(workspaceId, conversationId);
    void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) });
    // One page per pass, and a page shorter than full means that this is the end.
    for (let pass = 0; pass < 20; pass++) {
      const known = client.getQueryData<Message[]>(key);
      if (!known) return;
      const { data } = await api.listMessages(workspaceId, conversationId, { afterSeq: highestSeq(known) });
      if (data.length === 0) return;
      client.setQueryData<Message[]>(key, mergeMessages(client.getQueryData<Message[]>(key) ?? [], data));
      if (data.length < 50) return;
    }
  };

  return {
    refreshLists,
    catchUp,

    applyPatch(patch: ConversationPatch) {
      client.setQueryData<Conversation>(detailKey(workspaceId, patch.id), (current) => (current ? applyPatch(current, patch) : current));
      let missing = false;
      eachList((data, filter) => {
        const result = patchPages(data, patch, filter);
        // It may have just entered this view, and a patch does not hold a whole row.
        if (!result.found && patch.status !== undefined && matchesFilter({ status: patch.status, assignedMemberId: patch.assignedMemberId ?? null }, filter)) missing = true;
        return result.data;
      });
      if (missing) refreshLists();
    },

    messageCreated(message: Message, conversationVersion: unknown) {
      let missing = false;
      eachList((pages, filter) => {
        const result = recordNewMessage(pages, message);
        // A row beyond what is loaded should come to the top. Other views would refetch for no gain.
        if (!result.found && filter.status === 'open' && filter.assignee === undefined) missing = true;
        return result.data;
      });
      if (missing) refreshLists();
      const detail = detailKey(workspaceId, message.conversationId);
      // Every message moves the version. Without the new one, the next change here would be refused.
      if (typeof conversationVersion === 'number') {
        client.setQueryData<Conversation>(detail, (current) => (current && current.version < conversationVersion ? { ...current, version: conversationVersion } : current));
      } else {
        void client.invalidateQueries({ queryKey: detail });
      }
      client.setQueryData<Conversation>(detail, (current) => (current && current.lastMessageSeq < message.seq ? { ...current, lastMessageSeq: message.seq, lastMessageAt: message.createdAt } : current));
      const key = threadKey(workspaceId, message.conversationId);
      const known = client.getQueryData<Message[]>(key);
      if (known) {
        client.setQueryData<Message[]>(key, mergeMessages(known, [message]));
        if (hasGap(known, message)) void catchUp(message.conversationId).catch(() => undefined);
      }
    },

    messageSent(conversationId: string, message: Message) {
      client.setQueryData<Message[]>(threadKey(workspaceId, conversationId), (known) => mergeMessages(known ?? [], [message]));
      // This send moved the conversation's version, and the socket may be down.
      void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) });
    },

    markedRead(conversationId: string, seq: number) {
      eachList((data) => markReadInPages(data, conversationId, seq));
      client.setQueryData<Conversation>(detailKey(workspaceId, conversationId), (current) => (current ? { ...current, lastReadSeq: Math.max(current.lastReadSeq, seq) } : current));
    },
  };
}

export type InboxCache = ReturnType<typeof createInboxCache>;
