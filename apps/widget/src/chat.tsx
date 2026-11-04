/** The chat bundle: loaded by the loader, which hands itself over on the script element that loaded this. */
import { render } from 'preact';
import { createApi, type Session } from './api';
import { App } from './app';
import { createController } from './controller';
import { addStyles, applyColor, colorKey, type HandoffScript } from './handoff';
import { createStorage } from './storage';
import { CHAT_CSS } from './styles';

const handoff = (document.currentScript as HandoffScript | null)?.openchat;

if (handoff) {
  const storage = createStorage(handoff.websiteKey, handoff.consentPending);
  const api = createApi({
    apiUrl: handoff.apiUrl,
    websiteKey: handoff.websiteKey,
    loadSession: () => storage.get().session ?? null,
    saveSession: (session: Session) => storage.set({ session }),
  });
  const controller = createController({
    api,
    storage,
    openSocket: (url) => new WebSocket(url) as never,
    isVisible: () => document.visibilityState === 'visible',
  });

  addStyles(handoff.shadow, CHAT_CSS);
  const root = document.createElement('div');
  handoff.shadow.appendChild(root);

  handoff.chat = {
    setOpen: (open) => controller.setOpen(open),
    grantConsent: () => storage.grantConsent(),
  };
  handoff.button.addEventListener('click', () => controller.setOpen(!controller.getState().open));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') controller.onVisible();
  });

  render(<App controller={controller} button={handoff.button} />, root);
  if (handoff.openOnStart) controller.setOpen(true);

  let color: string | undefined;
  controller.subscribe(() => {
    const next = controller.getState().settings?.primaryColor;
    if (!next || next === color) return;
    color = next;
    applyColor(handoff.host, next);
    storage.remember(colorKey(handoff.websiteKey), next);
  });

  void controller.start().then((allowed) => {
    if (allowed) return;
    controller.stop();
    handoff.host.remove();
    // The site's developer needs to know why the widget went away.
    console.warn('OpenChat: this page is not allowed to use this website key. Check the allowed origins.');
  });
}
