/** Rules for files in the app. Kept free of native imports, so that they can be tested. */

/** The installation refuses anything larger. Checking first saves uploading it to find out. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Larger pictures are opened on request, so that scrolling a thread cannot fetch hundreds of megabytes. */
export const PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024;

/** The same list as the installation's. SVG is absent on purpose: it can hold scripts. */
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXTENSIONS: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'text/plain': ['txt', 'log'],
  'text/csv': ['csv'],
};

/** What the document picker offers. The installation still decides. */
export const PICKABLE_TYPES = Object.keys(EXTENSIONS);

export const canPreview = (file: { contentType: string; size: number; status: string }) => file.status === 'ready' && PREVIEW_TYPES.has(file.contentType) && file.size <= PREVIEW_LIMIT_BYTES;

export const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/**
 * The name to store a downloaded file under. It comes from the installation, so it never gets to choose a path.
 * Returns one path segment.
 */
export function localFileName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  const clean = base.replace(/[\u0000-\u001f\u007f:]/g, '').replace(/^[.\s]+/, '').trim();
  if (clean.length === 0) return 'file';
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, 120 - extension.length) + extension;
}

/** One path segment for an attachment's folder, for the same reason. */
export const localFolderName = (attachmentId: string) => attachmentId.replace(/[^A-Za-z0-9_-]/g, '_') || 'file';

/**
 * The name to upload a picked file under. The installation requires the name to agree with the type, and the photo
 * library can hand over a JPEG still called IMG_1.HEIC, or no name at all.
 */
export function uploadFileName(name: string | null | undefined, contentType: string): string {
  const allowed = EXTENSIONS[contentType];
  const clean = localFileName(name ?? '');
  if (!allowed) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  if (allowed.includes(extension)) return clean;
  return `${dot > 0 ? clean.slice(0, dot) : clean}.${allowed[0]}`;
}

/** Deleting a picked file must never reach a person's own document, so only the app's scratch folders qualify. */
export const isPrivateCopy = (uri: string) => !uri.includes('..') && /\/Library\/Caches\/|\/tmp\//.test(uri);

/** A sentence for a failed upload, from the status the installation answered with. */
export function uploadProblem(status: number | undefined): string {
  if (status === 413) return 'That file is too large. The limit is 25 MB.';
  if (status === 415) return 'That type of file is not allowed.';
  if (status === 403) return 'You cannot add files to this conversation.';
  if (status === 429) return 'Too many files just now. Wait a moment and try again.';
  return 'That file did not upload. Please try again.';
}
