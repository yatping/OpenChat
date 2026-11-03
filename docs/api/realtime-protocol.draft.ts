/**
 * WebSocket frames: DESIGN DRAFT, shared by the Worker, dashboard, mobile app, and widget.
 *
 * Plain types so that this file compiles with no dependencies. In Phase 0 and Milestone 1 it becomes
 * Zod schemas in packages/api-contracts, published alongside the REST contract, with these types
 * inferred from them. See docs/api/conventions.md and docs/architecture/realtime.md.
 *
 * Rules
 * - Sockets never carry message sends. REST is the only write path.
 * - Any event can arrive more than once or out of order. Merge by id, seq, or version.
 * - Unknown frame types must be ignored, because clients and servers upgrade independently.
 * - The literal text frames "ping" and "pong" are outside this schema. The runtime answers them
 *   without waking the Durable Object.
 */

export const REALTIME_PROTOCOL_VERSION = 1 as const;

type Iso8601 = string;
type Envelope<T extends string, D> = { v: 1; type: T; data: D };

export type MessageType = 'text' | 'image' | 'file' | 'system' | 'internal_note';
export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'archived';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface AttachmentRef {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export interface WireMessage {
  id: string;
  conversationId: string;
  seq: number;
  /** Null for internal notes. */
  publicSeq: number | null;
  clientMessageId: string | null;
  sender: { type: 'visitor' | 'member' | 'system'; id: string | null; displayName: string | null };
  type: MessageType;
  visibility: 'public' | 'internal';
  content: string;
  attachments: AttachmentRef[];
  createdAt: Iso8601;
  metadata: Record<string, unknown>;
}

/** Not a subtype of WireMessage by design: no visibility, no member IDs, no internal_note type. */
export interface VisitorWireMessage {
  id: string;
  conversationId: string;
  /** The gapless public sequence, so that visitors cannot infer internal notes. */
  seq: number;
  clientMessageId: string | null;
  sender: { type: 'visitor' | 'member' | 'system'; displayName: string | null };
  type: Exclude<MessageType, 'internal_note'>;
  content: string;
  attachments: AttachmentRef[];
  createdAt: Iso8601;
}

export interface ConversationPatch {
  id: string;
  version: number;
  status?: ConversationStatus;
  priority?: ConversationPriority;
  assignedMemberId?: string | null;
  lastMessageSeq?: number;
  lastMessageAt?: Iso8601;
  updatedAt: Iso8601;
}

// ----- Frames common to all channels ------------------------------------------------------------

export type HelloFrame = Envelope<'hello', {
  connectionId: string;
  protocolVersion: number;
  serverTime: Iso8601;
  heartbeatIntervalSeconds: number;
  authExpiresAt: Iso8601;
}>;
/** Rerun REST catch-up, for example after the server shed events. */
export type SyncRequiredFrame = Envelope<'sync.required', { reason: 'overflow' | 'upgrade' | 'unknown' }>;
export type AuthExpiringFrame = Envelope<'auth.expiring', { expiresAt: Iso8601 }>;
export type ErrorFrame = Envelope<'error', { code: 'invalid_frame' | 'unsupported' | 'rate_limited' | 'forbidden'; requestId?: string }>;

export type AuthRefreshFrame = Envelope<'auth.refresh', { ticket: string }>;
/** Sent at most every 3 seconds while typing. Receivers expire the indicator after 5 seconds. */
export type TypingSetFrame = Envelope<'typing.set', { conversationId: string; isTyping: boolean }>;

// ----- Agent channel (WorkspaceHub) -------------------------------------------------------------

export type AgentServerFrame =
  | HelloFrame
  | SyncRequiredFrame
  | AuthExpiringFrame
  | ErrorFrame
  | Envelope<'message.created', { workspaceId: string; message: WireMessage }>
  | Envelope<'conversation.created', { workspaceId: string; conversation: ConversationPatch }>
  | Envelope<'conversation.updated', { workspaceId: string; conversation: ConversationPatch }>
  | Envelope<'conversation.read', {
      conversationId: string;
      reader: { type: 'visitor' | 'member'; id: string };
      deliveredSeq: number;
      readSeq: number;
    }>
  | Envelope<'typing', { conversationId: string; actor: { type: 'visitor' | 'member'; id: string; displayName: string | null } }>
  | Envelope<'presence.member', { memberId: string; online: boolean }>
  | Envelope<'presence.visitor', { conversationId: string; online: boolean }>;

export type AgentClientFrame = AuthRefreshFrame | TypingSetFrame;

// ----- Visitor channel (ConversationRoom) -------------------------------------------------------

export type VisitorServerFrame =
  | HelloFrame
  | SyncRequiredFrame
  | AuthExpiringFrame
  | ErrorFrame
  | Envelope<'message.created', { message: VisitorWireMessage }>
  | Envelope<'conversation.status', { conversationId: string; status: ConversationStatus }>
  | Envelope<'conversation.read', { conversationId: string; readSeq: number }>
  | Envelope<'typing', { conversationId: string; displayName: string | null }>
  | Envelope<'availability', { availability: 'online' | 'offline' }>;

export type VisitorClientFrame = AuthRefreshFrame | TypingSetFrame;

// ----- Internal RPC, Worker to Durable Object ----------------------------------------------------

/** Domain events the Worker publishes after commit. Additive only: old objects may receive new types. */
export type DomainEvent =
  | { v: 1; kind: 'message.created'; workspaceId: string; message: WireMessage }
  | { v: 1; kind: 'conversation.created'; workspaceId: string; conversation: ConversationPatch }
  | { v: 1; kind: 'conversation.updated'; workspaceId: string; conversation: ConversationPatch }
  | {
      v: 1;
      kind: 'conversation.read';
      workspaceId: string;
      conversationId: string;
      reader: { type: 'visitor' | 'member'; id: string };
      /** For a member reader these are in seq space. For a visitor reader, public_seq space. */
      deliveredSeq: number;
      readSeq: number;
      /**
       * For a member reader: the highest public_seq at or below readSeq, computed on the server.
       * This is the only read position a visitor may see, because readSeq would reveal internal notes.
       */
      publicReadSeq: number | null;
    };

/** All a ConversationRoom can publish. Produced only by toVisitorEvent. */
export type VisitorEvent = Exclude<VisitorServerFrame, HelloFrame | SyncRequiredFrame | AuthExpiringFrame | ErrorFrame>;

/**
 * The allowlist mapper. A new DomainEvent kind fails to compile here until someone decides what
 * visitors may see, and internal notes return null.
 */
export function toVisitorEvent(event: DomainEvent): VisitorEvent | null {
  switch (event.kind) {
    case 'message.created': {
      const { message } = event;
      if (message.visibility !== 'public' || message.type === 'internal_note' || message.publicSeq === null) return null;
      return {
        v: 1,
        type: 'message.created',
        data: {
          message: {
            id: message.id,
            conversationId: message.conversationId,
            seq: message.publicSeq,
            clientMessageId: message.clientMessageId,
            sender: { type: message.sender.type, displayName: message.sender.displayName },
            type: message.type,
            content: message.content,
            attachments: message.attachments,
            createdAt: message.createdAt,
          },
        },
      };
    }
    case 'conversation.updated':
      return event.conversation.status === undefined
        ? null
        : { v: 1, type: 'conversation.status', data: { conversationId: event.conversation.id, status: event.conversation.status } };
    case 'conversation.read':
      return event.reader.type === 'member' && event.publicReadSeq !== null
        ? { v: 1, type: 'conversation.read', data: { conversationId: event.conversationId, readSeq: event.publicReadSeq } }
        : null;
    case 'conversation.created':
      return null;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export interface WorkspaceHubRpc {
  publish(event: DomainEvent): Promise<void>;
  revokeMember(memberId: string): Promise<void>;
  typing(conversationId: string, actor: { type: 'visitor'; id: string; displayName: string | null }): Promise<void>;
  visitorPresence(conversationId: string, online: boolean): Promise<void>;
  availability(): Promise<'online' | 'offline'>;
}

export interface ConversationRoomRpc {
  publish(event: VisitorEvent): Promise<void>;
  closeVisitor(reason: 'revoked' | 'deleted'): Promise<void>;
}
