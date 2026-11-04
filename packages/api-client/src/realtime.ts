/**
 * The socket client for the dashboard and the widget. Sockets are a hint: everything here can fail, and the
 * client then falls back to REST. It imports nothing, so that it costs the widget only its own size.
 * Rules are in docs/architecture/realtime.md. Time and sockets are passed in, so that tests can drive them.
 */
export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling';

export interface ServerFrame {
  type: string;
  data: Record<string, unknown>;
}

interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  readyState: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

export interface RealtimeDeps {
  getTicket: () => Promise<{ ticket: string; url: string }>;
  openSocket: (url: string) => SocketLike;
  random?: () => number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface RealtimeHandlers {
  onStatus: (status: RealtimeStatus) => void;
  onFrame: (frame: ServerFrame) => void;
  /** After every (re)connection, because anything may have been missed. */
  onConnected: () => void;
  /** This member's access changed. Permissions must be read again. */
  onRevoked: () => void;
}

const OPEN = 1;
const MAX_BACKOFF_MS = 30_000;
const POLL_AFTER_FAILURES = 3;
const RATE_LIMITED_DELAY_MS = 30_000;
const REVOKED_DELAY_MS = 2000;
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export function createRealtime(deps: RealtimeDeps, handlers: RealtimeHandlers) {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let stopped = true;
  let socket: SocketLike | null = null;
  let failures = 0;
  let generation = 0;
  let connected = false;
  let lastHeard = 0;
  let timers: unknown[] = [];

  const clearTimers = () => {
    for (const timer of timers) clearTimer(timer);
    timers = [];
  };
  const later = (run: () => void, ms: number) => timers.push(setTimer(run, ms));

  function dropSocket() {
    generation++;
    clearTimers();
    connected = false;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    socket = null;
  }

  function retry(minimumDelay: number) {
    dropSocket();
    if (stopped) return;
    failures++;
    handlers.onStatus(failures >= POLL_AFTER_FAILURES ? 'polling' : 'reconnecting');
    // Full jitter, so that a deploy does not bring every client back at once.
    const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures);
    later(() => void connect(), minimumDelay + random() * ceiling);
  }

  function heartbeat(intervalMs: number, mine: number) {
    later(() => {
      if (mine !== generation || !socket) return;
      // A dead connection may never report a close.
      if (now() - lastHeard > intervalMs * 2.5) return retry(0);
      if (socket.readyState === OPEN) socket.send('ping');
      heartbeat(intervalMs, mine);
    }, intervalMs);
  }

  function refreshBefore(expiresAt: number, mine: number) {
    later(() => {
      deps
        .getTicket()
        .then(({ ticket }) => {
          if (mine === generation && socket?.readyState === OPEN) socket.send(JSON.stringify({ v: 1, type: 'auth.refresh', data: { ticket } }));
        })
        // The socket will end at its expiry, and the reconnect will report anything real.
        .catch(() => undefined);
    }, Math.max(0, expiresAt - now() - REFRESH_MARGIN_MS));
  }

  function onHello(data: Record<string, unknown>, mine: number) {
    const expiresAt = Date.parse(String(data.authExpiresAt));
    if (!Number.isNaN(expiresAt)) refreshBefore(expiresAt, mine);
    // A refresh answers with hello too, and nothing was missed then.
    if (connected) return;
    connected = true;
    failures = 0;
    const seconds = Number(data.heartbeatIntervalSeconds);
    heartbeat(seconds > 0 ? seconds * 1000 : DEFAULT_HEARTBEAT_MS, mine);
    handlers.onStatus('connected');
    handlers.onConnected();
  }

  async function connect() {
    dropSocket();
    if (stopped) return;
    const mine = generation;
    let ticket: { url: string };
    try {
      ticket = await deps.getTicket();
    } catch {
      if (mine === generation) retry(0);
      return;
    }
    if (stopped || mine !== generation) return;
    lastHeard = now();
    const opened = deps.openSocket(ticket.url);
    socket = opened;
    opened.onmessage = (event) => {
      lastHeard = now();
      if (event.data === 'pong' || typeof event.data !== 'string') return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'hello') onHello(frame.data, mine);
      else handlers.onFrame(frame);
    };
    opened.onclose = ({ code }) => {
      if (code === 4403) handlers.onRevoked();
      retry(code === 4429 ? RATE_LIMITED_DELAY_MS : code === 4403 ? REVOKED_DELAY_MS : 0);
    };
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      handlers.onStatus('connecting');
      void connect();
    },
    stop() {
      stopped = true;
      dropSocket();
    },
    /** Best effort. Anything that matters goes through REST. */
    send(type: string, data: unknown) {
      if (socket?.readyState === OPEN) socket.send(JSON.stringify({ v: 1, type, data }));
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
