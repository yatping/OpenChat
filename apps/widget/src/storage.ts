/**
 * Remembers one visitor per website key. Storage can be refused or absent, and then the visitor is anonymous for
 * this page only. With consent pending, everything stays in session storage, which ends with the tab.
 */
import type { Session } from './api';

export interface Stored {
  session?: Session;
  profileDone?: boolean;
  profileDismissed?: boolean;
}

const read = (area: () => Storage, key: string): Stored | null => {
  try {
    const text = area().getItem(key);
    return text ? (JSON.parse(text) as Stored) : null;
  } catch {
    return null;
  }
};

const write = (area: () => Storage, key: string, value: Stored) => {
  try {
    area().setItem(key, JSON.stringify(value));
  } catch {
    // The copy in memory carries on.
  }
};

const remove = (area: () => Storage, key: string) => {
  try {
    area().removeItem(key);
  } catch {
    // Nothing to do.
  }
};

export function createStorage(websiteKey: string, initiallyPending: boolean, areas: { local: () => Storage; session: () => Storage } = { local: () => localStorage, session: () => sessionStorage }) {
  const key = `openchat:${websiteKey}`;
  let pending = initiallyPending;
  let memory: Stored = (pending ? null : read(areas.local, key)) ?? read(areas.session, key) ?? {};
  const save = () => write(pending ? areas.session : areas.local, key, memory);
  return {
    get: () => memory,
    set(change: Stored) {
      memory = { ...memory, ...change };
      save();
    },
    grantConsent() {
      if (!pending) return;
      pending = false;
      // An identity already in use continues, and one remembered from before does not replace it.
      memory = { ...read(areas.local, key), ...memory };
      save();
      remove(areas.session, key);
    },
    /** A preference with nothing personal in it. It is still not stored before consent. */
    remember(itemKey: string, value: string) {
      if (pending) return;
      try {
        areas.local().setItem(itemKey, value);
      } catch {
        // Only costs a moment of the default colour on the next page.
      }
    },
  };
}

export type WidgetStorage = ReturnType<typeof createStorage>;
