/**
 * Queue consumers and cron. Phase 0 proves the pipeline end to end with one job. Rules are in
 * docs/architecture/background-jobs.md: acknowledge per message, classify errors, check notAfter.
 */
import { INVITATION_EMAIL_JOB, PASSWORD_RESET_JOB, sendInvitationEmail, sendPasswordResetEmail } from '@openchat/core';
import { claimJob, getInstallation, openDatabase, recordFailedJob } from '@openchat/database';
import { CloudflareEmailProvider, ConsoleEmailProvider, EmailSendError, ResendEmailProvider, type EmailProvider } from '@openchat/email';
import { AppError, createLogger, newId, retryDelaySeconds, type JobEnvelope } from '@openchat/shared';
import { sweepOutbox } from './dispatch';
import type { Env } from './env';

export const HEARTBEAT_JOB = 'system.heartbeat';

/** Fails closed: with no provider configured, jobs retry rather than dropping an email silently. */
function emailProviderFor(env: Env): EmailProvider {
  if (env.EMAIL_PROVIDER === 'console') return new ConsoleEmailProvider();
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY) return new ResendEmailProvider(env.RESEND_API_KEY);
  if (env.EMAIL_PROVIDER === 'cloudflare' && env.EMAIL) return new CloudflareEmailProvider(env.EMAIL);
  return { send: () => Promise.reject(new Error('No email provider is configured')) };
}

export function heartbeatJob(scheduledTime: number): JobEnvelope<Record<string, never>> {
  const minute = Math.floor(scheduledTime / 60_000);
  return {
    v: 1,
    type: HEARTBEAT_JOB,
    id: newId('job'),
    idempotencyKey: `heartbeat:${minute}`,
    workspaceId: null,
    occurredAt: new Date(scheduledTime).toISOString(),
    payload: {},
  };
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  // Each sweep is bounded, and overlapping runs are harmless. Automation arrives with follow-ups.
  await env.JOBS_QUEUE.send(heartbeatJob(controller.scheduledTime));
  await sweepOutbox(env, controller.scheduledTime);
}

export interface BackgroundDeps {
  email: EmailProvider;
}

async function systemEmailDeps(env: Env, deps: BackgroundDeps) {
  const db = openDatabase(env.DB);
  const installation = await getInstallation(db);
  if (!installation) throw new Error('Installation is not initialised');
  return {
    db,
    email: deps.email,
    publicBaseUrl: installation.publicBaseUrl,
    installationName: installation.name,
    fromEmail: env.SYSTEM_EMAIL_FROM ?? `no-reply@${new URL(installation.publicBaseUrl).hostname}`,
  };
}

type Handler = (job: JobEnvelope, env: Env, deps: BackgroundDeps) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  [HEARTBEAT_JOB]: async (job, env) => {
    await claimJob(openDatabase(env.DB), job.idempotencyKey, job.type);
  },
  [PASSWORD_RESET_JOB]: async (job, env, deps) => {
    await sendPasswordResetEmail(await systemEmailDeps(env, deps), (job.payload as { userId: string }).userId);
  },
  [INVITATION_EMAIL_JOB]: async (job, env, deps) => {
    await sendInvitationEmail(await systemEmailDeps(env, deps), { workspaceId: job.workspaceId ?? '', invitationId: (job.payload as { invitationId: string }).invitationId });
  },
};

const isDeadLetterQueue = (queue: string) => queue.endsWith('-dlq');

/** Errors that a retry cannot fix. Everything else is treated as transient. */
const isPermanent = (error: unknown) => error instanceof AppError && error.status >= 400 && error.status < 500;

function isEnvelope(body: unknown): body is JobEnvelope {
  const job = body as Partial<JobEnvelope> | null;
  return job?.v === 1 && typeof job.type === 'string' && typeof job.idempotencyKey === 'string';
}

export async function handleQueue(batch: MessageBatch, env: Env, deps: BackgroundDeps = { email: emailProviderFor(env) }): Promise<void> {
  const log = createLogger({ queue: batch.queue });
  const database = openDatabase(env.DB);

  for (const message of batch.messages) {
    const body: unknown = message.body;
    const job = isEnvelope(body) ? body : null;

    if (isDeadLetterQueue(batch.queue)) {
      // Written to D1 because a DLQ message lasts only as long as queue retention. IDs only, by the
      // envelope's rule that payloads never hold content.
      try {
        await recordFailedJob(database, {
          queue: batch.queue,
          jobType: job?.type ?? 'unknown',
          idempotencyKey: job?.idempotencyKey ?? message.id,
          workspaceId: job?.workspaceId ?? null,
          attempts: message.attempts,
          envelopeJson: job ? JSON.stringify(job) : '{}',
        });
        log.error('job_dead_lettered', { jobType: job?.type ?? 'unknown', attempts: message.attempts });
        message.ack();
      } catch (error) {
        log.error('dead_letter_record_failed', { errorName: (error as Error).name });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
      continue;
    }

    if (!job) {
      log.error('job_malformed', { jobId: message.id });
      message.ack();
      continue;
    }
    if (job.notAfter && Date.parse(job.notAfter) < Date.now()) {
      log.info('job_expired', { jobType: job.type, jobId: job.id });
      message.ack();
      continue;
    }
    const handler = HANDLERS[job.type];
    if (!handler) {
      // Possibly from a newer Worker during a deploy, so retry rather than discard.
      log.warn('job_unknown_type', { jobType: job.type, attempts: message.attempts });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    try {
      await handler(job, env, deps);
      message.ack();
    } catch (error) {
      if (isPermanent(error)) {
        log.error('job_failed_permanently', { jobType: job.type, jobId: job.id, errorName: (error as Error).name });
        await recordFailedJob(database, {
          queue: batch.queue,
          jobType: job.type,
          idempotencyKey: job.idempotencyKey,
          workspaceId: job.workspaceId,
          attempts: message.attempts,
          envelopeJson: JSON.stringify(job),
        });
        message.ack();
      } else {
        log.warn('job_retrying', {
          jobType: job.type,
          jobId: job.id,
          attempts: message.attempts,
          errorName: (error as Error).name,
          ...(error instanceof EmailSendError && error.status !== null ? { status: error.status } : {}),
          ...(error instanceof EmailSendError && error.code !== null ? { errorCode: error.code } : {}),
        });
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}
