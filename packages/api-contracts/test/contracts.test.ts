import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/document';
import { AgentServerFrameSchema, VisitorEventSchema, VisitorServerFrameSchema } from '../src/realtime';

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument();
  it('is OpenAPI 3.1', () => expect(doc.openapi).toBe('3.1.0'));
  it('publishes the routes', () => {
    expect(Object.keys(doc.paths ?? {})).toEqual(expect.arrayContaining(['/health', '/.well-known/openchat.json']));
  });
  it('publishes WebSocket frames from the same source', () => {
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['AgentServerFrame', 'AgentClientFrame', 'VisitorServerFrame', 'VisitorClientFrame', 'Problem']),
    );
  });
});

describe('frames', () => {
  const message = {
    id: 'm', conversationId: 'c', seq: 2, publicSeq: null, clientMessageId: null,
    sender: { type: 'member', id: 'mem', displayName: 'Ann' }, type: 'internal_note', visibility: 'internal',
    content: 'private', attachments: [], createdAt: 't', metadata: {},
  };

  it('accepts an internal note on the agent channel', () => {
    expect(AgentServerFrameSchema.safeParse({ v: 1, type: 'message.created', data: { workspaceId: 'w', message } }).success).toBe(true);
  });

  it('rejects an internal note on the visitor channel', () => {
    const frame = { v: 1, type: 'message.created', data: { message: { ...message, seq: 1 } } };
    expect(VisitorEventSchema.safeParse(frame).success).toBe(false);
    expect(VisitorServerFrameSchema.safeParse(frame).success).toBe(false);
  });

  it('strips agent-only fields from a visitor message', () => {
    const parsed = VisitorEventSchema.parse({
      v: 1, type: 'message.created',
      data: { message: { ...message, seq: 1, type: 'text', sender: { type: 'member', id: 'mem_secret', displayName: 'Ann' } } },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/mem_secret|visibility|publicSeq|metadata/);
  });
});
