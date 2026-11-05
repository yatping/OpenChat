/**
 * The socket for the workspace on screen. It is open only while the app is in the foreground, so it does nothing
 * to battery in the background, and anything missed is read from REST on return.
 */
import type { ApiClient, Message } from '@openchat/api-client';
import type { ConversationPatch } from '@openchat/api-client/inbox-state';
import { createRealtime, type Realtime, type RealtimeStatus, type ServerFrame } from '@openchat/api-client/realtime';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { InboxCache } from './cache';

const POLL_MS = 15_000;
const TYPING_EXPIRES_MS = 5000;

export interface TypingEntry {
  conversationId: string;
  actorType: string;
  actorId: string;
}

export function useLive(api: ApiClient, workspaceId: string, cache: InboxCache, openConversation: { current: string | null }) {
  const client = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [typing, setTyping] = useState<TypingEntry[]>([]);
  const [visitorsOnline, setVisitorsOnline] = useState<ReadonlySet<string>>(new Set());
  const realtime = useRef<Realtime | null>(null);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onFrame = ({ type, data }: ServerFrame) => {
      switch (type) {
        case 'message.created':
          cache.messageCreated(data.message as Message, data.conversationVersion);
          break;
        case 'conversation.created':
          cache.refreshLists();
          break;
        case 'conversation.updated':
          cache.applyPatch(data.conversation as ConversationPatch);
          break;
        case 'typing': {
          const actor = data.actor as { type: string; id: string };
          const entry = { conversationId: String(data.conversationId), actorType: actor.type, actorId: actor.id };
          setTyping((current) => [...current.filter((t) => t.actorId !== entry.actorId), entry]);
          const timer = setTimeout(() => {
            timers.delete(timer);
            setTyping((current) => current.filter((t) => t !== entry));
          }, TYPING_EXPIRES_MS);
          timers.add(timer);
          break;
        }
        case 'presence.visitor':
          setVisitorsOnline((current) => {
            const next = new Set(current);
            if (data.online === true) next.add(String(data.conversationId));
            else next.delete(String(data.conversationId));
            return next;
          });
          break;
        default:
        // Clients ignore what they do not know, because clients and servers upgrade independently.
      }
    };

    const catchUpAll = () => {
      cache.refreshLists();
      if (openConversation.current) void cache.catchUp(openConversation.current).catch(() => undefined);
    };
    const connection = createRealtime(
      { getTicket: () => api.createRealtimeTicket(workspaceId), openSocket: (url) => new WebSocket(url) as never },
      {
        onStatus: setStatus,
        onFrame,
        onConnected: catchUpAll,
        onRevoked: () => void client.invalidateQueries({ queryKey: ['me'] }),
      },
    );
    realtime.current = connection;
    if (AppState.currentState === 'active') connection.start();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') connection.start();
      else if (next === 'background') connection.stop();
    });
    return () => {
      subscription.remove();
      connection.stop();
      realtime.current = null;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [api, cache, client, openConversation, workspaceId]);

  const polling = status === 'polling';
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      cache.refreshLists();
      if (openConversation.current) void cache.catchUp(openConversation.current).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [cache, openConversation, polling]);

  return { status, typing, visitorsOnline, realtime };
}
