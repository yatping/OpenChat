/**
 * From a committed event to the relay, in two queue jobs, so that a relay that is down costs a retry and nothing else.
 * Every step may run twice: the relay drops a repeated notificationId. See docs/architecture/background-jobs.md.
 */
import {
  conversationAssignee,
  deleteMemberSubscriptions,
  getInstallation,
  memberStillReachable,
  messageForDispatch,
  openDatabase,
  pushRecipients,
  relayRegistration,
  type OutboxRow,
} from '@openchat/database';
import { toBase64Url, type NotificationEvent, type NotificationRequest } from '@openchat/notification-protocol';
import { newId, type JobEnvelope } from '@openchat/shared';
import type { Env } from '../env';
import { relayConfig, relayRequest, sendNotifications, type RelayConfig } from './relay-client';

export const FANOUT_JOB = 'notification.fanout';
export const DISPATCH_JOB = 'notification.dispatch';
export const UNREGISTER_JOB = 'notification.unregister';

/** A push about something this old is noise. The inbox has it anyway. */
const PUSH_LIFETIME_MS = 60 * 60_000;
/** The relay takes up to 100. Fewer here means a retry repeats less, and a failure costs fewer people. */
const DISPATCH_CHUNK = 50;

type FanoutPayload = { kind: 'message'; messageId: string } | { kind: 'assigned'; conversationId: string; memberId: string; actorId: string | null; eventId: string };
type DispatchPayload = { notifications: NotificationRequest[] };
type UnregisterPayload = { relaySubscriptionId: string } | { memberId: string };

function envelope<T>(type: string, idempotencyKey: string, workspaceId: string, payload: T, notAfter?: string): JobEnvelope<T> {
  return { v: 1, type, id: newId('job'), idempotencyKey, workspaceId, occurredAt: new Date().toISOString(), ...(notAfter ? { notAfter } : {}), payload };
}

/** Called from dispatch, for rows of any topic. Without a relay, nothing is queued. */
export async function pushJobsFor(env: Env, row: OutboxRow): Promise<void> {
  if (!relayConfig(env)) return;
  const send = (type: string, payload: FanoutPayload | UnregisterPayload, notAfter?: string) => env.NOTIFICATIONS_QUEUE.send(envelope(type, `${type}:${row.id}`, row.workspaceId, payload, notAfter));
  const notAfter = new Date(Date.now() + PUSH_LIFETIME_MS).toISOString();
  switch (row.topic) {
    case 'message.created':
      await send(FANOUT_JOB, { kind: 'message', messageId: row.aggregateId }, notAfter);
      return;
    case 'conversation.updated': {
      const { assignedTo, actorId } = JSON.parse(row.payloadJson) as { assignedTo?: string | null; actorId?: string | null };
      if (assignedTo) await send(FANOUT_JOB, { kind: 'assigned', conversationId: row.aggregateId, memberId: assignedTo, actorId: actorId ?? null, eventId: row.id }, notAfter);
      return;
    }
    case 'member.access_changed':
      await send(UNREGISTER_JOB, { memberId: row.aggregateId });
      return;
    case 'push.subscription_removed':
      await send(UNREGISTER_JOB, { relaySubscriptionId: (JSON.parse(row.payloadJson) as { relaySubscriptionId: string }).relaySubscriptionId });
      return;
  }
}

/** Stable across retries and repeated dispatch, and one per person, as the relay requires. */
async function notificationIdFor(eventId: string, event: string, memberId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}\n${event}\n${memberId}`));
  return `ntf_${toBase64Url(new Uint8Array(digest).slice(0, 18))}`;
}

/**
 * Decided from what is true now. A visitor's message goes to whoever has the conversation, or to everyone if nobody
 * does. A colleague's reply or note goes only to the person who has it. A system message goes to nobody.
 */
async function decide(env: Env, workspaceId: string, payload: FanoutPayload): Promise<{ event: NotificationEvent; eventId: string; conversationId: string; onlyMemberId: string | null; exceptMemberId: string | null } | null> {
  const db = openDatabase(env.DB);
  if (payload.kind === 'assigned') {
    const current = await conversationAssignee(db, workspaceId, payload.conversationId);
    if (current?.assignedMemberId !== payload.memberId || payload.actorId === payload.memberId) return null;
    return { event: 'conversation_assigned', eventId: payload.eventId, conversationId: payload.conversationId, onlyMemberId: payload.memberId, exceptMemberId: null };
  }
  const message = await messageForDispatch(db, workspaceId, payload.messageId);
  if (!message) return null;
  const conversation = await conversationAssignee(db, workspaceId, message.conversationId);
  if (!conversation) return null;
  const base = { eventId: message.id, conversationId: message.conversationId, onlyMemberId: conversation.assignedMemberId };
  if (message.senderType === 'visitor') return { ...base, event: message.seq === 1 ? 'new_conversation' : 'new_message', exceptMemberId: null };
  if (message.senderType !== 'member' || !conversation.assignedMemberId) return null;
  return { ...base, event: 'new_message', exceptMemberId: message.senderId };
}

async function handleFanout(job: JobEnvelope, env: Env): Promise<void> {
  const workspaceId = job.workspaceId!;
  const decision = await decide(env, workspaceId, job.payload as FanoutPayload);
  if (!decision) return;
  const recipients = await pushRecipients(openDatabase(env.DB), { workspaceId, eventType: decision.event, onlyMemberId: decision.onlyMemberId, exceptMemberId: decision.exceptMemberId });
  const notifications: NotificationRequest[] = await Promise.all(
    recipients.map(async (recipientId) => ({
      workspaceId,
      event: decision.event,
      recipientId,
      conversationId: decision.conversationId,
      notificationId: await notificationIdFor(decision.eventId, decision.event, recipientId),
      ...(job.notAfter ? { expiresAt: job.notAfter } : {}),
    })),
  );
  const jobs: { body: JobEnvelope<DispatchPayload> }[] = [];
  for (let i = 0; i < notifications.length; i += DISPATCH_CHUNK) {
    jobs.push({ body: envelope(DISPATCH_JOB, `${job.idempotencyKey}:${i}`, workspaceId, { notifications: notifications.slice(i, i + DISPATCH_CHUNK) }, job.notAfter) });
  }
  // Queues takes at most 100 messages in a batch, and that is 5,000 people in one workspace.
  for (let i = 0; i < jobs.length; i += 100) await env.NOTIFICATIONS_QUEUE.sendBatch(jobs.slice(i, i + 100));
}

async function handleDispatch(job: JobEnvelope, env: Env, relay: RelayConfig): Promise<void> {
  await sendNotifications(openDatabase(env.DB), relay, job.workspaceId!, (job.payload as DispatchPayload).notifications);
}

/** The local rows go first. If the relay is down, nothing more goes out from here, and the retry finishes the job. */
async function handleUnregister(job: JobEnvelope, env: Env, relay: RelayConfig): Promise<void> {
  const db = openDatabase(env.DB);
  const workspaceId = job.workspaceId!;
  const payload = job.payload as UnregisterPayload;
  let body: { subscriptionId: string } | { workspaceId: string; recipientId: string };
  if ('memberId' in payload) {
    if (await memberStillReachable(db, workspaceId, payload.memberId)) return;
    await deleteMemberSubscriptions(db, workspaceId, payload.memberId);
    body = { workspaceId, recipientId: payload.memberId };
  } else {
    body = { subscriptionId: payload.relaySubscriptionId };
  }
  // A relay that never heard of this installation has nothing to remove.
  const known = await relayRegistration(db, workspaceId);
  if (known?.installationRelayId !== relay.id) return;
  const installation = await getInstallation(db);
  await relayRequest(relay, installation!.id, '/v1/devices/unregister', body);
}

function withRelay(handler: (job: JobEnvelope, env: Env, relay: RelayConfig) => Promise<void>) {
  return async (job: JobEnvelope, env: Env) => {
    const relay = relayConfig(env);
    // Queued before the relay was taken out of the configuration. Nothing can be done with it now.
    if (relay) await handler(job, env, relay);
  };
}

export const NOTIFICATION_HANDLERS = {
  [FANOUT_JOB]: handleFanout,
  [DISPATCH_JOB]: withRelay(handleDispatch),
  [UNREGISTER_JOB]: withRelay(handleUnregister),
};
