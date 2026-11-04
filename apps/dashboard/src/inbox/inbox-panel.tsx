/**
 * The team inbox. D1 is the record and REST the only way to write, so the socket here only keeps the screen
 * fresh, and everything still works without it. Content is rendered as text, never as HTML.
 */
import { ApiError, type Conversation, type Me, type Member, type Message } from '@openchat/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../app-context';
import { createRealtime, type Realtime, type RealtimeStatus, type ServerFrame } from './realtime';
import {
  applyPatch,
  hasGap,
  highestSeq,
  markReadInPages,
  matchesFilter,
  mergeMessages,
  patchPages,
  recordNewMessage,
  shouldSendTyping,
  TYPING_EXPIRES_MS,
  unreadCount,
  type ConversationPages,
  type ConversationPatch,
  type InboxFilter,
} from './state';

type Membership = Me['memberships'][number];

const STATUSES: Conversation['status'][] = ['open', 'pending', 'resolved', 'archived'];
const PRIORITIES: Conversation['priority'][] = ['low', 'normal', 'high', 'urgent'];
const POLL_MS = 30_000;
/** Larger than any position, to ask for the newest page. */
const NEWEST = 2_147_483_647;

const listKey = (workspaceId: string) => ['conversations', workspaceId];
const threadKey = (workspaceId: string, id: string) => ['messages', workspaceId, id];
const detailKey = (workspaceId: string, id: string) => ['conversation', workspaceId, id];
const label = (conversation: Pick<Conversation, 'id' | 'subject'>) => conversation.subject ?? `Visitor ${conversation.id.slice(-6)}`;

function eachList(client: QueryClient, workspaceId: string, change: (data: ConversationPages, filter: InboxFilter) => ConversationPages) {
  for (const query of client.getQueryCache().findAll({ queryKey: listKey(workspaceId) })) {
    const filter = query.queryKey[2] as InboxFilter;
    const data = query.state.data as ConversationPages | undefined;
    if (data) client.setQueryData(query.queryKey, change(data, filter));
  }
}

function applyConversationPatch(client: QueryClient, workspaceId: string, patch: ConversationPatch) {
  client.setQueryData<Conversation>(detailKey(workspaceId, patch.id), (current) => (current ? applyPatch(current, patch) : current));
  let missing = false;
  eachList(client, workspaceId, (data, filter) => {
    const result = patchPages(data, patch, filter);
    // It may have just entered this view, and a patch does not hold a whole row.
    if (!result.found && patch.status !== undefined && matchesFilter({ status: patch.status, assignedMemberId: patch.assignedMemberId ?? null }, filter)) missing = true;
    return result.data;
  });
  if (missing) void client.invalidateQueries({ queryKey: listKey(workspaceId) });
}

async function catchUp(client: QueryClient, workspaceId: string, conversationId: string) {
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
}

interface TypingEntry {
  conversationId: string;
  actorType: string;
  actorId: string;
}

function useInboxSocket(workspaceId: string, selectedRef: { current: string | null }) {
  const client = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [typing, setTyping] = useState<TypingEntry[]>([]);
  const [visitorsOnline, setVisitorsOnline] = useState<ReadonlySet<string>>(new Set());
  const [membersOnline, setMembersOnline] = useState<ReadonlySet<string>>(new Set());
  const realtime = useRef<Realtime | null>(null);

  useEffect(() => {
    const setOnline = (set: typeof setMembersOnline, id: string, online: boolean) =>
      set((current) => {
        const next = new Set(current);
        if (online) next.add(id);
        else next.delete(id);
        return next;
      });

    const onFrame = ({ type, data }: ServerFrame) => {
      switch (type) {
        case 'message.created': {
          const message = data.message as Message;
          let missing = false;
          eachList(client, workspaceId, (pages, filter) => {
            const result = recordNewMessage(pages, message);
            // A row beyond what is loaded should come to the top. Other views would refetch for no gain.
            if (!result.found && filter.status === 'open' && filter.assignee === undefined) missing = true;
            return result.data;
          });
          if (missing) void client.invalidateQueries({ queryKey: listKey(workspaceId) });
          const detail = detailKey(workspaceId, message.conversationId);
          // Every message moves the version. Without the new one, the next change here would be refused.
          if (typeof data.conversationVersion === 'number') {
            const version = data.conversationVersion;
            client.setQueryData<Conversation>(detail, (current) => (current && current.version < version ? { ...current, version } : current));
          } else {
            void client.invalidateQueries({ queryKey: detail });
          }
          client.setQueryData<Conversation>(detail, (current) => (current && current.lastMessageSeq < message.seq ? { ...current, lastMessageSeq: message.seq, lastMessageAt: message.createdAt } : current));
          const key = threadKey(workspaceId, message.conversationId);
          const known = client.getQueryData<Message[]>(key);
          if (known) {
            client.setQueryData<Message[]>(key, mergeMessages(known, [message]));
            if (hasGap(known, message)) void catchUp(client, workspaceId, message.conversationId).catch(() => undefined);
          }
          break;
        }
        case 'conversation.created':
          void client.invalidateQueries({ queryKey: listKey(workspaceId) });
          break;
        case 'conversation.updated':
          applyConversationPatch(client, workspaceId, data.conversation as ConversationPatch);
          break;
        case 'typing': {
          const actor = data.actor as { type: string; id: string };
          const entry = { conversationId: String(data.conversationId), actorType: actor.type, actorId: actor.id };
          setTyping((current) => [...current.filter((t) => t.actorId !== entry.actorId), entry]);
          setTimeout(() => setTyping((current) => current.filter((t) => t !== entry)), TYPING_EXPIRES_MS);
          break;
        }
        case 'presence.member':
          setOnline(setMembersOnline, String(data.memberId), data.online === true);
          break;
        case 'presence.visitor':
          setOnline(setVisitorsOnline, String(data.conversationId), data.online === true);
          break;
        default:
        // Clients ignore what they do not know, because clients and servers upgrade independently.
      }
    };

    const connection = createRealtime(
      { getTicket: () => api.createRealtimeTicket(workspaceId), openSocket: (url) => new WebSocket(url) as never },
      {
        onStatus: setStatus,
        onFrame,
        onConnected: () => {
          // Anything may have happened while this was away.
          void client.invalidateQueries({ queryKey: listKey(workspaceId) });
          if (selectedRef.current) void catchUp(client, workspaceId, selectedRef.current).catch(() => undefined);
        },
        onRevoked: () => void client.invalidateQueries({ queryKey: ['me'] }),
      },
    );
    realtime.current = connection;
    connection.start();
    return () => {
      connection.stop();
      realtime.current = null;
    };
  }, [client, workspaceId, selectedRef]);

  const polling = status === 'polling';
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void client.invalidateQueries({ queryKey: listKey(workspaceId) });
      if (selectedRef.current) void catchUp(client, workspaceId, selectedRef.current).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [client, workspaceId, polling, selectedRef]);

  return { status, typing, visitorsOnline, membersOnline, realtime };
}

function ConnectionNotice({ status }: { status: RealtimeStatus }) {
  if (status === 'connected' || status === 'connecting') return null;
  return (
    <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
      {status === 'polling' ? 'Live updates are unavailable, so this page refreshes every 30 seconds. Sending still works.' : 'Reconnecting. Sending still works.'}
    </p>
  );
}

function ConversationList(props: { workspaceId: string; memberId: string; selected: string | null; onSelect: (id: string) => void; visitorsOnline: ReadonlySet<string>; hidden: boolean }) {
  const { workspaceId, memberId, selected, onSelect, visitorsOnline } = props;
  const [status, setStatus] = useState<Conversation['status']>('open');
  const [assignee, setAssignee] = useState<'all' | 'me' | 'none'>('all');
  const filter: InboxFilter = { status, assignee: assignee === 'all' ? undefined : assignee === 'me' ? memberId : 'none' };
  const list = useInfiniteQuery({
    queryKey: [...listKey(workspaceId), filter],
    queryFn: ({ pageParam }) => api.listConversations(workspaceId, { status: filter.status, assignee: filter.assignee, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section aria-label="Conversations" className={`min-w-0 space-y-3 md:block md:w-80 md:shrink-0 ${props.hidden ? 'hidden' : ''}`}>
      <div className="flex gap-2">
        <select className="field" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Conversation['status'])}>
          {STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <select className="field" aria-label="Assigned to" value={assignee} onChange={(e) => setAssignee(e.target.value as typeof assignee)}>
          <option value="all">Everyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
        </select>
      </div>
      {list.error ? <p className="error" role="alert">{errorMessage(list.error)}</p> : null}
      {list.isPending && <p className="text-sm" role="status">Loading…</p>}
      {list.data && rows.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No conversations here.</p>}
      <ul className="space-y-1">
        {rows.map((row) => {
          const unread = unreadCount(row);
          return (
            <li key={row.id}>
              <button
                className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${selected === row.id ? 'bg-slate-200 dark:bg-slate-800' : ''}`}
                aria-current={selected === row.id ? 'true' : undefined}
                onClick={() => onSelect(row.id)}
              >
                <span className={`size-2 shrink-0 rounded-full ${visitorsOnline.has(row.id) ? 'bg-green-600' : 'bg-transparent'}`} aria-hidden="true" />
                <span className={`min-w-0 flex-1 truncate ${unread > 0 ? 'font-semibold' : ''}`}>{label(row)}</span>
                {row.priority === 'urgent' || row.priority === 'high' ? <span className="text-xs font-medium text-red-700 dark:text-red-400">{row.priority}</span> : null}
                {unread > 0 && <span className="rounded-full bg-blue-700 px-2 text-xs text-white">{unread}<span className="sr-only"> unread</span></span>}
              </button>
            </li>
          );
        })}
      </ul>
      {list.hasNextPage && <button className="button-quiet w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</button>}
    </section>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const note = message.visibility === 'internal';
  const fromTeam = message.sender.type === 'member';
  const sender = message.sender.type === 'visitor' ? 'Visitor' : message.sender.type === 'system' ? 'System' : (message.sender.displayName ?? 'Agent');
  return (
    <li className={`flex ${fromTeam ? 'justify-end' : 'justify-start'}`} data-seq={message.seq}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${note ? 'border border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100' : fromTeam ? 'bg-blue-700 text-white' : 'bg-slate-200 dark:bg-slate-800'}`}>
        <div className="mb-1 text-xs opacity-80">
          {note ? `Internal note from ${sender}. The visitor cannot see this.` : sender} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        <div className="break-words whitespace-pre-wrap">{message.content}</div>
      </div>
    </li>
  );
}

function Composer(props: { workspaceId: string; conversationId: string; drafts: Map<string, string>; realtime: { current: Realtime | null } }) {
  const { workspaceId, conversationId, drafts, realtime } = props;
  const client = useQueryClient();
  const [draft, setDraftState] = useState(() => drafts.get(conversationId) ?? '');
  const [mode, setMode] = useState<'text' | 'internal_note'>('text');
  const lastTyping = useRef(0);
  // Kept across failures, so that a retry of the same words cannot send them twice.
  const attempt = useRef<{ id: string; content: string; type: string } | null>(null);
  const setDraft = (value: string) => {
    drafts.set(conversationId, value);
    setDraftState(value);
  };
  const send = useMutation({
    mutationFn: (input: { id: string; content: string; type: 'text' | 'internal_note' }) => api.sendMessage(workspaceId, conversationId, { clientMessageId: input.id, type: input.type, content: input.content }),
    onSuccess: (message) => {
      attempt.current = null;
      client.setQueryData<Message[]>(threadKey(workspaceId, conversationId), (known) => mergeMessages(known ?? [], [message]));
      // This send moved the conversation's version, and the socket may be down.
      void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) });
      setDraft('');
    },
  });
  const submit = () => {
    const content = draft.trim();
    if (!content || send.isPending) return;
    if (attempt.current?.content !== content || attempt.current.type !== mode) attempt.current = { id: crypto.randomUUID(), content, type: mode };
    send.mutate({ id: attempt.current.id, content, type: mode });
  };
  const note = mode === 'internal_note';
  return (
    <form
      className={`space-y-2 rounded-lg border p-3 ${note ? 'border-amber-400 bg-amber-50 dark:bg-amber-950' : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2" role="group" aria-label="Kind of message">
        <button type="button" className={note ? 'button-quiet' : 'button'} aria-pressed={!note} onClick={() => setMode('text')}>Reply</button>
        <button type="button" className={note ? 'button' : 'button-quiet'} aria-pressed={note} onClick={() => setMode('internal_note')}>Internal note</button>
      </div>
      <textarea
        className="field"
        rows={3}
        maxLength={16000}
        aria-label={note ? 'Internal note' : 'Reply'}
        placeholder={note ? 'Only your team can see this.' : 'Write a reply. Enter sends, and Shift+Enter starts a new line.'}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const now = Date.now();
          if (event.target.value && shouldSendTyping(lastTyping.current, now)) {
            lastTyping.current = now;
            realtime.current?.send('typing.set', { conversationId, isTyping: true, internal: note });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {send.error ? <p className="error" role="alert">Not sent. {errorMessage(send.error)} Your words are still here.</p> : null}
      <button className="button" disabled={send.isPending || !draft.trim()}>{note ? 'Add note' : 'Send reply'}</button>
    </form>
  );
}

function Thread(props: { workspaceId: string; conversationId: string; members: Member[]; typing: TypingEntry[]; visitorOnline: boolean; drafts: Map<string, string>; realtime: { current: Realtime | null }; onBack: () => void }) {
  const { workspaceId, conversationId, members, typing, drafts, realtime } = props;
  const client = useQueryClient();
  const key = threadKey(workspaceId, conversationId);
  const conversation = useQuery({ queryKey: detailKey(workspaceId, conversationId), queryFn: () => api.getConversation(workspaceId, conversationId) });
  const messages = useQuery({
    queryKey: key,
    // Merged, so that reading the newest page again keeps earlier pages already loaded.
    queryFn: async () => mergeMessages(client.getQueryData<Message[]>(key) ?? [], (await api.listMessages(workspaceId, conversationId, { beforeSeq: NEWEST })).data),
  });
  const rows = messages.data ?? [];
  const [noMoreHistory, setNoMoreHistory] = useState(false);
  const older = useMutation({
    mutationFn: () => api.listMessages(workspaceId, conversationId, { beforeSeq: rows[0]!.seq }),
    onSuccess: ({ data }) => {
      if (data.length === 0) setNoMoreHistory(true);
      client.setQueryData<Message[]>(key, (known) => mergeMessages(known ?? [], data));
    },
  });
  const update = useMutation({
    mutationFn: (change: Omit<Parameters<typeof api.updateConversation>[2], 'expectedVersion'>) => api.updateConversation(workspaceId, conversationId, { ...change, expectedVersion: conversation.data!.version }),
    onSuccess: (updated) => applyConversationPatch(client, workspaceId, updated),
    onError: () => void client.invalidateQueries({ queryKey: detailKey(workspaceId, conversationId) }),
  });

  // Stay at the newest message if already there, and never pull someone away from reading history.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const newest = highestSeq(rows);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [newest]);

  const last = conversation.data?.lastMessageSeq ?? 0;
  const reported = useRef(0);
  const markRead = useCallback(() => {
    if (document.visibilityState !== 'visible' || newest === 0 || newest <= reported.current || (conversation.data?.lastReadSeq ?? 0) >= newest) return;
    reported.current = newest;
    api
      .markConversationRead(workspaceId, conversationId, newest)
      .then(() => {
        eachList(client, workspaceId, (data) => markReadInPages(data, conversationId, newest));
        client.setQueryData<Conversation>(detailKey(workspaceId, conversationId), (current) => (current ? { ...current, lastReadSeq: Math.max(current.lastReadSeq, newest) } : current));
      })
      .catch(() => {
        // It stays unread, and the next look tries again.
        reported.current = 0;
      });
  }, [client, conversation.data?.lastReadSeq, conversationId, newest, workspaceId]);
  useEffect(() => {
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [markRead, last]);

  const memberName = (id: string) => members.find((m) => m.id === id)?.name ?? 'A teammate';
  const typists = typing.filter((t) => t.conversationId === conversationId).map((t) => (t.actorType === 'visitor' ? 'The visitor' : memberName(t.actorId)));
  const data = conversation.data;
  const conflict = update.error instanceof ApiError && update.error.status === 409;
  return (
    <section aria-label="Conversation" className="flex min-w-0 flex-1 flex-col gap-3">
      <button className="button-quiet self-start md:hidden" onClick={props.onBack}>Back to the list</button>
      {data && (
        <header className="space-y-2">
          <h2 className="font-medium">
            {label(data)} <span className="text-xs font-normal text-slate-600 dark:text-slate-400">{props.visitorOnline ? 'Online now' : ''}</span>
          </h2>
          <div className="flex flex-wrap gap-2">
            <select className="field w-auto" aria-label="Conversation status" value={data.status} disabled={update.isPending} onChange={(e) => update.mutate({ status: e.target.value as Conversation['status'] })}>
              {STATUSES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <select className="field w-auto" aria-label="Priority" value={data.priority} disabled={update.isPending} onChange={(e) => update.mutate({ priority: e.target.value as Conversation['priority'] })}>
              {PRIORITIES.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <select className="field w-auto" aria-label="Assignee" value={data.assignedMemberId ?? ''} disabled={update.isPending} onChange={(e) => update.mutate({ assignedMemberId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {members.filter((m) => m.status === 'active' || m.id === data.assignedMemberId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {update.error ? <p className="error" role="alert">{conflict ? 'This conversation just changed. Check it and try again.' : errorMessage(update.error)}</p> : null}
        </header>
      )}
      {conversation.error ? <p className="error" role="alert">{errorMessage(conversation.error)}</p> : null}
      {messages.error ? <p className="error" role="alert">{errorMessage(messages.error)}</p> : null}
      <div
        ref={scroller}
        className="card max-h-[60vh] min-h-64 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {rows.length > 0 && (rows[0]?.seq ?? 1) > 1 && !noMoreHistory && <button className="button-quiet mb-3" disabled={older.isPending} onClick={() => older.mutate()}>Load earlier messages</button>}
        <ol className="space-y-2" aria-label="Messages">
          {rows.map((message) => <MessageBubble key={message.id} message={message} />)}
        </ol>
      </div>
      <p className="min-h-5 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">{typists.length > 0 ? `${typists.join(', ')} ${typists.length > 1 ? 'are' : 'is'} typing…` : ''}</p>
      <Composer key={conversationId} workspaceId={workspaceId} conversationId={conversationId} drafts={drafts} realtime={realtime} />
    </section>
  );
}

export function InboxPanel({ membership, members }: { membership: Membership; members: Member[] }) {
  const workspaceId = membership.workspace.id;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const drafts = useRef(new Map<string, string>());
  const { status, typing, visitorsOnline, membersOnline, realtime } = useInboxSocket(workspaceId, selectedRef);
  const online = members.filter((m) => m.id !== membership.memberId && membersOnline.has(m.id));
  return (
    <div className="space-y-4">
      <ConnectionNotice status={status} />
      {online.length > 0 && <p className="text-xs text-slate-600 dark:text-slate-400">Also online: {online.map((m) => m.name).join(', ')}</p>}
      <div className="flex gap-6">
        <ConversationList workspaceId={workspaceId} memberId={membership.memberId} selected={selected} onSelect={setSelected} visitorsOnline={visitorsOnline} hidden={selected !== null} />
        {selected ? (
          <Thread
            key={selected}
            workspaceId={workspaceId}
            conversationId={selected}
            members={members}
            typing={typing}
            visitorOnline={visitorsOnline.has(selected)}
            drafts={drafts.current}
            realtime={realtime}
            onBack={() => setSelected(null)}
          />
        ) : (
          <p className="hidden flex-1 text-sm text-slate-600 md:block dark:text-slate-400">Choose a conversation.</p>
        )}
      </div>
    </div>
  );
}
