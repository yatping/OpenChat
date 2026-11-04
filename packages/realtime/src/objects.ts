/**
 * Durable Objects for realtime. They hold no business state: D1 is the record, and sockets are a hint.
 * Rules for this file are in docs/architecture/realtime.md, and lint forbids anything that would block
 * hibernation. The Worker verifies a ticket before anything reaches these objects, and they have no route of
 * their own. Attachments may predate a deploy, so every field added after the first version is optional.
 */
import { CLOSE_CODES, REALTIME_PROTOCOL_VERSION, type VisitorEvent } from '@openchat/api-contracts';
import { importVerificationKeys, verifyTicket, type SerializedKey } from '@openchat/auth';
import { DurableObject } from 'cloudflare:workers';
import { hubName, roomName, toVisitorEvent, type DomainEvent } from './visitor-events';

/** Survives hibernation with the socket. Limit: 16 KB. */
export interface SocketAttachment {
  kind: 'agent' | 'visitor';
  principalId: string;
  role: string | null;
  expiresAt: number;
  connectedAt: number;
  protocolVersion: number;
  workspaceId?: string;
  /** For a visitor, the one conversation this socket may watch. */
  conversationId?: string;
  issuer?: string;
  origin?: string;
  connectionId?: string;
  windowStart?: number;
  windowCount?: number;
  lastTypingAt?: number;
}

export interface RealtimeEnv {
  WORKSPACE_HUB: DurableObjectNamespace<WorkspaceHub>;
  CONVERSATION_ROOM: DurableObjectNamespace<ConversationRoom>;
  AUTH_SIGNING_KEY?: string;
}

/** Set by the Worker after it verifies a ticket. Never trusted from a client request. */
export const CLAIMS_HEADER = 'x-openchat-verified-claims';

const HEARTBEAT_SECONDS = 30;
const MAX_FRAME_BYTES = 8 * 1024;
const FRAME_WINDOW_MS = 10_000;
const MAX_FRAMES_PER_WINDOW = 20;
const TYPING_INTERVAL_MS = 2000;
/** Three missed heartbeats. A dead connection may never produce a close of its own. */
const STALE_AFTER_MS = 90_000;
/** Long enough that moving between pages does not look like leaving. */
const VISITOR_OFFLINE_DELAY_MS = 15_000;

const stringify = (type: string, data: unknown) => JSON.stringify({ v: 1, type, data });
const attachmentOf = (socket: WebSocket) => socket.deserializeAttachment() as SocketAttachment | null;
const isOpen = (socket: WebSocket) => socket.readyState === WebSocket.OPEN;

let keyCache: { source: string; keys: Awaited<ReturnType<typeof importVerificationKeys>> } | undefined;

/** Accepts the same secret as the Worker, including keys being retired. */
async function verificationKeys(secret: string) {
  if (keyCache?.source === secret) return keyCache.keys;
  const parsed = JSON.parse(secret) as { active: SerializedKey; retired?: Pick<SerializedKey, 'kid' | 'publicKey'>[] };
  const keys = await importVerificationKeys([parsed.active, ...(parsed.retired ?? [])]);
  keyCache = { source: secret, keys };
  return keys;
}

abstract class RealtimeObject extends DurableObject<RealtimeEnv> {
  /** How often the alarm looks for dead connections while any socket is here. */
  protected abstract readonly sweepMs: number;
  /** A ticket can be used more than once while it lasts, so this is what bounds one principal here. */
  protected readonly maxSocketsPerPrincipal: number = Number.POSITIVE_INFINITY;

  constructor(ctx: DurableObjectState, env: RealtimeEnv) {
    super(ctx, env);
    // Answered by the runtime, without waking this object or billing duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  protected abstract tagsFor(claims: SocketAttachment): string[];
  protected abstract principalTag(claims: SocketAttachment): string;
  protected abstract onTyping(socket: WebSocket, claims: SocketAttachment, conversationId: string, internal: boolean): Promise<void>;
  /** Called after the socket is open, and told whether this principal had no other. */
  protected abstract onConnected(socket: WebSocket, claims: SocketAttachment, first: boolean): Promise<void>;
  /** The principal's last socket has gone. */
  protected abstract onGone(claims: SocketAttachment): Promise<void>;
  protected onAlarm(): Promise<void> {
    return Promise.resolve();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const raw = request.headers.get(CLAIMS_HEADER);
    if (!raw) return new Response('Missing verified claims', { status: 401 });
    const claims = { ...(JSON.parse(raw) as SocketAttachment), connectionId: crypto.randomUUID() };

    const theirs = this.openSockets(this.principalTag(claims)).length;
    if (theirs >= this.maxSocketsPerPrincipal) return new Response('Too many connections', { status: 429 });
    const first = theirs === 0;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, this.tagsFor(claims));
    server.serializeAttachment(claims);
    server.send(this.helloFrame(claims));
    await this.scheduleSweep();
    await this.onConnected(server, claims, first).catch(() => undefined);
    return new Response(null, { status: 101, webSocket: client });
  }

  private helloFrame(claims: SocketAttachment): string {
    return stringify('hello', {
      connectionId: claims.connectionId,
      protocolVersion: REALTIME_PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
      authExpiresAt: new Date(claims.expiresAt).toISOString(),
    });
  }

  protected openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter(isOpen);
  }

  /** Sends to every live socket, skipping and closing those whose authorisation has expired. */
  protected broadcast(frame: string, tag?: string, exceptConnectionId?: string): number {
    const now = Date.now();
    let sent = 0;
    for (const socket of this.ctx.getWebSockets(tag)) {
      const attachment = attachmentOf(socket);
      if (!attachment || attachment.expiresAt <= now) {
        socket.close(CLOSE_CODES.authExpired, 'Authorisation expired');
        continue;
      }
      if (exceptConnectionId !== undefined && attachment.connectionId === exceptConnectionId) continue;
      try {
        socket.send(frame);
        sent++;
      } catch {
        // A socket that is closing. Its close handler deals with it, and the client recovers through REST.
      }
    }
    return sent;
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(socket);
    const now = Date.now();
    if (!attachment || attachment.expiresAt <= now) {
      socket.close(CLOSE_CODES.authExpired, 'Authorisation expired');
      return;
    }
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      socket.close(1009, 'Frame too large');
      return;
    }
    const inWindow = attachment.windowStart !== undefined && now - attachment.windowStart < FRAME_WINDOW_MS;
    attachment.windowStart = inWindow ? attachment.windowStart! : now;
    attachment.windowCount = (inWindow ? (attachment.windowCount ?? 0) : 0) + 1;
    if (attachment.windowCount > MAX_FRAMES_PER_WINDOW) {
      socket.close(CLOSE_CODES.rateLimited, 'Too many frames');
      return;
    }

    const frame = parseFrame(message);
    if (!frame) {
      socket.serializeAttachment(attachment);
      socket.send(stringify('error', { code: 'invalid_frame' }));
      return;
    }
    switch (frame.type) {
      case 'auth.refresh':
        await this.refreshAuth(socket, attachment, frame.data);
        break;
      case 'typing.set':
        await this.handleTyping(socket, attachment, frame.data, now);
        break;
      default:
        // Unknown frames are ignored, because clients and servers upgrade independently.
        socket.serializeAttachment(attachment);
    }
  }

  private async handleTyping(socket: WebSocket, attachment: SocketAttachment, data: Record<string, unknown>, now: number): Promise<void> {
    const { conversationId, isTyping, internal } = data;
    if (typeof conversationId !== 'string' || typeof isTyping !== 'boolean') {
      socket.serializeAttachment(attachment);
      socket.send(stringify('error', { code: 'invalid_frame' }));
      return;
    }
    // Receivers expire the indicator, so there is nothing to tell them when typing stops.
    if (!isTyping || (attachment.lastTypingAt !== undefined && now - attachment.lastTypingAt < TYPING_INTERVAL_MS)) {
      socket.serializeAttachment(attachment);
      return;
    }
    attachment.lastTypingAt = now;
    socket.serializeAttachment(attachment);
    await this.onTyping(socket, attachment, conversationId, internal === true).catch(() => undefined);
  }

  /** Extends a live socket with a new ticket, which must name exactly the same scope. */
  private async refreshAuth(socket: WebSocket, attachment: SocketAttachment, data: Record<string, unknown>): Promise<void> {
    const refused = () => {
      socket.serializeAttachment(attachment);
      socket.send(stringify('error', { code: 'forbidden' }));
    };
    const secret = this.env.AUTH_SIGNING_KEY;
    if (typeof data.ticket !== 'string' || !secret || !attachment.issuer) return refused();
    const verified = await verifyTicket(data.ticket, await verificationKeys(secret), attachment.issuer);
    if (!verified.ok) return refused();
    const c = verified.claims;
    if (c.kind !== attachment.kind || c.sub !== attachment.principalId || c.wid !== attachment.workspaceId || c.conv !== attachment.conversationId || c.org !== attachment.origin) return refused();
    attachment.expiresAt = c.until;
    socket.serializeAttachment(attachment);
    socket.send(this.helloFrame(attachment));
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    // Answer the close, or the client waits about 10 seconds and reports 1006. Measured on real Cloudflare, despite
    // the documented auto-reply. 1005 and 1006 only describe a close, and cannot be sent.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already complete.
    }
    await this.afterSocketGone(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.afterSocketGone(socket);
  }

  private async afterSocketGone(socket: WebSocket): Promise<void> {
    const attachment = attachmentOf(socket);
    if (!attachment) return;
    const others = this.ctx.getWebSockets(this.principalTag(attachment)).filter((s) => isOpen(s) && attachmentOf(s)?.connectionId !== attachment.connectionId);
    if (others.length === 0) await this.onGone(attachment).catch(() => undefined);
  }

  private async scheduleSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.sweepMs);
  }

  /** Runs only while there is something to do, so an empty object costs nothing. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.openSockets()) {
      const attachment = attachmentOf(socket);
      const lastSeen = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment?.connectedAt ?? 0;
      if (now - lastSeen <= STALE_AFTER_MS) continue;
      socket.close(1001, 'No heartbeat');
      // The other end may be gone, in which case no close event will ever come.
      if (attachment) await this.afterSocketGone(socket);
    }
    await this.onAlarm();
    if (this.openSockets().length > 0) await this.ctx.storage.setAlarm(now + this.sweepMs);
  }

  async connectionCount(): Promise<number> {
    return this.openSockets().length;
  }
}

function parseFrame(message: string | ArrayBuffer): { type: string; data: Record<string, unknown> } | null {
  if (typeof message !== 'string') return null;
  try {
    const parsed = JSON.parse(message) as { type?: unknown; data?: unknown } | null;
    if (typeof parsed?.type !== 'string' || typeof parsed.data !== 'object' || parsed.data === null) return null;
    return { type: parsed.type, data: parsed.data as Record<string, unknown> };
  } catch {
    return null;
  }
}

export class WorkspaceHub extends RealtimeObject {
  protected readonly sweepMs = 60_000;

  protected tagsFor(claims: SocketAttachment): string[] {
    return [`member:${claims.principalId}`, ...(claims.role ? [`role:${claims.role}`] : [])];
  }

  protected principalTag(claims: SocketAttachment): string {
    return `member:${claims.principalId}`;
  }

  /** RPC. New event kinds must be additive, because an old object can receive them during a deploy. */
  async publish(event: DomainEvent): Promise<number> {
    if (event.v !== 1) return 0;
    switch (event.kind) {
      case 'message.created':
        return this.broadcast(stringify(event.kind, { workspaceId: event.workspaceId, message: event.message, ...(event.conversationVersion === undefined ? {} : { conversationVersion: event.conversationVersion }) }));
      case 'conversation.created':
      case 'conversation.updated':
        return this.broadcast(stringify(event.kind, { workspaceId: event.workspaceId, conversation: event.conversation }));
      case 'conversation.read':
        return this.broadcast(stringify(event.kind, { conversationId: event.conversationId, reader: event.reader, deliveredSeq: event.deliveredSeq, readSeq: event.readSeq }));
      default:
        // An old object may receive a kind it does not know yet.
        return 0;
    }
  }

  async revokeMember(memberId: string): Promise<number> {
    const sockets = this.ctx.getWebSockets(`member:${memberId}`);
    for (const socket of sockets) socket.close(CLOSE_CODES.revoked, 'Access revoked');
    return sockets.length;
  }

  /** RPC from a room. Advisory, so losing one costs a stale dot and nothing else. */
  async visitorPresence(conversationId: string, online: boolean): Promise<void> {
    this.broadcast(stringify('presence.visitor', { conversationId, online }));
  }

  /** RPC from a room. */
  async visitorTyping(conversationId: string, visitorId: string): Promise<void> {
    this.broadcast(stringify('typing', { conversationId, actor: { type: 'visitor', id: visitorId, displayName: null } }));
  }

  protected async onTyping(socket: WebSocket, claims: SocketAttachment, conversationId: string, internal: boolean): Promise<void> {
    this.broadcast(stringify('typing', { conversationId, actor: { type: 'member', id: claims.principalId, displayName: null } }), undefined, claims.connectionId);
    // A note must not even look like a reply on its way.
    if (internal || !claims.workspaceId) return;
    const event: VisitorEvent = { v: 1, type: 'typing', data: { conversationId, displayName: null } };
    // The room is named under this workspace, so an ID from another tenant reaches an empty room.
    await this.env.CONVERSATION_ROOM.getByName(roomName(claims.workspaceId, conversationId)).publish(event);
  }

  protected async onConnected(socket: WebSocket, claims: SocketAttachment, first: boolean): Promise<void> {
    if (first) this.broadcast(stringify('presence.member', { memberId: claims.principalId, online: true }), undefined, claims.connectionId);
    // What the newcomer has missed. Bounded by the size of the team.
    const online = new Set(this.openSockets().map((s) => attachmentOf(s)?.principalId));
    online.delete(claims.principalId);
    for (const memberId of online) socket.send(stringify('presence.member', { memberId, online: true }));
  }

  protected async onGone(claims: SocketAttachment): Promise<void> {
    this.broadcast(stringify('presence.member', { memberId: claims.principalId, online: false }));
  }
}

interface RoomScope {
  workspaceId: string;
  conversationId: string;
}

const SCOPE_KEY = 'announced';

export class ConversationRoom extends RealtimeObject {
  protected readonly sweepMs = 5 * 60_000;
  /** One for each tab, and more tabs than anyone keeps open on one chat. Agents sign in, so the hub has no such limit. */
  protected override readonly maxSocketsPerPrincipal = 10;

  protected tagsFor(claims: SocketAttachment): string[] {
    return [`visitor:${claims.principalId}`];
  }

  protected principalTag(claims: SocketAttachment): string {
    return `visitor:${claims.principalId}`;
  }

  /** Accepts only VisitorEvent, so an internal note cannot be published here by construction. */
  async publish(event: VisitorEvent): Promise<number> {
    return this.broadcast(JSON.stringify(event));
  }

  /** The route from domain events to visitors. Everything goes through the allowlist mapper. */
  async publishDomainEvent(event: DomainEvent, options: { showAgentNames?: boolean } = {}): Promise<number> {
    const visitorEvent = toVisitorEvent(event, options);
    return visitorEvent ? this.publish(visitorEvent) : 0;
  }

  private hub(workspaceId: string) {
    return this.env.WORKSPACE_HUB.getByName(hubName(workspaceId));
  }

  protected async onTyping(socket: WebSocket, claims: SocketAttachment, conversationId: string): Promise<void> {
    if (!claims.workspaceId || conversationId !== claims.conversationId) {
      socket.send(stringify('error', { code: 'forbidden' }));
      return;
    }
    await this.hub(claims.workspaceId).visitorTyping(conversationId, claims.principalId);
  }

  protected async onConnected(_socket: WebSocket, claims: SocketAttachment): Promise<void> {
    if (!claims.workspaceId || !claims.conversationId) return;
    if (await this.ctx.storage.get<RoomScope>(SCOPE_KEY)) return;
    const scope: RoomScope = { workspaceId: claims.workspaceId, conversationId: claims.conversationId };
    await this.ctx.storage.put(SCOPE_KEY, scope);
    await this.hub(scope.workspaceId).visitorPresence(scope.conversationId, true);
  }

  /** Decided later, so that moving between pages does not flicker. */
  protected async onGone(): Promise<void> {
    if (this.openSockets().length === 0) await this.ctx.storage.setAlarm(Date.now() + VISITOR_OFFLINE_DELAY_MS);
  }

  protected override async onAlarm(): Promise<void> {
    if (this.openSockets().length > 0) return;
    const scope = await this.ctx.storage.get<RoomScope>(SCOPE_KEY);
    if (!scope) return;
    await this.hub(scope.workspaceId).visitorPresence(scope.conversationId, false);
    await this.ctx.storage.delete(SCOPE_KEY);
  }
}
