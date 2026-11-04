import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtime, type RealtimeStatus } from './realtime';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: number | undefined;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }
  hello(over: Record<string, unknown> = {}) {
    this.frame({ v: 1, type: 'hello', data: { heartbeatIntervalSeconds: 30, authExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), ...over } });
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let sockets: FakeSocket[];
let statuses: RealtimeStatus[];
let frames: unknown[];
let connected: number;
let revoked: number;
let getTicket: ReturnType<typeof vi.fn>;

const setup = (random = 0) => {
  const realtime = createRealtime(
    {
      getTicket: getTicket as never,
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => random,
    },
    {
      onStatus: (status) => statuses.push(status),
      onFrame: (frame) => frames.push(frame),
      onConnected: () => connected++,
      onRevoked: () => revoked++,
    },
  );
  return realtime;
};

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  statuses = [];
  frames = [];
  connected = 0;
  revoked = 0;
  getTicket = vi.fn(() => Promise.resolve({ ticket: 'ticket', url: 'wss://example.test/connect' }));
});

describe('connecting', () => {
  it('reports connected only on hello, and hands over other frames', async () => {
    setup().start();
    await settle();
    expect(statuses).toEqual(['connecting']);
    sockets[0]!.hello();
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(connected).toBe(1);
    sockets[0]!.frame({ v: 1, type: 'message.created', data: { id: 1 } });
    expect(frames).toEqual([{ v: 1, type: 'message.created', data: { id: 1 } }]);
  });

  it('ignores what it cannot read', async () => {
    setup().start();
    await settle();
    sockets[0]!.onmessage?.({ data: 'not json' });
    sockets[0]!.onmessage?.({ data: 'pong' });
    expect(frames).toEqual([]);
  });

  it('sends pings at the interval the server gave', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello({ heartbeatIntervalSeconds: 10 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets[0]!.sent).toEqual(['ping']);
  });
});

describe('reconnecting', () => {
  it('asks for a new ticket, and says that it is catching up', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello();
    sockets[0]!.serverClose(1006);
    expect(statuses.at(-1)).toBe('reconnecting');
    await settle();
    expect(getTicket).toHaveBeenCalledTimes(2);
    sockets[1]!.hello();
    expect(connected).toBe(2);
    expect(statuses.at(-1)).toBe('connected');
  });

  it('spreads clients out with full jitter, up to a ceiling', async () => {
    getTicket.mockRejectedValue(new Error('offline'));
    setup(1).start();
    await settle();
    expect(getTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(getTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(getTicket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000 + 16_000 + 30_000);
    expect(getTicket).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(getTicket).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(getTicket).toHaveBeenCalledTimes(7);
  });

  it('says that it is polling after three failures, and recovers from that', async () => {
    getTicket.mockRejectedValue(new Error('blocked'));
    setup().start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses.filter((s) => s === 'reconnecting').length).toBe(2);
    expect(statuses.at(-1)).toBe('polling');
    getTicket.mockResolvedValue({ ticket: 't', url: 'wss://example.test' });
    await vi.advanceTimersByTimeAsync(10);
    sockets[0]!.hello();
    expect(statuses.at(-1)).toBe('connected');
  });

  it('waits longer when told to slow down', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello();
    sockets[0]!.serverClose(4429);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sockets.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(2);
  });

  it('reports lost access, and tries again with fresh permissions', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello();
    sockets[0]!.serverClose(4403);
    expect(revoked).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getTicket).toHaveBeenCalledTimes(2);
  });

  it('gives up on a connection that has gone silent', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello({ heartbeatIntervalSeconds: 10 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.closedWith).toBe(1000);
    expect(statuses.at(-1)).toBe('reconnecting');
  });

  it('stays connected while pongs arrive', async () => {
    setup().start();
    await settle();
    sockets[0]!.hello({ heartbeatIntervalSeconds: 10 });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      sockets[0]!.onmessage?.({ data: 'pong' });
    }
    expect(sockets.length).toBe(1);
  });
});

describe('extending authorisation', () => {
  it('sends a new ticket a minute before expiry, without counting as a reconnection', async () => {
    const realtime = setup();
    realtime.start();
    await settle();
    sockets[0]!.hello({ authExpiresAt: new Date(Date.now() + 120_000).toISOString(), heartbeatIntervalSeconds: 1000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ v: 1, type: 'auth.refresh', data: { ticket: 'ticket' } });
    sockets[0]!.hello({ heartbeatIntervalSeconds: 1000 });
    expect(connected).toBe(1);
  });
});

describe('stopping', () => {
  it('closes the socket and never comes back', async () => {
    const realtime = setup();
    realtime.start();
    await settle();
    sockets[0]!.hello();
    realtime.stop();
    expect(sockets[0]!.closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(1);
  });

  it('does not open a socket for a ticket that arrives after stopping', async () => {
    const realtime = setup();
    realtime.start();
    realtime.stop();
    await settle();
    expect(sockets.length).toBe(0);
  });

  it('sends nothing when not connected', async () => {
    const realtime = setup();
    realtime.send('typing.set', {});
    realtime.start();
    await settle();
    sockets[0]!.hello();
    realtime.send('typing.set', { isTyping: true });
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ v: 1, type: 'typing.set', data: { isTyping: true } });
  });
});
