/** The panel. Message content is only ever a text node: nothing here renders HTML from anyone. */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ChatState, Controller } from './controller';
import { hasOlder, unreadCount, type ChatMessage } from './state';
import { STRINGS as S } from './strings';

function useChat(controller: Controller): ChatState {
  const [state, setState] = useState(controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(() => setState(controller.getState()));
  }, [controller]);
  return state;
}

function Message({ message, state, onRetry }: { message: ChatMessage; state: string | null; onRetry: () => void }) {
  const kind = message.system ? 'system' : message.mine ? 'mine' : 'theirs';
  return (
    <div class={`oc-msg ${kind} ${message.status}`}>
      {kind === 'theirs' && <p class="oc-who">{message.senderName ?? S.team}</p>}
      <div class="oc-bubble" dir="auto">{message.content}</div>
      {message.status === 'failed' ? (
        <span class="oc-state bad">
          {S.failed} <button type="button" class="oc-link" onClick={onRetry}>{S.retry}</button>
        </span>
      ) : (
        state && <span class="oc-state">{state}</span>
      )}
    </div>
  );
}

function ProfileForm({ controller, required }: { controller: Controller; required: boolean }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <form
      class="oc-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setFailed(false);
        controller
          .saveProfile({ ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) })
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      }}
    >
      <p>{required ? S.profileTitleRequired : S.profileTitleOffered}</p>
      <label>
        {S.name}
        <input class="oc-input" autocomplete="name" maxLength={100} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        {S.email}
        <input class="oc-input" type="email" autocomplete="email" required maxLength={254} value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
      </label>
      {failed && <span class="oc-state bad" role="alert">{S.profileFailed}</span>}
      <div class="oc-actions">
        <button class="oc-send" disabled={busy}>{required ? S.start : S.save}</button>
        {!required && <button type="button" class="oc-link" onClick={() => controller.dismissProfile()}>{S.notNow}</button>}
      </div>
    </form>
  );
}

function Composer({ controller }: { controller: Controller }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    void controller.send(text);
    setText('');
  };
  return (
    <form
      class="oc-compose"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        class="oc-input"
        rows={1}
        aria-label={S.compose}
        placeholder={S.placeholder}
        maxLength={10000}
        value={text}
        onInput={(event) => {
          setText(event.currentTarget.value);
          controller.typed();
        }}
        onKeyDown={(event) => {
          // Not while an input method is composing, where Enter chooses a word.
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button class="oc-send" disabled={!text.trim()}>{S.send}</button>
    </form>
  );
}

export function App({ controller, button }: { controller: Controller; button: HTMLButtonElement }) {
  const state = useChat(controller);
  const panel = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const unread = state.open ? 0 : unreadCount(state.messages, state.readSeq);

  // The button belongs to the loader, so that it never redraws and never loses focus.
  useEffect(() => {
    button.setAttribute('aria-expanded', String(state.open));
    button.setAttribute('aria-label', state.open ? S.close : unread > 0 ? S.unread(unread) : S.open);
    const badge = button.querySelector<HTMLElement>('.oc-badge');
    if (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
  }, [button, state.open, unread]);

  useEffect(() => {
    if (state.open) panel.current?.querySelector<HTMLElement>('input, textarea')?.focus();
  }, [state.open]);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [state.messages, state.open, state.typing]);

  if (state.phase === 'hidden') return null;

  const mine = state.messages.filter((m) => m.mine && m.seq !== null);
  const newestMine = mine[mine.length - 1];
  const stateOf = (message: ChatMessage) => {
    if (message.status === 'sending') return S.sending;
    if (message !== newestMine) return null;
    return message.seq! <= state.agentReadSeq ? S.seen : S.sent;
  };
  const presence = state.connection === 'reconnecting' || state.connection === 'polling' ? S.reconnecting : state.availability === 'online' ? S.online : state.availability === 'offline' ? S.offline : '';
  const welcome = state.settings?.welcomeMessage;

  return (
    <div
      ref={panel}
      class="oc-panel"
      role="dialog"
      aria-label={S.title}
      hidden={!state.open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          controller.setOpen(false);
          button.focus();
        }
      }}
    >
      <header class="oc-head">
        <div>
          <h2>{S.title}</h2>
          <p role="status">{presence}</p>
        </div>
        <button
          type="button"
          class="oc-x"
          aria-label={S.close}
          onClick={() => {
            controller.setOpen(false);
            button.focus();
          }}
        >
          ×
        </button>
      </header>
      <div
        ref={log}
        class="oc-log"
        role="log"
        aria-label={S.messages}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {hasOlder(state.messages) && (
          <div class="oc-older">
            <button type="button" class="oc-link" disabled={state.loadingOlder} onClick={() => void controller.loadOlder().catch(() => undefined)}>{S.earlier}</button>
          </div>
        )}
        {welcome && (
          <div class="oc-msg theirs">
            <div class="oc-bubble" dir="auto">{welcome}</div>
          </div>
        )}
        {state.messages.map((message) => (
          <Message key={message.key} message={message} state={stateOf(message)} onRetry={() => void controller.retry(message.key)} />
        ))}
      </div>
      <div class="oc-typing" aria-live="polite">{state.typing ? S.typing(state.typing.displayName) : ''}</div>
      {state.notice && <p class="oc-note bad" role="alert">{state.notice === 'rate_limited' ? S.rateLimited : S.unavailable}</p>}
      {state.conversation?.status === 'resolved' && <p class="oc-note">{S.resolved}</p>}
      {state.profile === 'offered' && state.messages.some((m) => m.mine) && <ProfileForm controller={controller} required={false} />}
      {state.profile === 'required' ? <ProfileForm controller={controller} required /> : <Composer controller={controller} />}
    </div>
  );
}
