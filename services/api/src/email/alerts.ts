/**
 * Email alerts to members, in two queue jobs: who should hear of this, then one send per person. Everything is decided
 * again just before sending, and an outage here touches nothing else. See docs/architecture/background-jobs.md.
 */
import { alertEmail, type AlertKind } from '@openchat/core';
import {
  alertRecipient,
  claimEmailDelivery,
  clearUnansweredAlert,
  conversationForAlert,
  dueUnansweredConversations,
  emailRecipients,
  finishEmailDelivery,
  getInstallation,
  openDatabase,
  type AlertFacts,
  type Database,
  type OutboxRow,
} from '@openchat/database';
import { EmailSendError, type EmailProvider } from '@openchat/email';
import { createLogger, newId, type JobEnvelope } from '@openchat/shared';
import type { Env } from '../env';

export const ALERT_JOB = 'email.alert';
export const SEND_JOB = 'email.send';

const LIFETIME_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 200;

type AlertPayload = { kind: AlertKind; conversationId: string; eventId: string };
type SendPayload = AlertPayload & { memberId: string };

export const emailConfigured = (env: Env) => Boolean(env.EMAIL_PROVIDER);

function envelope<T>(type: string, idempotencyKey: string, workspaceId: string, payload: T, notAfter: string): JobEnvelope<T> {
  return { v: 1, type, id: newId('job'), idempotencyKey, workspaceId, occurredAt: new Date().toISOString(), notAfter, payload };
}

/** Called from dispatch. With no provider, nothing is queued, because nothing could be sent. */
export async function emailJobsFor(env: Env, row: OutboxRow): Promise<void> {
  if (!emailConfigured(env) || row.topic !== 'conversation.created') return;
  const payload: AlertPayload = { kind: 'new_conversation', conversationId: row.aggregateId, eventId: row.id };
  await env.EMAIL_QUEUE.send(envelope(ALERT_JOB, `${ALERT_JOB}:${row.id}`, row.workspaceId, payload, new Date(Date.now() + LIFETIME_MS).toISOString()));
}

/** Each visitor message that nobody has answered gets one look, however long it then waits. */
export async function sweepUnanswered(env: Env, db: Database): Promise<void> {
  for (const due of await dueUnansweredConversations(db, SWEEP_LIMIT)) {
    if (emailConfigured(env)) {
      const eventId = `unanswered:${due.id}:${due.lastMessageSeq}`;
      const payload: AlertPayload = { kind: 'conversation_unanswered', conversationId: due.id, eventId };
      await env.EMAIL_QUEUE.send(envelope(ALERT_JOB, `${ALERT_JOB}:${eventId}`, due.workspaceId, payload, new Date(Date.now() + LIFETIME_MS).toISOString()));
    }
    await clearUnansweredAlert(db, due.workspaceId, due.id, due.dueAt);
  }
}

function stillTrue(kind: AlertKind, facts: AlertFacts): boolean {
  if (kind === 'new_conversation') return true;
  return facts.status === 'open' && facts.lastVisitorMessageAt !== null && (facts.lastAgentMessageAt === null || facts.lastAgentMessageAt < facts.lastVisitorMessageAt);
}

async function handleAlert(job: JobEnvelope, env: Env): Promise<void> {
  const db = openDatabase(env.DB);
  const workspaceId = job.workspaceId!;
  const payload = job.payload as AlertPayload;
  const facts = await conversationForAlert(db, workspaceId, payload.conversationId);
  if (!facts || !stillTrue(payload.kind, facts)) return;
  // Waiting on someone in particular is theirs to answer. Anything else is for everyone who asked.
  const onlyMemberId = payload.kind === 'conversation_unanswered' ? facts.assignedMemberId : null;
  const members = await emailRecipients(db, { workspaceId, eventType: payload.kind, onlyMemberId });
  const jobs = members.map((memberId) => ({ body: envelope<SendPayload>(SEND_JOB, `${SEND_JOB}:${payload.eventId}:${memberId}`, workspaceId, { ...payload, memberId }, job.notAfter!) }));
  for (let i = 0; i < jobs.length; i += 100) await env.EMAIL_QUEUE.sendBatch(jobs.slice(i, i + 100));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function handleSend(job: JobEnvelope, env: Env, email: EmailProvider): Promise<void> {
  const db = openDatabase(env.DB);
  const workspaceId = job.workspaceId!;
  const payload = job.payload as SendPayload;
  const [facts, recipient, installation] = await Promise.all([conversationForAlert(db, workspaceId, payload.conversationId), alertRecipient(db, workspaceId, payload.memberId, payload.kind), getInstallation(db)]);
  if (!facts || !recipient || !installation || !stillTrue(payload.kind, facts)) return;
  const dedupeKey = `alert:${payload.eventId}:${payload.memberId}`;
  const claimed = await claimEmailDelivery(db, { workspaceId, dedupeKey, template: payload.kind, recipientHash: await sha256Hex(recipient.email.toLowerCase()) });
  if (!claimed) {
    createLogger({ workspaceId }).info('email_already_claimed', { jobId: job.id });
    return;
  }
  try {
    const message = alertEmail({ kind: payload.kind, workspaceName: facts.workspaceName, publicBaseUrl: installation.publicBaseUrl });
    const sent = await email.send({ to: recipient.email, from: { name: facts.workspaceName, email: env.SYSTEM_EMAIL_FROM ?? `no-reply@${new URL(installation.publicBaseUrl).hostname}` }, ...message, idempotencyKey: dedupeKey });
    await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'sent', providerMessageId: sent.messageId });
  } catch (error) {
    // Cloudflare keeps a list of its own, from bounces and complaints. Retrying could not change its answer.
    if (error instanceof EmailSendError && error.code === 'E_RECIPIENT_SUPPRESSED') {
      await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'suppressed' });
      return;
    }
    await finishEmailDelivery(db, { workspaceId, dedupeKey, status: 'failed' }).catch(() => undefined);
    throw error;
  }
}

export const EMAIL_ALERT_HANDLERS = {
  [ALERT_JOB]: (job: JobEnvelope, env: Env) => handleAlert(job, env),
  [SEND_JOB]: (job: JobEnvelope, env: Env, deps: { email: EmailProvider }) => handleSend(job, env, deps.email),
};
