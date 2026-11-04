/**
 * What may be uploaded. The declared type and the first bytes must agree, so that nothing arrives as a picture
 * and turns out to be a page. HTML, SVG, XML, and scripts are not on the list in any form. See
 * docs/architecture/security.md#attachments.
 */
import { attachmentKey, repositories, visitorRepositories, type AttachmentJson, type AttachmentRow, type Database, type VisitorContext, type WorkspaceContext } from '@openchat/database';
import { AppError, newId, notFound } from '@openchat/shared';
import { enforce, limitKey, LIMITS, type AuthDeps } from './auth-flows';
import { requireCapability } from './workspaces';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Enough for any signature here, and for a text file to show what it really is. */
export const ATTACHMENT_HEAD_BYTES = 512;

const startsWith = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const ZIP = (head: Uint8Array) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]);

/** Plain text has no signature, so this refuses what a browser or a viewer might treat as something else. */
function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  const start = new TextDecoder().decode(head).replace(/^\uFEFF/, '').trimStart();
  return !start.startsWith('<');
}

const SIGNATURES: Record<string, (head: Uint8Array) => boolean> = {
  'image/png': (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  'image/gif': (head) => startsWith(head, ascii('GIF8')),
  'image/webp': (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  'application/pdf': (head) => startsWith(head, ascii('%PDF-')),
  'application/zip': ZIP,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP,
  'text/plain': looksLikeText,
  'text/csv': looksLikeText,
};

/** Shown in the browser when opened directly. Everything else is only ever a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const badType = () => new AppError(415, 'unsupported_attachment_type', 'This type of file is not allowed');

export function normalizeAttachmentType(header: string | undefined): string {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (!Object.hasOwn(SIGNATURES, type)) throw badType();
  return type;
}

export function assertAttachmentContent(contentType: string, head: Uint8Array): void {
  if (!SIGNATURES[contentType]?.(head)) throw badType();
}

export function assertAttachmentLength(header: string | undefined): number {
  const length = Number(header);
  if (header === undefined || !Number.isInteger(length)) throw new AppError(411, 'length_required', 'Send a Content-Length');
  if (length <= 0) throw new AppError(400, 'validation_failed', 'The file is empty');
  if (length > MAX_ATTACHMENT_BYTES) throw new AppError(413, 'attachment_too_large', 'The file is larger than 25 MB');
  return length;
}

/** No path, no control characters, and a length that fits. It is only ever shown as text or sent in a quoted header. */
export function cleanAttachmentFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- Removing them is the point.
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!base || base === '.' || base === '..') throw new AppError(400, 'validation_failed', 'The file needs a name');
  return base.slice(-255);
}

/** Safe whatever the content turns out to be. A sandbox and no sniffing mean that even a wrong answer above stays inert. */
export function attachmentHeaders(row: Pick<AttachmentRow, 'filename' | 'contentType' | 'size'>): Record<string, string> {
  const encoded = encodeURIComponent(row.filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'content-type': row.contentType,
    'content-length': String(row.size),
    'content-disposition': `${INLINE_TYPES.has(row.contentType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
  };
}

export const toAttachment = (file: AttachmentJson, url: string) => ({
  id: file.id,
  filename: file.filename,
  contentType: file.contentType,
  size: file.size,
  status: 'ready' as const,
  url,
});

export interface UploadInput {
  conversationId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface UploadTarget {
  id: string;
  storageKey: string;
  url: string;
  finish(): Promise<void>;
  abandon(): Promise<void>;
}

export async function beginAgentUpload(db: Database, ctx: WorkspaceContext, input: UploadInput): Promise<UploadTarget> {
  requireCapability(ctx, 'conversation.reply');
  const files = repositories(db, ctx).attachments;
  const id = newId('attachment');
  if (!(await files.begin({ ...input, id }))) throw notFound();
  return {
    id,
    storageKey: attachmentKey(ctx.workspaceId, input.conversationId, id),
    url: `/api/v1/workspaces/${ctx.workspaceId}/attachments/${id}`,
    finish: () => files.finish(id),
    abandon: () => files.abandon(id),
  };
}

export async function beginVisitorUpload(deps: Pick<AuthDeps, 'db' | 'limiter'>, ctx: VisitorContext, input: UploadInput): Promise<UploadTarget> {
  await enforce(deps.limiter, await limitKey('visitor-upload', ctx.visitorId), LIMITS.visitorUpload);
  await enforce(deps.limiter, await limitKey('website-uploads', ctx.websiteId), LIMITS.websiteVisitorUploads);
  const files = visitorRepositories(deps.db, ctx).attachments;
  const id = newId('attachment');
  if (!(await files.begin({ ...input, id }))) throw notFound();
  return {
    id,
    storageKey: attachmentKey(ctx.workspaceId, input.conversationId, id),
    url: `/api/v1/widget/attachments/${id}`,
    finish: () => files.finish(id),
    abandon: () => files.abandon(id),
  };
}

export async function agentAttachment(db: Database, ctx: WorkspaceContext, id: string): Promise<AttachmentRow> {
  const row = await repositories(db, ctx).attachments.get(id);
  if (!row) throw notFound();
  return row;
}

export async function visitorAttachment(deps: Pick<AuthDeps, 'db'>, ctx: VisitorContext, id: string): Promise<AttachmentRow> {
  const row = await visitorRepositories(deps.db, ctx).attachments.get(id);
  if (!row) throw notFound();
  return row;
}
