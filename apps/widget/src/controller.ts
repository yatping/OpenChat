/**
 * Everything the chat does, with no UI, so that tests can drive it. D1 is the record: a socket only says that
 * something may have changed, and every path that could have missed something goes back through REST.
 * Rules are in docs/architecture/realtime.md.
 */
import { createRealtime, type Realtime, type RealtimeDeps, type RealtimeStatus, type ServerFrame } from '@openchat/api-client/realtime';
import { ChallengeFailed } from './turnstile';
import { ApiError, type Api, type Bootstrap, type VisitorConversation, type VisitorMessage } from './api';
import { hasOlder, lastSeq, mergeMessages, newClientMessageId, pendingMessage, retryDelayMs, unreadCount, type ChatMessage } from './state';
import type { WidgetStorage } from './storage';

const PAGE_SIZE = 50;
const POLL_MS = 15_000;
const TYPING_SEND_MS = 3000;
const TYPING_SHOW_MS = 5000;
const AUTOMATIC_RETRIES = 3;
const STALE_BOOTSTRAP_MS = 60_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type Settings = Bootstrap['settings'];

export interface ChatState {
  /** Hidden: this page may not use this website key, and the widget removes itself. */
  phase: 'loading' | 'ready' | 'hidden';
  settings: Settings | null;
  availability: 'online' | 'offline' | null;
  open: boolean;
  conversation: Pick<VisitorConversation, 'id' | 'status'> | null;
  messages: ChatMessage[];
  /** How far this visitor has read. */
  readSeq: number;
  /** How far any agent has read. */
  agentReadSeq: number;
  connection: RealtimeStatus | null;
  typing: { displayName: string | null } | null;
  loadingOlder: boolean;
  profile: 'none' | 'required' | 'offered';
  notice: 'rate_limited' | 'unavailable' | 'bad_file' | 'challenge' | null;
  turnstileSiteKey: string | null;
}

export interface ControllerDeps {
  api: Api;
  storage: WidgetStorage;
  openSocket: RealtimeDeps['openSocket'];
  isVisible: () => boolean;
  now?: () => number;
  crypto?: Parameters<typeof newClientMessageId>[0];
  realtime?: typeof createRealtime;
}

export function createController(deps: ControllerDeps) {
  const now = deps.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: ChatState = {
    phase: 'loading',
    settings: null,
    availability: null,
    open: false,
    conversation: null,
    messages: [],
    readSeq: 0,
    agentReadSeq: 0,
    connection: null,
    typing: null,
    loadingOlder: false,
    profile: 'none',
    notice: null,
    turnstileSiteKey: null,
  };
  const update = (change: Partial<ChatState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };

  let realtime: Realtime | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTypingSent = 0;
  let reportedRead = 0;
  let bootstrappedAt = 0;
  /** Sends run one at a time: order matters, and the first one may be creating the conversation. */
  let sendQueue: Promise<void> = Promise.resolve();
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  /** Files on their way, by message key, so that Try again neither loses one nor uploads it twice. */
  const outgoing = new Map<string, { file: File; attachmentId: string | null }>();

  const profileNeed = (settings: Settings | null): ChatState['profile'] => {
    const stored = deps.storage.get();
    if (stored.profileDone || !settings) return 'none';
    if (settings.collectEmail === 'required') return 'required';
    return settings.collectEmail === 'optional' && !stored.profileDismissed ? 'offered' : 'none';
  };

  const applyMessages = (incoming: VisitorMessage[]) => {
    if (incoming.length > 0) update({ messages: mergeMessages(state.messages, incoming) });
  };

  const reportRead = () => {
    const seq = lastSeq(state.messages);
    if (!state.open || !deps.isVisible() || !state.conversation || seq <= state.readSeq) return;
    // A visitor's own message needs no write: nothing new was read, and it cannot count as unread.
    const anythingNew = unreadCount(state.messages, state.readSeq) > 0;
    update({ readSeq: seq });
    if (!anythingNew || seq <= reportedRead) return;
    reportedRead = seq;
    deps.api.markRead(state.conversation.id, seq).catch(() => {
      // The next look tries again.
      reportedRead = 0;
    });
  };

  /** Fetches everything after what is held, and also what agents have read. Concurrent callers share one pass, plus one more if asked. */
  const sync = (): Promise<void> => {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        const conversation = state.conversation;
        if (!conversation) return;
        for (;;) {
          const page = await deps.api.listMessages(conversation.id, { afterSeq: lastSeq(state.messages), limit: PAGE_SIZE });
          applyMessages(page);
          if (page.length < PAGE_SIZE) break;
        }
        const fresh = (await deps.api.listConversations()).find((c) => c.id === conversation.id);
        if (fresh) update({ conversation: { id: fresh.id, status: fresh.status }, agentReadSeq: Math.max(state.agentReadSeq, fresh.agentReadSeq) });
      } while (syncAgain);
    })()
      .catch(() => {
        // Polling or the next reconnection comes back to this.
      })
      .finally(() => {
        syncing = null;
        reportRead();
      });
    return syncing;
  };

  const stopTyping = () => {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = null;
    if (state.typing) update({ typing: null });
  };

  const onFrame = (frame: ServerFrame) => {
    const data = frame.data;
    const conversationId = state.conversation?.id;
    switch (frame.type) {
      case 'message.created': {
        const message = data.message as VisitorMessage;
        if (message.conversationId !== conversationId) return;
        const missed = message.seq > lastSeq(state.messages) + 1;
        if (message.sender.type !== 'visitor') stopTyping();
        applyMessages([message]);
        // Gapless, so a jump means a frame was lost. REST has it.
        if (missed) void sync();
        else reportRead();
        return;
      }
      case 'conversation.status':
        if (data.conversationId === conversationId && state.conversation) update({ conversation: { id: state.conversation.id, status: data.status as VisitorConversation['status'] } });
        return;
      case 'conversation.read':
        if (data.conversationId === conversationId) update({ agentReadSeq: Math.max(state.agentReadSeq, Number(data.readSeq) || 0) });
        return;
      case 'typing':
        if (data.conversationId !== conversationId) return;
        update({ typing: { displayName: typeof data.displayName === 'string' ? data.displayName : null } });
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(stopTyping, TYPING_SHOW_MS);
        return;
      case 'availability':
        update({ availability: data.availability === 'online' ? 'online' : 'offline' });
        return;
      case 'sync.required':
        void sync();
        return;
      default:
        // A newer server may send more than this version knows.
        return;
    }
  };

  const setPolling = (on: boolean) => {
    if (on && !pollTimer) pollTimer = setInterval(() => void sync(), POLL_MS);
    if (!on && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const connect = () => {
    const conversationId = state.conversation?.id;
    if (!conversationId || realtime) return;
    realtime = (deps.realtime ?? createRealtime)(
      { getTicket: () => deps.api.ticket(conversationId), openSocket: deps.openSocket },
      {
        onStatus(connection) {
          update({ connection });
          setPolling(connection === 'polling');
        },
        onFrame,
        onConnected: () => void sync(),
        onRevoked: () => undefined,
      },
    );
    realtime.start();
  };

  /** A socket for a conversation still in progress, or for anyone looking at an old one. */
  const connectIfWanted = () => {
    const status = state.conversation?.status;
    if (status && (state.open || status === 'open' || status === 'pending')) connect();
  };

  const adoptConversation = (conversation: VisitorConversation) => {
    reportedRead = conversation.readSeq;
    update({ conversation: { id: conversation.id, status: conversation.status }, readSeq: conversation.readSeq, agentReadSeq: conversation.agentReadSeq });
  };

  /** A returning visitor. A first-time visitor gets no session, and costs no rows, until they say something. */
  const resume = async () => {
    if (!deps.api.hasSession()) return;
    const conversation = (await deps.api.listConversations()).find((c) => c.status !== 'archived');
    if (!conversation) return;
    adoptConversation(conversation);
    if (conversation.lastSeq > 0) {
      applyMessages(await deps.api.listMessages(conversation.id, { beforeSeq: conversation.lastSeq + 1, limit: PAGE_SIZE }));
    }
    connectIfWanted();
    reportRead();
  };

  const markMessage = (key: string, change: Partial<ChatMessage>) => {
    update({ messages: state.messages.map((m) => (m.key === key && m.status !== 'sent' ? { ...m, ...change } : m)) });
  };

  const isTransient = (error: unknown) => !(error instanceof ChallengeFailed) && (!(error instanceof ApiError) || error.status >= 500);
  const isChallengeRefusal = (error: unknown) => error instanceof ChallengeFailed || (error instanceof ApiError && error.code === 'turnstile_failed');

  const deliver = async (message: ChatMessage) => {
    const input = { clientMessageId: message.clientMessageId!, content: message.content };
    const upload = outgoing.get(message.key);
    for (let attempt = 0; ; attempt++) {
      try {
        if (upload) {
          // The widget only offers a file once there is a conversation. It can only be gone after that.
          if (!state.conversation) throw new ApiError(404, null, null);
          upload.attachmentId ??= (await deps.api.uploadAttachment(state.conversation.id, upload.file)).id;
          applyMessages([await deps.api.sendMessage(state.conversation.id, { ...input, attachmentIds: [upload.attachmentId] })]);
          outgoing.delete(message.key);
        } else if (state.conversation) {
          applyMessages([await deps.api.sendMessage(state.conversation.id, input)]);
        } else {
          // The same client ID reaches the same conversation, so a retry after a lost response cannot start a second.
          const started = await deps.api.createConversation(input);
          adoptConversation(started);
          applyMessages([started.message]);
          // Connecting catches up too, and the visitor need not wait for it.
          connectIfWanted();
        }
        if (state.notice) update({ notice: null });
        return;
      } catch (error) {
        if (upload && error instanceof ApiError && !isTransient(error) && error.status !== 429) {
          markMessage(message.key, { status: 'failed' });
          update({ notice: 'bad_file' });
          return;
        }
        if (error instanceof ApiError && error.status === 404 && state.conversation) {
          // The conversation is gone, or this is a new identity. The words go into a new one.
          realtime?.stop();
          realtime = null;
          update({ conversation: null, connection: null });
          continue;
        }
        if (isTransient(error) && attempt < AUTOMATIC_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
          continue;
        }
        markMessage(message.key, { status: 'failed' });
        update({ notice: isChallengeRefusal(error) ? 'challenge' : error instanceof ApiError && error.status === 429 ? 'rate_limited' : null });
        return;
      }
    }
  };

  const enqueue = (message: ChatMessage) => {
    sendQueue = sendQueue.then(() => deliver(message));
    return sendQueue;
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Resolves to false when this page may not use this website, so that the widget can remove itself. */
    async start(): Promise<boolean> {
      // Now, so that opening the panel during this does not ask a second time.
      bootstrappedAt = now();
      try {
        const bootstrap = await deps.api.bootstrap();
        update({ phase: 'ready', settings: bootstrap.settings, availability: bootstrap.availability, profile: profileNeed(bootstrap.settings), turnstileSiteKey: bootstrap.turnstileSiteKey ?? null });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          update({ phase: 'hidden' });
          return false;
        }
        // A bad moment for the network. Opening the panel tries again.
        bootstrappedAt = 0;
        update({ phase: 'ready', notice: 'unavailable' });
        return true;
      }
      await resume().catch(() => undefined);
      return true;
    },

    setOpen(open: boolean) {
      if (open === state.open) return;
      update({ open });
      if (!open) return;
      if (now() - bootstrappedAt > STALE_BOOTSTRAP_MS) {
        deps.api
          .bootstrap()
          .then((bootstrap) => {
            bootstrappedAt = now();
            update({ settings: bootstrap.settings, availability: bootstrap.availability, profile: profileNeed(bootstrap.settings), notice: null, turnstileSiteKey: bootstrap.turnstileSiteKey ?? null });
            // Loading failed earlier, so nothing was restored either.
            return state.conversation ? undefined : resume();
          })
          .catch(() => undefined);
      }
      connectIfWanted();
      reportRead();
    },

    onVisible() {
      reportRead();
      // A phone may have frozen this tab, with its timers, for as long as it liked.
      if (state.conversation) void sync();
    },

    send(content: string) {
      const text = content.trim();
      if (!text) return Promise.resolve();
      const message = pendingMessage(newClientMessageId(deps.crypto ?? crypto), text);
      update({ messages: [...state.messages, message] });
      return enqueue(message);
    },

    /** Offered only once there is a conversation, which also means that a page view cannot be used to store files. */
    sendFile(file: File) {
      if (!state.conversation) return Promise.resolve();
      if (file.size > MAX_FILE_BYTES || file.size === 0) {
        update({ notice: 'bad_file' });
        return Promise.resolve();
      }
      const message = pendingMessage(newClientMessageId(deps.crypto ?? crypto), '', file.name);
      outgoing.set(message.key, { file, attachmentId: null });
      update({ messages: [...state.messages, message], notice: null });
      return enqueue(message);
    },

    fetchAttachment: (url: string) => deps.api.fetchAttachment(url),

    /** The same client ID, so a message that did arrive is not sent twice. */
    retry(key: string) {
      const message = state.messages.find((m) => m.key === key && m.status === 'failed');
      if (!message) return Promise.resolve();
      markMessage(key, { status: 'sending' });
      return enqueue({ ...message, status: 'sending' });
    },

    typed() {
      const conversationId = state.conversation?.id;
      if (!conversationId || !realtime || now() - lastTypingSent < TYPING_SEND_MS) return;
      lastTypingSent = now();
      realtime.send('typing.set', { conversationId, isTyping: true });
    },

    async loadOlder() {
      const conversation = state.conversation;
      const first = state.messages.find((m) => m.seq !== null);
      if (!conversation || !first || state.loadingOlder || !hasOlder(state.messages)) return;
      update({ loadingOlder: true });
      try {
        applyMessages(await deps.api.listMessages(conversation.id, { beforeSeq: first.seq!, limit: PAGE_SIZE }));
      } finally {
        update({ loadingOlder: false });
      }
    },

    async saveProfile(input: { name?: string; email?: string }) {
      await deps.api.updateProfile(input);
      deps.storage.set({ profileDone: true });
      update({ profile: 'none' });
    },

    dismissProfile() {
      deps.storage.set({ profileDismissed: true });
      update({ profile: 'none' });
    },

    stop() {
      realtime?.stop();
      realtime = null;
      setPolling(false);
      stopTyping();
    },
  };
}

export type Controller = ReturnType<typeof createController>;
