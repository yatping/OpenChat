/**
 * Domain modules arrive from Milestone 1a. For now this package defines the ports through which domain
 * code talks to the platform. See docs/architecture/monorepo.md.
 */
import type { JobEnvelope } from '@openchat/shared';

export interface JobQueue {
  send(job: JobEnvelope): Promise<void>;
  /** Implementations chunk to the platform limit of 100 messages or 256 KB. */
  sendBatch(jobs: JobEnvelope[]): Promise<void>;
}

export interface BlobMeta {
  contentType: string;
  filename: string;
}
export interface BlobResult {
  body: ReadableStream;
  meta: BlobMeta;
  size: number;
}
export interface BlobStore {
  put(key: string, body: ReadableStream, meta: BlobMeta): Promise<void>;
  get(key: string): Promise<BlobResult | null>;
  delete(key: string): Promise<void>;
}

export * from './auth-flows';
export * from './workspaces';
export * from './admin';
export * from './messaging';
export * from './widget';
export * from './attachments';
