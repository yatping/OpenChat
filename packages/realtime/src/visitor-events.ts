import type { ConversationPatch, VisitorEvent, WireMessage } from '@openchat/api-contracts';

/** Domain events the Worker publishes after commit. Additive only: old objects may receive new kinds. */
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

/**
 * The allowlist from agent events to visitor events. A new DomainEvent kind fails to compile here
 * until someone decides what visitors may see. Fields are copied one by one, never spread, so a new
 * field on an agent type cannot leak by default.
 */
export function toVisitorEvent(event: DomainEvent, options: { showAgentNames?: boolean } = {}): VisitorEvent | null {
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
            clientMessageId: message.sender.type === 'visitor' ? message.clientMessageId : null,
            sender: { type: message.sender.type, displayName: message.sender.type === 'member' && !options.showAgentNames ? null : message.sender.displayName },
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

/** Rooms are named under their workspace, so that an ID from another tenant reaches an empty room. */
export const hubName = (workspaceId: string) => `workspace:${workspaceId}`;
export const roomName = (workspaceId: string, conversationId: string) => `conversation:${workspaceId}:${conversationId}`;
