/**
 * Streams files between a request and R2. See ADR-0008. R2 needs to know the length of a stream, so the declared
 * length is held to with a FixedLengthStream, and a body that disagrees fails rather than storing part of a file.
 */
import { ATTACHMENT_HEAD_BYTES, assertAttachmentContent, assertAttachmentLength, assertAttachmentName, attachmentHeaders, cleanAttachmentFilename, normalizeAttachmentType, type UploadInput, type UploadTarget } from '@openchat/core';
import type { AttachmentRow } from '@openchat/database';
import { AppError, notFound } from '@openchat/shared';
import type { Context } from 'hono';
import type { AppEnv } from './context';

async function readHead(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < ATTACHMENT_HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const head = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    head.set(chunk, at);
    at += chunk.length;
  }
  return head;
}

export async function receiveUpload(c: Context<AppEnv>, conversationId: string, filename: string, begin: (input: UploadInput) => Promise<UploadTarget>) {
  const contentType = normalizeAttachmentType(c.req.header('content-type'));
  const size = assertAttachmentLength(c.req.header('content-length'));
  const name = cleanAttachmentFilename(filename);
  assertAttachmentName(contentType, name);
  const body = c.req.raw.body;
  if (!body) throw new AppError(400, 'validation_failed', 'The file is empty');

  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const head = await readHead(reader);
  assertAttachmentContent(contentType, head);

  const target = await begin({ conversationId, filename: name, contentType, size });
  const fixed = new FixedLengthStream(size);
  const writer = fixed.writable.getWriter();
  const pump = (async () => {
    await writer.write(head);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  })();
  try {
    await Promise.all([c.env.ATTACHMENTS.put(target.storageKey, fixed.readable, { httpMetadata: { contentType } }), pump]);
  } catch {
    await writer.abort().catch(() => undefined);
    await target.abandon().catch(() => undefined);
    throw new AppError(400, 'upload_incomplete', 'The file did not arrive in full');
  }
  await target.finish();
  return { id: target.id, filename: name, contentType, size, status: 'ready' as const, url: target.url };
}

export async function sendFile(c: Context<AppEnv>, row: AttachmentRow) {
  const object = await c.env.ATTACHMENTS.get(row.storageKey);
  // Its row says it is ready, so this is a fault, but it looks the same as any other missing file.
  if (!object) throw notFound();
  return c.body(object.body, 200, attachmentHeaders(row));
}
