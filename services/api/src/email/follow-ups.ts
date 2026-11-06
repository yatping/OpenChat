/**
 * Following up when a conversation goes quiet. Only the time since the last public message counts: nothing here hears
 * about browsers or sockets, so closing a tab decides nothing. See docs/architecture/background-jobs.md.
 */
import { followUpEmail, newUnsubscribeHeaders } from '@openchat/core';
import {
  claimFollowUpRun,
  clearFollowUpDue,
  conversationForFollowUp,
  dueFollowUpConversations,
  enabledFollowUpRules,
  followUpFactsForSend,
  getInstallation,
  openDatabase,
  scheduleFollowUpCheck,
  type Database,
} from '@openchat/database';
import type { EmailProvider } from '@openchat/email';
import { newId, type JobEnvelope } from '@openchat/shared';
import type { Env } from '../env';
import { deliverOnce, emailConfigured, systemFrom } from './alerts';

export const EVALUATE_JOB = 'automation.evaluate';
export const FOLLOW_UP_JOB = 'email.follow_up';

const LIFETIME_MS = 24 * 60 * 60_000;
const SWEEP_LIMIT = 200;

type FollowUpPayload = { ruleId: string; conversationId: string; triggerKey: string };

function envelope<T>(type: string, idempotencyKey: string, workspaceId: string, payload: T): JobEnvelope<T> {
  return { v: 1, type, id: newId('job'), idempotencyKey, workspaceId, occurredAt: new Date().toISOString(), notAfter: new Date(Date.now() + LIFETIME_MS).toISOString(), payload };
}

/** Clearing after queueing means a crash between them queues twice, which the claim below absorbs. */
export async function sweepFollowUps(env: Env, db: Database): Promise<void> {
  for (const due of await dueFollowUpConversations(db, SWEEP_LIMIT)) {
    if (emailConfigured(env)) await env.JOBS_QUEUE.send(envelope(EVALUATE_JOB, `${EVALUATE_JOB}:${due.id}:${due.dueAt}`, due.workspaceId, { conversationId: due.id }));
    await clearFollowUpDue(db, due.workspaceId, due.id, due.dueAt);
  }
}

async function handleEvaluate(job: JobEnvelope, env: Env): Promise<void> {
  const db = openDatabase(env.DB);
  const workspaceId = job.workspaceId!;
  const { conversationId } = job.payload as { conversationId: string };
  const conversation = await conversationForFollowUp(db, workspaceId, conversationId);
  if (!conversation || conversation.status !== 'open' || !conversation.lastPublicAt) return;
  const triggerKey = String(conversation.lastPublicSeq);
  const now = Date.now();
  let later: number | null = null;
  for (const rule of await enabledFollowUpRules(db, workspaceId)) {
    const dueAt = conversation.lastPublicAt + rule.inactiveMinutes * 60_000;
    if (dueAt > now) {
      later = later === null ? dueAt : Math.min(later, dueAt);
      continue;
    }
    const allowed = conversation.hasEmail === 1 && conversation.hasConsent === 1;
    const outcome = await claimFollowUpRun(db, { workspaceId, ruleId: rule.id, conversationId, triggerKey, outcome: allowed ? 'queued' : 'skipped_no_consent' });
    // Queued again on a repeat, in case a crash came before it. Sending checks that it happens once.
    if (outcome === 'queued') {
      const payload: FollowUpPayload = { ruleId: rule.id, conversationId, triggerKey };
      await env.EMAIL_QUEUE.send(envelope(FOLLOW_UP_JOB, `${FOLLOW_UP_JOB}:${rule.id}:${conversationId}:${triggerKey}`, workspaceId, payload));
    }
  }
  if (later !== null) await scheduleFollowUpCheck(db, { workspaceId, conversationId, lastPublicSeq: conversation.lastPublicSeq, at: later });
}

async function handleFollowUp(job: JobEnvelope, env: Env, email: EmailProvider): Promise<void> {
  const db = openDatabase(env.DB);
  const workspaceId = job.workspaceId!;
  const { ruleId, conversationId, triggerKey } = job.payload as FollowUpPayload;
  const [facts, installation] = await Promise.all([followUpFactsForSend(db, { workspaceId, conversationId, ruleId }), getInstallation(db)]);
  if (!facts || !installation) return;
  const stillQuiet = facts.status === 'open' && String(facts.lastPublicSeq) === triggerKey;
  if (!stillQuiet || facts.ruleEnabled !== 1 || !facts.email || facts.hasConsent !== 1 || facts.suppressed !== 0) return;
  const to = facts.email;
  const origins = JSON.parse(facts.originsJson) as string[];
  await deliverOnce(db, email, {
    workspaceId,
    dedupeKey: `follow_up:${ruleId}:${conversationId}:${triggerKey}`,
    template: 'follow_up',
    to,
    message: async () => {
      const { url, headers } = await newUnsubscribeHeaders(db, { workspaceId, email: to, publicBaseUrl: installation.publicBaseUrl });
      return { to, from: { name: facts.workspaceName, email: systemFrom(env, installation.publicBaseUrl) }, headers, ...followUpEmail({ workspaceName: facts.workspaceName, websiteUrl: origins[0] ?? null, unsubscribeUrl: url }) };
    },
  });
}

export const FOLLOW_UP_HANDLERS = {
  [EVALUATE_JOB]: (job: JobEnvelope, env: Env) => handleEvaluate(job, env),
  [FOLLOW_UP_JOB]: (job: JobEnvelope, env: Env, deps: { email: EmailProvider }) => handleFollowUp(job, env, deps.email),
};
