/**
 * WebSocket frames, shared by the Worker, dashboard, mobile app, and widget.
 *
 * - Sockets never carry message sends. REST is the only write path.
 * - Any event can arrive more than once or out of order. Merge by id, seq, or version.
 * - Clients must ignore unknown frame types, because clients and servers upgrade independently.
 * - The literal text frames "ping" and "pong" sit outside this schema. The runtime answers them
 *   without waking the Durable Object.
 */
import { z } from '@hono/zod-openapi';

export const REALTIME_PROTOCOL_VERSION = 1;

const frame = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ v: z.literal(1), type: z.literal(type), data });

const Iso = z.string();

export const MessageTypeSchema = z.enum(['text', 'image', 'file', 'system', 'internal_note']);
export const ConversationStatusSchema = z.enum(['open', 'pending', 'resolved', 'archived']);
export const ConversationPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const AttachmentRefSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  url: z.string(),
});

export const WireMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int(),
  /** Null for internal notes. */
  publicSeq: z.number().int().nullable(),
  clientMessageId: z.string().nullable(),
  sender: z.object({ type: z.enum(['visitor', 'member', 'system']), id: z.string().nullable(), displayName: z.string().nullable() }),
  type: MessageTypeSchema,
  visibility: z.enum(['public', 'internal']),
  content: z.string(),
  attachments: z.array(AttachmentRefSchema),
  createdAt: Iso,
  metadata: z.record(z.string(), z.unknown()),
});

/** Not a subtype of WireMessage by design: no visibility, no member IDs, no internal_note type. */
export const VisitorWireMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The gapless public sequence, so that visitors cannot infer internal notes. */
  seq: z.number().int(),
  clientMessageId: z.string().nullable(),
  sender: z.object({ type: z.enum(['visitor', 'member', 'system']), displayName: z.string().nullable() }),
  type: z.enum(['text', 'image', 'file', 'system']),
  content: z.string(),
  attachments: z.array(AttachmentRefSchema),
  createdAt: Iso,
});

export const ConversationPatchSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  status: ConversationStatusSchema.optional(),
  priority: ConversationPrioritySchema.optional(),
  assignedMemberId: z.string().nullable().optional(),
  lastMessageSeq: z.number().int().optional(),
  lastMessageAt: Iso.optional(),
  updatedAt: Iso,
});

const HelloFrame = frame(
  'hello',
  z.object({
    connectionId: z.string(),
    protocolVersion: z.number().int(),
    serverTime: Iso,
    heartbeatIntervalSeconds: z.number().int(),
    authExpiresAt: Iso,
  }),
);
const SyncRequiredFrame = frame('sync.required', z.object({ reason: z.enum(['overflow', 'upgrade', 'unknown']) }));
const AuthExpiringFrame = frame('auth.expiring', z.object({ expiresAt: Iso }));
const ErrorFrame = frame(
  'error',
  z.object({ code: z.enum(['invalid_frame', 'unsupported', 'rate_limited', 'forbidden']), requestId: z.string().optional() }),
);
const AuthRefreshFrame = frame('auth.refresh', z.object({ ticket: z.string() }));
/** Sent at most every 3 seconds while typing. Receivers expire the indicator after 5 seconds. Set `internal` while writing a note, which keeps it from visitors. */
const TypingSetFrame = frame('typing.set', z.object({ conversationId: z.string(), isTyping: z.boolean(), internal: z.boolean().optional() }));

const Reader = z.object({ type: z.enum(['visitor', 'member']), id: z.string() });

export const AgentServerFrameSchema = z
  .discriminatedUnion('type', [
    HelloFrame,
    SyncRequiredFrame,
    AuthExpiringFrame,
    ErrorFrame,
    frame('message.created', z.object({ workspaceId: z.string(), message: WireMessageSchema })),
    frame('conversation.created', z.object({ workspaceId: z.string(), conversation: ConversationPatchSchema })),
    frame('conversation.updated', z.object({ workspaceId: z.string(), conversation: ConversationPatchSchema })),
    frame('conversation.read', z.object({ conversationId: z.string(), reader: Reader, deliveredSeq: z.number().int(), readSeq: z.number().int() })),
    frame(
      'typing',
      z.object({ conversationId: z.string(), actor: z.object({ type: z.enum(['visitor', 'member']), id: z.string(), displayName: z.string().nullable() }) }),
    ),
    frame('presence.member', z.object({ memberId: z.string(), online: z.boolean() })),
    frame('presence.visitor', z.object({ conversationId: z.string(), online: z.boolean() })),
  ])
  .openapi('AgentServerFrame');

export const AgentClientFrameSchema = z.discriminatedUnion('type', [AuthRefreshFrame, TypingSetFrame]).openapi('AgentClientFrame');

export const VisitorEventSchema = z.discriminatedUnion('type', [
  frame('message.created', z.object({ message: VisitorWireMessageSchema })),
  frame('conversation.status', z.object({ conversationId: z.string(), status: ConversationStatusSchema })),
  frame('conversation.read', z.object({ conversationId: z.string(), readSeq: z.number().int() })),
  frame('typing', z.object({ conversationId: z.string(), displayName: z.string().nullable() })),
  frame('availability', z.object({ availability: z.enum(['online', 'offline']) })),
]);

export const VisitorServerFrameSchema = z
  .union([HelloFrame, SyncRequiredFrame, AuthExpiringFrame, ErrorFrame, VisitorEventSchema])
  .openapi('VisitorServerFrame');

export const VisitorClientFrameSchema = z.discriminatedUnion('type', [AuthRefreshFrame, TypingSetFrame]).openapi('VisitorClientFrame');

export type WireMessage = z.infer<typeof WireMessageSchema>;
export type VisitorWireMessage = z.infer<typeof VisitorWireMessageSchema>;
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>;
export type AgentServerFrame = z.infer<typeof AgentServerFrameSchema>;
export type AgentClientFrame = z.infer<typeof AgentClientFrameSchema>;
export type VisitorEvent = z.infer<typeof VisitorEventSchema>;
export type VisitorServerFrame = z.infer<typeof VisitorServerFrameSchema>;
export type VisitorClientFrame = z.infer<typeof VisitorClientFrameSchema>;

/** Close codes. See docs/api/conventions.md. */
export const CLOSE_CODES = {
  invalidFrame: 4400,
  authExpired: 4401,
  revoked: 4403,
  unsupportedProtocol: 4409,
  rateLimited: 4429,
} as const;
