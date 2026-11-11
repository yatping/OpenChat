/**
 * After a commit: tell the Durable Objects. Fast from waitUntil, and swept by cron if the isolate dies, so
 * everything here may run twice. Sockets are a hint: a lost publish costs a client some catch-up through REST,
 * and never loses a message. See docs/architecture/background-jobs.md.
 */
import { toMessage } from '@openchat/core';
import {
  conversationForDispatch,
  deleteUnclaimedAttachment,
  staleAttachments,
  markOutboxDispatched,
  messageForDispatch,
  openDatabase,
  pendingOutboxFor,
  purgeDispatchedOutbox,
  recordOutboxFailure,
  staleOutbox,
  type Database,
  type OutboxRow,
} from '@openchat/database';
import { hubName, roomName, type DomainEvent } from '@openchat/realtime';
import { createLogger, toIso } from '@openchat/shared';
import type { Context } from 'hono';
import type { AppEnv } from './context';
import type { Env } from './env';
import { sweepFollowUps } from './email/follow-ups';
import { pushJobsFor } from './push/fanout';

const SWEEP_AGE_MS = 60_000;
const SWEEP_LIMIT = 200;
const PURGE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PURGE_LIMIT = 1000;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_LIMIT = 200;

async function conversationEvent(db: Database, row: OutboxRow, kind: 'conversation.created' | 'conversation.updated'): Promise<DomainEvent | null> {
  const c = await conversationForDispatch(db, row.workspaceId, row.aggregateId);
  if (!c) return null;
  return {
    v: 1,
    kind,
    workspaceId: row.workspaceId,
    conversation: {
      id: c.id,
      version: c.version,
      status: c.status,
      priority: c.priority,
      assignedMemberId: c.assignedMemberId,
      lastMessageSeq: c.lastMessageSeq,
      ...(c.lastMessageAt === null ? {} : { lastMessageAt: toIso(c.lastMessageAt) }),
      tags: JSON.parse(c.tagsJson) as { id: string; name: string }[],
      updatedAt: toIso(c.updatedAt),
    },
  };
}

async function dispatchRow(env: Env, db: Database, row: OutboxRow): Promise<void> {
  const hub = env.WORKSPACE_HUB.getByName(hubName(row.workspaceId));
  switch (row.topic) {
    case 'message.created': {
      const message = await messageForDispatch(db, row.workspaceId, row.aggregateId);
      // Gone since, such as by erasure. Nothing is left to announce.
      if (!message) return;
      const event: DomainEvent = {
        v: 1,
        kind: 'message.created',
        workspaceId: row.workspaceId,
        message: toMessage(message),
        ...(message.conversationVersion === null ? {} : { conversationVersion: message.conversationVersion }),
      };
      const room = env.CONVERSATION_ROOM.getByName(roomName(row.workspaceId, message.conversationId));
      await Promise.all([hub.publish(event), room.publishDomainEvent(event, { showAgentNames: message.showAgentNames })]);
      await pushJobsFor(env, row);
      return;
    }
    case 'conversation.created':
    case 'conversation.updated': {
      const event = await conversationEvent(db, row, row.topic);
      if (!event) return;
      const room = env.CONVERSATION_ROOM.getByName(roomName(row.workspaceId, row.aggregateId));
      await Promise.all([hub.publish(event), room.publishDomainEvent(event)]);
      await pushJobsFor(env, row);
      return;
    }
    case 'member.access_changed':
      // The member reconnects with fresh permissions, or fails to.
      await hub.revokeMember(row.aggregateId);
      await pushJobsFor(env, row);
      return;
    case 'push.subscription_removed':
      await pushJobsFor(env, row);
      return;
    case 'contact.erased':
      // The rows went with the erasure. Their files are named under each conversation, so a repeat finds fewer.
      for (const conversationId of (JSON.parse(row.payloadJson) as { conversationIds: string[] }).conversationIds) {
        await deleteStoredFiles(env, `w/${row.workspaceId}/c/${conversationId}/`);
      }
      return;
    default:
      // A newer Worker's row, read by an older one during a deploy. It stays for a Worker that knows it.
      throw new Error('Unknown outbox topic');
  }
}

async function dispatchRows(env: Env, db: Database, rows: OutboxRow[]): Promise<void> {
  for (const row of rows) {
    try {
      await dispatchRow(env, db, row);
      await markOutboxDispatched(db, row.id);
    } catch (error) {
      createLogger({ workspaceId: row.workspaceId }).warn('outbox_dispatch_failed', { errorName: (error as Error).name });
      await recordOutboxFailure(db, row.id).catch(() => undefined);
    }
  }
}

/** Finds rows by the ID of what was written, so that a replay also finishes a dispatch that died. */
export function dispatchSoon(c: Context<AppEnv>, workspaceId: string, aggregateIds: string[]): void {
  const db = openDatabase(c.env.DB);
  c.executionCtx.waitUntil(
    pendingOutboxFor(db, workspaceId, aggregateIds)
      .then((rows) => dispatchRows(c.env, db, rows))
      .catch((error: unknown) => createLogger({ workspaceId }).warn('outbox_dispatch_failed', { errorName: (error as Error).name })),
  );
}

/**
 * A read position is a hint with no outbox row: it is already in D1, a later read supersedes it, and a client
 * that misses one gets the position again from REST when it catches up.
 */
export function publishRead(c: Context<AppEnv>, event: Extract<DomainEvent, { kind: 'conversation.read' }>): void {
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.WORKSPACE_HUB.getByName(hubName(event.workspaceId)).publish(event),
      ...(event.reader.type === 'member' ? [c.env.CONVERSATION_ROOM.getByName(roomName(event.workspaceId, event.conversationId)).publishDomainEvent(event)] : []),
    ]).catch((error: unknown) => createLogger({ workspaceId: event.workspaceId }).warn('read_publish_failed', { errorName: (error as Error).name })),
  );
}

/** R2 lists at most 1,000 keys at a time, and deletes as many in one call. */
async function deleteStoredFiles(env: Env, prefix: string): Promise<void> {
  for (;;) {
    const listed = await env.ATTACHMENTS.list({ prefix, limit: 1000 });
    if (listed.objects.length === 0) return;
    await env.ATTACHMENTS.delete(listed.objects.map((object) => object.key));
    if (!listed.truncated) return;
  }
}

/** Storage first: if the row went first and this died, nothing would ever find the file again. */
async function sweepAttachments(env: Env, db: Database): Promise<void> {
  for (const file of await staleAttachments(db, ORPHAN_AGE_MS, ORPHAN_LIMIT)) {
    await env.ATTACHMENTS.delete(file.storageKey);
    await deleteUnclaimedAttachment(db, file.id);
  }
}

export async function sweepOutbox(env: Env, scheduledTime: number): Promise<void> {
  const db = openDatabase(env.DB);
  await dispatchRows(env, db, await staleOutbox(db, SWEEP_AGE_MS, SWEEP_LIMIT));
  await sweepFollowUps(env, db);
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    await purgeDispatchedOutbox(db, PURGE_AGE_MS, PURGE_LIMIT);
    await sweepAttachments(env, db);
  }
}

export function socketUrl(c: Context<AppEnv>, ticket: string): string {
  const url = new URL(c.req.url);
  return `${url.protocol === 'http:' ? 'ws:' : 'wss:'}//${url.host}/api/v1/realtime/connect?ticket=${encodeURIComponent(ticket)}`;
}
