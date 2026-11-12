/** The panel. Message content is only ever a text node: nothing here renders HTML from anyone. */
import { createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatState, Controller } from './controller';
import { hasOlder, unreadCount, type ChatMessage } from './state';
import { pickLocale, type Locale } from './locale';
import { formatSize, TRANSLATIONS, type Strings } from './strings';

/** The language every part of the panel speaks, chosen once in App. */
const Language = createContext<{ locale: Locale; S: Strings }>({ locale: 'en', S: TRANSLATIONS.en });

function useChat(controller: Controller): ChatState {
  const [state, setState] = useState(controller.getState());
  useEffect(() => {
    setState(controller.getState());
    return controller.subscribe(() => setState(controller.getState()));
  }, [controller]);
  return state;
}

const PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * A page's CSP may refuse a blob: picture. Then the picture goes away and the download stays. The link is put in
 * the panel, so that the host page's listeners do not see the click.
 */
function Attachment({ file, controller }: { file: ChatMessage['attachments'][number]; controller: Controller }) {
  const { locale, S } = useContext(Language);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const self = useRef<HTMLDivElement>(null);
  const previewable = file.contentType.startsWith('image/') && file.size <= PREVIEW_LIMIT_BYTES;
  useEffect(() => {
    if (!previewable) return undefined;
    let url: string | null = null;
    let gone = false;
    controller
      .fetchAttachment(file.url)
      .then((blob) => {
        if (gone) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [controller, file.url, previewable]);
  const download = () => {
    setFailed(false);
    controller
      .fetchAttachment(file.url)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename;
        self.current?.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      })
      .catch(() => setFailed(true));
  };
  return (
    <div class="oc-file" ref={self}>
      {preview && <img class="oc-image" src={preview} alt={file.filename} onError={() => setPreview(null)} />}
      <button type="button" class="oc-link" onClick={download}>{S.download(file.filename, formatSize(file.size, locale, S))}</button>
      {failed && <span class="oc-state bad" role="alert"> {S.downloadFailed}</span>}
    </div>
  );
}

function Message({ message, state, onRetry, controller }: { message: ChatMessage; state: string | null; onRetry: () => void; controller: Controller }) {
  const { S } = useContext(Language);
  const kind = message.system ? 'system' : message.mine ? 'mine' : 'theirs';
  return (
    <div class={`oc-msg ${kind} ${message.status}`}>
      {kind === 'theirs' && <p class="oc-who">{message.senderName ?? S.team}</p>}
      {message.content && <div class="oc-bubble" dir="auto">{message.content}</div>}
      {message.pendingFile && <div class="oc-file oc-state" dir="auto">{message.pendingFile}</div>}
      {message.attachments.map((file) => <Attachment key={file.id} file={file} controller={controller} />)}
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
  const { S } = useContext(Language);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
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
          .saveProfile({ ...(name.trim() ? { name: name.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}), followUpConsent: consent })
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
      <label class="oc-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.currentTarget.checked)} />
        <span>{S.followUpConsent}</span>
      </label>
      {failed && <span class="oc-state bad" role="alert">{S.profileFailed}</span>}
      <div class="oc-actions">
        <button class="oc-send" disabled={busy}>{required ? S.start : S.save}</button>
        {!required && <button type="button" class="oc-link" onClick={() => controller.dismissProfile()}>{S.notNow}</button>}
      </div>
    </form>
  );
}

function Composer({ controller, canAttach, maxChars }: { controller: Controller; canAttach: boolean; maxChars: number }) {
  const { S } = useContext(Language);
  const [text, setText] = useState('');
  const picker = useRef<HTMLInputElement>(null);
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
        maxLength={maxChars}
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
      {canAttach && (
        <>
          <button type="button" class="oc-attach" aria-label={S.attach} onClick={() => picker.current?.click()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6v11.5a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6H9v9.5a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v12.5a6 6 0 0 0 12 0V6z" /></svg>
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            aria-label={S.fileToAttach}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void controller.sendFile(file);
              event.currentTarget.value = '';
            }}
          />
        </>
      )}
      <button class="oc-send" disabled={!text.trim()}>{S.send}</button>
    </form>
  );
}

/**
 * `pageLocale` is what the host page asked for, and wins. Then the website's setting, then the page's and the
 * browser's languages. See docs/architecture/widget.md#languages.
 */
export function App({
  controller,
  button,
  challengeHost,
  pageLocale,
  pageLanguages,
}: {
  controller: Controller;
  button: HTMLButtonElement;
  challengeHost: HTMLElement;
  pageLocale?: string | undefined;
  pageLanguages: readonly string[];
}) {
  const state = useChat(controller);
  const chosen = state.settings?.language;
  const language = useMemo(() => {
    const locale = pickLocale([pageLocale, chosen === 'auto' ? undefined : chosen, ...pageLanguages]);
    return { locale, S: TRANSLATIONS[locale] };
  }, [pageLocale, chosen, pageLanguages]);
  const { locale, S } = language;
  const panel = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const unread = state.open ? 0 : unreadCount(state.messages, state.readSeq);

  // The button belongs to the loader, so that it never redraws and never loses focus.
  useEffect(() => {
    button.setAttribute('aria-expanded', String(state.open));
    button.setAttribute('aria-label', state.open ? S.close : unread > 0 ? S.unread(unread) : S.open);
    button.lang = locale;
    const badge = button.querySelector<HTMLElement>('.oc-badge');
    if (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
  }, [button, state.open, unread, S, locale]);

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
    <Language.Provider value={language}>
    <div
      ref={panel}
      lang={locale}
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
          <Message key={message.key} message={message} state={stateOf(message)} onRetry={() => void controller.retry(message.key)} controller={controller} />
        ))}
      </div>
      <div class="oc-challenge" ref={(element) => { if (element && challengeHost.parentElement !== element) element.appendChild(challengeHost); }} />
      <div class="oc-typing" aria-live="polite">{state.typing ? S.typing(state.typing.displayName) : ''}</div>
      {state.notice && <p class="oc-note bad" role="alert">{state.notice === 'rate_limited' ? S.rateLimited : state.notice === 'daily_limit' ? S.dailyLimit : state.notice === 'bad_file' ? S.badFile : state.notice === 'challenge' ? S.challengeFailed : S.unavailable}</p>}
      {state.conversation?.status === 'resolved' && <p class="oc-note">{S.resolved}</p>}
      {state.profile === 'offered' && state.messages.some((m) => m.mine) && <ProfileForm controller={controller} required={false} />}
      {state.profile === 'required' ? <ProfileForm controller={controller} required /> : <Composer controller={controller} maxChars={state.messageMaxChars} canAttach={state.conversation !== null} />}
    </div>
    </Language.Provider>
  );
}
