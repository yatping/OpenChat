/**
 * Where a tapped notification leads. It waits here through sign-in or a change of workspace, each of which remounts
 * everything below the connection. Every value in a payload came over the network, so each one is checked.
 */
export interface Destination {
  installationId: string;
  workspaceId: string;
  conversationId: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseDestination(payload: unknown): Destination | null {
  const oc = (payload as { oc?: Record<string, unknown> } | null | undefined)?.oc;
  if (!oc || oc.v !== 1) return null;
  const { installationId, workspaceId, conversationId } = oc;
  if (typeof installationId !== 'string' || typeof workspaceId !== 'string' || typeof conversationId !== 'string') return null;
  if (![installationId, workspaceId, conversationId].every((id) => ID.test(id))) return null;
  return { installationId, workspaceId, conversationId };
}

let pending: Destination | null = null;
const listeners = new Set<() => void>();

export const destination = {
  get: () => pending,
  set(next: Destination | null) {
    pending = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/** What is on screen now, so that a notification about it does not also appear over it. */
let onScreen: string | null = null;
export const setConversationOnScreen = (conversationId: string | null) => {
  onScreen = conversationId;
};
export const shouldShowInForeground = (payload: unknown) => parseDestination(payload)?.conversationId !== onScreen || onScreen === null;
