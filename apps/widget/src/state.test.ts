import { describe, expect, it } from 'vitest';
import type { VisitorMessage } from './api';
import { hasOlder, lastSeq, mergeMessages, newClientMessageId, pendingMessage, unreadCount } from './state';

const server = (seq: number, overrides: Partial<VisitorMessage> = {}): VisitorMessage => ({
  id: `msg_${seq}`,
  conversationId: 'conv',
  seq,
  clientMessageId: null,
  sender: { type: 'member', displayName: null },
  type: 'text',
  content: `m${seq}`,
  attachments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('mergeMessages', () => {
  it('keeps one copy, however many paths bring a message', () => {
    const once = mergeMessages([], [server(1), server(2)]);
    expect(mergeMessages(once, [server(2), server(1)]).map((m) => m.seq)).toEqual([1, 2]);
  });

  it('turns a pending message into the committed one, in the same row', () => {
    const pending = pendingMessage('client-1', 'hello');
    const merged = mergeMessages([pending], [server(1, { clientMessageId: 'client-1', sender: { type: 'visitor', displayName: null }, content: 'hello' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: 'client-1', seq: 1, status: 'sent', mine: true });
  });

  it('puts what is still sending after everything committed, and older pages first', () => {
    const merged = mergeMessages([pendingMessage('client-1', 'later'), ...mergeMessages([], [server(5)])], [server(4), server(6)]);
    expect(merged.map((m) => m.seq)).toEqual([4, 5, 6, null]);
    expect(lastSeq(merged)).toBe(6);
  });
});

describe('counters', () => {
  it('counts only what others wrote since the read position', () => {
    const messages = mergeMessages([], [server(1), server(2, { sender: { type: 'visitor', displayName: null } }), server(3)]);
    expect(unreadCount(messages, 0)).toBe(2);
    expect(unreadCount(messages, 1)).toBe(1);
    expect(unreadCount(messages, 3)).toBe(0);
  });

  it('knows from the gapless sequence whether anything is older', () => {
    expect(hasOlder([])).toBe(false);
    expect(hasOlder(mergeMessages([], [server(1)]))).toBe(false);
    expect(hasOlder(mergeMessages([], [server(2)]))).toBe(true);
  });
});

describe('newClientMessageId', () => {
  it('works where randomUUID does not exist, and is long enough for the API', () => {
    const id = newClientMessageId({ getRandomValues: <T extends ArrayBufferView | null>(array: T) => array });
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
