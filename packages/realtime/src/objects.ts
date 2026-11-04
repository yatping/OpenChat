/**
 * Durable Objects for realtime. They hold no business state: D1 is the record, and sockets are a hint.
 * Rules for this file are in docs/architecture/realtime.md, and lint forbids anything that would block
 * hibernation. Authentication is not here yet: Phase 0 exposes no public route to these objects, and
 * Milestone 1b adds verified tickets in front of them.
 */
import { CLOSE_CODES, REALTIME_PROTOCOL_VERSION, type VisitorEvent } from '@openchat/api-contracts';
import { DurableObject } from 'cloudflare:workers';
import { toVisitorEvent, type DomainEvent } from './visitor-events';

/** Survives hibernation with the socket. Limit: 16 KB. */
export interface SocketAttachment {
  kind: 'agent' | 'visitor';
  principalId: string;
  role: string | null;
  expiresAt: number;
  connectedAt: number;
  protocolVersion: number;
}

/** Set by the Worker after it verifies a ticket. Never trusted from a client request. */
export const CLAIMS_HEADER = 'x-openchat-verified-claims';

const HEARTBEAT_SECONDS = 30;
const MAX_FRAME_BYTES = 8 * 1024;

abstract class RealtimeObject<Env = unknown> extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime, without waking this object or billing duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  protected abstract tagsFor(claims: SocketAttachment): string[];

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const raw = request.headers.get(CLAIMS_HEADER);
    if (!raw) return new Response('Missing verified claims', { status: 401 });
    const claims = JSON.parse(raw) as SocketAttachment;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, this.tagsFor(claims));
    server.serializeAttachment(claims);
    server.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        data: {
          connectionId: crypto.randomUUID(),
          protocolVersion: REALTIME_PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
          authExpiresAt: new Date(claims.expiresAt).toISOString(),
        },
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends to every live socket, skipping and closing those whose authorisation has expired. */
  protected broadcast(frame: string, tag?: string): number {
    const now = Date.now();
    let sent = 0;
    for (const socket of this.ctx.getWebSockets(tag)) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.expiresAt <= now) {
        socket.close(CLOSE_CODES.authExpired, 'Authorisation expired');
        continue;
      }
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
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.expiresAt <= Date.now()) {
      socket.close(CLOSE_CODES.authExpired, 'Authorisation expired');
      return;
    }
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      socket.close(1009, 'Frame too large');
      return;
    }
    // Milestone 1b handles typing.set and auth.refresh. Unknown frames are ignored, per the protocol.
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    // With compatibility date 2026-04-07 or later the runtime completes the close handshake. Calling
    // close() remains safe, but is unnecessary.
    void socket;
    void code;
    void reason;
  }
}

export class WorkspaceHub extends RealtimeObject {
  protected tagsFor(claims: SocketAttachment): string[] {
    return [`member:${claims.principalId}`, ...(claims.role ? [`role:${claims.role}`] : [])];
  }

  /** RPC. New event kinds must be additive, because an old object can receive them during a deploy. */
  async publish(event: DomainEvent): Promise<number> {
    if (event.v !== 1) return 0;
    switch (event.kind) {
      case 'message.created':
        return this.broadcast(JSON.stringify({ v: 1, type: event.kind, data: { workspaceId: event.workspaceId, message: event.message } }));
      case 'conversation.created':
      case 'conversation.updated':
        return this.broadcast(JSON.stringify({ v: 1, type: event.kind, data: { workspaceId: event.workspaceId, conversation: event.conversation } }));
      case 'conversation.read':
        return this.broadcast(JSON.stringify({ v: 1, type: event.kind, data: { conversationId: event.conversationId, reader: event.reader, deliveredSeq: event.deliveredSeq, readSeq: event.readSeq } }));
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

  async connectionCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}

export class ConversationRoom extends RealtimeObject {
  protected tagsFor(claims: SocketAttachment): string[] {
    return [`visitor:${claims.principalId}`];
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

  async connectionCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}
