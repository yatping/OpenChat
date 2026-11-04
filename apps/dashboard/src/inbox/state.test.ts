import type { Conversation, Message } from '@openchat/api-client';
import { describe, expect, it } from 'vitest';
import { applyPatch, hasGap, markReadInPages, matchesFilter, mergeMessages, patchPages, recordNewMessage, shouldSendTyping, unreadCount, type ConversationPages } from './state';

const message = (seq: number, content = `m${seq}`): Message => ({
  id: `msg_${seq}`,
  conversationId: 'conv_1',
  seq,
  publicSeq: seq,
  clientMessageId: null,
  sender: { type: 'visitor', id: null, displayName: null },
  type: 'text',
  visibility: 'public',
  content,
  attachments: [],
  createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
  metadata: {},
});

const conversation = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  websiteId: 'site',
  contactId: 'contact',
  assignedMemberId: null,
  status: 'open',
  priority: 'normal',
  subject: null,
  version: 5,
  lastMessageSeq: 3,
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  lastReadSeq: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const pagesOf = (...rows: Conversation[][]): ConversationPages => ({ pages: rows.map((data) => ({ data, nextCursor: null, syncCursor: 'c' })), pageParams: rows.map(() => null) });
const ids = (data: ConversationPages) => data.pages.map((page) => page.data.map((row) => row.id));

describe('messages', () => {
  it('converges whatever the order, and repeats nothing', () => {
    expect(mergeMessages([message(1), message(3)], [message(2), message(3), message(1)]).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('sees a gap only when a position was skipped', () => {
    expect(hasGap([message(1), message(2)], { seq: 3 })).toBe(false);
    expect(hasGap([message(1), message(2)], { seq: 4 })).toBe(true);
    expect(hasGap([message(1), message(2)], { seq: 2 })).toBe(false);
    expect(hasGap([], { seq: 9 })).toBe(false);
  });
});

describe('conversations', () => {
  it('ignores an older version and accepts the same one', () => {
    const row = conversation('a', { version: 5, status: 'open' });
    expect(applyPatch(row, { id: 'a', version: 4, status: 'resolved' }).status).toBe('open');
    expect(applyPatch(row, { id: 'a', version: 6, status: 'resolved' }).status).toBe('resolved');
    expect(applyPatch(row, { id: 'a', version: 5, priority: 'high' }).priority).toBe('high');
  });

  it('a patch with no assignee leaves the assignee alone, and null removes it', () => {
    const row = conversation('a', { assignedMemberId: 'mem_1' });
    expect(applyPatch(row, { id: 'a', version: 6 }).assignedMemberId).toBe('mem_1');
    expect(applyPatch(row, { id: 'a', version: 6, assignedMemberId: null }).assignedMemberId).toBeNull();
  });

  it('counts unread, never below zero', () => {
    expect(unreadCount({ lastMessageSeq: 5, lastReadSeq: 2 })).toBe(3);
    expect(unreadCount({ lastMessageSeq: 5, lastReadSeq: 9 })).toBe(0);
  });

  it('matches filters', () => {
    const row = { status: 'open' as const, assignedMemberId: 'mem_1' };
    expect(matchesFilter(row, { status: 'open' })).toBe(true);
    expect(matchesFilter(row, { status: 'resolved' })).toBe(false);
    expect(matchesFilter(row, { status: 'open', assignee: 'mem_1' })).toBe(true);
    expect(matchesFilter(row, { status: 'open', assignee: 'mem_2' })).toBe(false);
    expect(matchesFilter(row, { status: 'open', assignee: 'none' })).toBe(false);
    expect(matchesFilter({ status: 'open', assignedMemberId: null }, { status: 'open', assignee: 'none' })).toBe(true);
  });

  it('drops a row that no longer belongs in this view', () => {
    const { data, found } = patchPages(pagesOf([conversation('a'), conversation('b')]), { id: 'a', version: 6, status: 'resolved' }, { status: 'open' });
    expect(found).toBe(true);
    expect(ids(data)).toEqual([['b']]);
  });

  it('says when it does not hold the row', () => {
    expect(patchPages(pagesOf([conversation('b')]), { id: 'a', version: 6 }, { status: 'open' }).found).toBe(false);
  });

  it('moves a conversation with a new message to the top, and updates its position', () => {
    const pages = pagesOf([conversation('a', { lastMessageAt: '2026-01-02T00:00:00.000Z' }), conversation('b', { lastMessageAt: '2026-01-01T00:00:00.000Z' })]);
    const { data, found } = recordNewMessage(pages, { conversationId: 'b', seq: 4, createdAt: '2026-01-03T00:00:00.000Z' });
    expect(found).toBe(true);
    expect(ids(data)).toEqual([['b', 'a']]);
    expect(data.pages[0]!.data[0]!.lastMessageSeq).toBe(4);
  });

  it('ignores an older message arriving late', () => {
    const pages = pagesOf([conversation('a', { lastMessageSeq: 9 })]);
    expect(recordNewMessage(pages, { conversationId: 'a', seq: 4, createdAt: '2026-01-03T00:00:00.000Z' }).data.pages[0]!.data[0]!.lastMessageSeq).toBe(9);
  });

  it('keeps page sizes when sorting across pages', () => {
    const pages = pagesOf([conversation('a', { lastMessageAt: '2026-01-05T00:00:00.000Z' })], [conversation('b', { lastMessageAt: '2026-01-04T00:00:00.000Z' })]);
    expect(ids(recordNewMessage(pages, { conversationId: 'b', seq: 4, createdAt: '2026-01-06T00:00:00.000Z' }).data)).toEqual([['b'], ['a']]);
  });

  it('only moves a read position forward', () => {
    const pages = pagesOf([conversation('a', { lastReadSeq: 5 })]);
    expect(markReadInPages(pages, 'a', 3).pages[0]!.data[0]!.lastReadSeq).toBe(5);
    expect(markReadInPages(pages, 'a', 7).pages[0]!.data[0]!.lastReadSeq).toBe(7);
  });
});

describe('typing', () => {
  it('sends at most every three seconds', () => {
    expect(shouldSendTyping(1000, 3999)).toBe(false);
    expect(shouldSendTyping(1000, 4000)).toBe(true);
  });
});
